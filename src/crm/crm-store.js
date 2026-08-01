/**
 * CrmStore — CRM core (Z4 subset): Contacts, Leads pipeline, Tasks, Audit.
 *
 * - Chạy trên cùng SQLite DB của context engine (schema v2, migrations.js).
 * - Idempotent: contact khoá unique theo (account_id, zalo_uid) — sync lại
 *   member không nhân đôi; mọi mutation ghi audit log.
 * - Validation tập trung ở đây để API/UI mỏng.
 */

import crypto from 'node:crypto';
import { birthdayDayMonth, daysUntilBirthday, normalizeGender, normalizePhone } from './zalo-people.js';

export const LEAD_STAGES = Object.freeze(['new', 'contacted', 'qualified', 'quoted', 'won', 'lost']);

const MAX_STR = 500;
const MAX_NOTES = 5000;

function s(v, max = MAX_STR) {
    if (v == null) return null;
    return String(v).slice(0, max);
}

function num(v, fallback = null) {
    if (v == null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

export class CrmStore {
    /** @param {import('node:sqlite').DatabaseSync} db DB đã chạy migrations v2 */
    constructor(db, opts = {}) {
        if (!db?.prepare) throw new Error('CrmStore cần SQLite DatabaseSync (Node >= 22.5)');
        this.db = db;
        this._now = opts.now || Date.now;
    }

    _audit(actor, action, target, detail) {
        try {
            this.db.prepare('INSERT INTO crm_audit_logs (id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
                .run(crypto.randomUUID(), s(actor) || 'system', action, s(target), s(detail, 1000), this._now());
        } catch { /* audit best-effort */ }
    }

    listAudit(limit = 50) {
        return this.db.prepare('SELECT * FROM crm_audit_logs ORDER BY at DESC LIMIT ?').all(limit);
    }

    // ── Contacts ─────────────────────────────────────────────────────────

    /**
     * Tạo/cập nhật contact. Nếu có zaloUid trùng (cùng account) → update,
     * không nhân đôi (idempotent cho sync member).
     */
    upsertContact(fields, actor = 'system') {
        const name = s(fields.displayName)?.trim();
        if (!name) throw new Error('displayName là bắt buộc');
        const now = this._now();
        const accountId = s(fields.accountId) || 'default';
        const zaloUid = s(fields.zaloUid) || null;

        let existing = null;
        if (fields.id) {
            existing = this.getContact(fields.id);
        } else if (zaloUid) {
            existing = this.db.prepare('SELECT * FROM contacts WHERE account_id = ? AND zalo_uid = ?')
                .get(accountId, zaloUid) || null;
        }

        // Sync lại từ Zalo KHÔNG được ghi đè trường đã có bằng chuỗi rỗng: hồ sơ Zalo chỉ lộ sđt/ngày
        // sinh với bot đã kết bạn, nên một lần sync từ bot khác sẽ trả về rỗng — ghi đè thì mất luôn
        // dữ liệu import được lần trước. Rỗng nghĩa là "lần này không biết", không phải "đã bị xoá".
        const keepIfBlank = (next, prev) => (next === undefined || next === null || next === '' ? prev : next);

        if (existing) {
            const merged = {
                display_name: name,
                avatar_url: fields.avatarUrl !== undefined ? s(fields.avatarUrl, 1000) : existing.avatar_url,
                phone: fields.phone !== undefined ? keepIfBlank(s(normalizePhone(fields.phone), 30), existing.phone) : existing.phone,
                friend_status: fields.friendStatus !== undefined ? s(fields.friendStatus, 20) : existing.friend_status,
                source: fields.source !== undefined ? s(fields.source) : existing.source,
                owner: fields.owner !== undefined ? s(fields.owner) : existing.owner,
                consent: fields.consent !== undefined ? s(fields.consent, 20) : existing.consent,
                notes: fields.notes !== undefined ? s(fields.notes, MAX_NOTES) : existing.notes,
                last_contact_at: fields.lastContactAt !== undefined ? num(fields.lastContactAt) : existing.last_contact_at,
                gender: fields.gender !== undefined ? keepIfBlank(normalizeGender(fields.gender), existing.gender) : existing.gender,
                birthday: fields.birthday !== undefined ? keepIfBlank(s(fields.birthday, 40), existing.birthday) : existing.birthday,
                is_friend: fields.isFriend !== undefined ? (fields.isFriend ? 1 : 0) : existing.is_friend,
            };
            this.db.prepare(`UPDATE contacts SET display_name=?, avatar_url=?, phone=?, friend_status=?,
                source=?, owner=?, consent=?, notes=?, last_contact_at=?, gender=?, birthday=?, is_friend=?,
                updated_at=? WHERE id=?`)
                .run(merged.display_name, merged.avatar_url, merged.phone, merged.friend_status,
                    merged.source, merged.owner, merged.consent, merged.notes, merged.last_contact_at,
                    merged.gender, merged.birthday, merged.is_friend, now, existing.id);
            this._audit(actor, 'contact.update', existing.id, name);
            return this.getContact(existing.id);
        }

        const id = crypto.randomUUID();
        this.db.prepare(`INSERT INTO contacts
            (id, account_id, zalo_uid, display_name, avatar_url, phone, friend_status, source, owner,
             consent, notes, gender, birthday, is_friend, first_contact_at, last_contact_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, accountId, zaloUid, name, s(fields.avatarUrl, 1000), s(normalizePhone(fields.phone), 30) || null,
                s(fields.friendStatus, 20) || 'unknown', s(fields.source), s(fields.owner),
                s(fields.consent, 20) || 'unknown', s(fields.notes, MAX_NOTES) || '',
                normalizeGender(fields.gender), s(fields.birthday, 40) || null, fields.isFriend ? 1 : 0,
                num(fields.firstContactAt, now), num(fields.lastContactAt, now), now, now);
        this._audit(actor, 'contact.create', id, name);
        return this.getContact(id);
    }

    getContact(id) {
        const row = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
        if (!row) return null;
        row.tags = this.db.prepare('SELECT tag FROM contact_tags WHERE contact_id = ? ORDER BY tag')
            .all(id).map(r => r.tag);
        row.groups = this.listContactGroups(id);
        return row;
    }

    // ── Nối khách hàng ↔ nhóm Zalo ───────────────────────────────────────

    listContactGroups(contactId) {
        return this.db.prepare('SELECT group_id, group_name FROM contact_groups WHERE contact_id = ? ORDER BY group_name')
            .all(contactId)
            .map(r => ({ groupId: r.group_id, name: r.group_name || r.group_id }));
    }

    /**
     * Đặt LẠI toàn bộ nhóm của một khách (replace, không merge).
     *
     * Replace vì UI là bộ chọn nhiều nhóm: bỏ tick một nhóm phải thành bỏ liên kết. Merge thì
     * không bao giờ bỏ được nhóm đã nối sai.
     */
    setContactGroups(contactId, groups, actor = 'system') {
        // Dùng đúng cụm "không tồn tại" như các lỗi khác: handleCrmAction phân loại 400 vs 500 bằng
        // regex trên message, lệch chữ là lỗi nhập liệu bị trả về thành 500.
        if (!this.getContact(contactId)) throw new Error('contact không tồn tại');
        const now = this._now();
        const rows = (Array.isArray(groups) ? groups : [])
            .map(g => (typeof g === 'string' ? { groupId: g, name: '' } : g))
            .map(g => ({ groupId: s(String(g?.groupId || '')).trim(), name: s(String(g?.name || '')) }))
            .filter(g => g.groupId);
        this.db.exec('BEGIN');
        try {
            this.db.prepare('DELETE FROM contact_groups WHERE contact_id = ?').run(contactId);
            const ins = this.db.prepare('INSERT OR REPLACE INTO contact_groups (contact_id, group_id, group_name, linked_at) VALUES (?, ?, ?, ?)');
            for (const g of rows) ins.run(contactId, g.groupId, g.name || null, now);
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        this._audit(actor, 'contact.groups', contactId, rows.map(g => g.name || g.groupId).join(', '));
        return this.listContactGroups(contactId);
    }

    /** Khách hàng thuộc một nhóm — để mở nhóm ra là thấy ai trong đó đã là khách. */
    listContactsByGroup(groupId, limit = 200) {
        const rows = this.db.prepare(`SELECT c.* FROM contacts c
            JOIN contact_groups g ON g.contact_id = c.id
            WHERE g.group_id = ? ORDER BY c.display_name LIMIT ?`).all(String(groupId), Math.min(num(limit, 200), 500));
        for (const r of rows) r.groups = this.listContactGroups(r.id);
        return rows;
    }

    /**
     * @param {object} [opts] { search, tag, accountId, limit=50, offset=0 }
     */
    listContacts(opts = {}) {
        const limit = Math.min(num(opts.limit, 50), 200);
        const offset = Math.max(num(opts.offset, 0), 0);
        const where = [];
        const params = [];
        if (opts.accountId) { where.push('account_id = ?'); params.push(s(opts.accountId)); }
        if (opts.search) {
            where.push('(display_name LIKE ? OR phone LIKE ? OR zalo_uid LIKE ?)');
            const q = `%${String(opts.search).slice(0, 100)}%`;
            params.push(q, q, q);
        }
        if (opts.tag) {
            where.push('id IN (SELECT contact_id FROM contact_tags WHERE tag = ?)');
            params.push(s(opts.tag, 50));
        }
        if (opts.groupId) {
            where.push('id IN (SELECT contact_id FROM contact_groups WHERE group_id = ?)');
            params.push(s(opts.groupId));
        }
        // `linked=only|none` — lọc theo việc khách đã nối được với người Zalo thật hay chưa. Chính chỗ
        // này cho owner thấy phần dữ liệu còn là sổ tay gõ tay: contact không có `zalo_uid` thì không
        // mở được lịch sử chat, không biết ở nhóm nào.
        if (opts.linked === 'only') where.push('zalo_uid IS NOT NULL');
        if (opts.linked === 'none') where.push('zalo_uid IS NULL');
        if (opts.gender === 'male' || opts.gender === 'female') { where.push('gender = ?'); params.push(opts.gender); }
        if (opts.friend === 'only') where.push('is_friend = 1');
        if (opts.friend === 'none') where.push('(is_friend IS NULL OR is_friend = 0)');
        const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';

        // "Sinh nhật trong N ngày tới" phải lọc TRONG JS, không phải SQL: `birthday` là chuỗi thô của
        // Zalo (nhiều định dạng, có cái thiếu năm), và khoảng ngày còn phải vòng qua giao thừa. Nhét
        // vào SQL thì hoặc sai, hoặc phải chuẩn hoá lúc ghi — mà chuẩn hoá lúc ghi sẽ nuốt mất những
        // chuỗi không parse được. Đổi lại phải đọc hết rồi mới cắt trang, nên chỉ làm khi có lọc này.
        const withinDays = num(opts.birthdayWithin, null);
        if (withinDays != null && withinDays >= 0) {
            const today = opts.today instanceof Date ? opts.today : new Date(this._now());
            const all = this.db.prepare(`SELECT * FROM contacts ${cond} ORDER BY updated_at DESC`).all(...params);
            const matched = [];
            for (const r of all) {
                const days = daysUntilBirthday(birthdayDayMonth(r.birthday), today);
                if (days == null || days > withinDays) continue;
                r.birthdayInDays = days;
                matched.push(r);
            }
            // Sắp theo sinh nhật gần nhất — đây là thứ duy nhất owner cần khi mở bộ lọc này.
            matched.sort((a, b) => a.birthdayInDays - b.birthdayInDays);
            const page = matched.slice(offset, offset + limit);
            this._hydrate(page);
            return { contacts: page, total: matched.length, limit, offset };
        }

        const rows = this.db.prepare(
            `SELECT * FROM contacts ${cond} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
            .all(...params, limit, offset);
        const total = this.db.prepare(`SELECT COUNT(*) AS n FROM contacts ${cond}`).all(...params)[0].n;
        this._hydrate(rows);
        return { contacts: rows, total, limit, offset };
    }

    /** Gắn tags + groups cho một trang contact (dùng chung cho mọi nhánh lọc). */
    _hydrate(rows) {
        const tagStmt = this.db.prepare('SELECT tag FROM contact_tags WHERE contact_id = ? ORDER BY tag');
        for (const r of rows) {
            r.tags = tagStmt.all(r.id).map(t => t.tag);
            r.groups = this.listContactGroups(r.id);
        }
        return rows;
    }

    setContactTags(contactId, tags, actor = 'system') {
        if (!this.getContact(contactId)) throw new Error('contact không tồn tại');
        const clean = [...new Set((tags || []).map(t => s(t, 50)?.trim()).filter(Boolean))].slice(0, 20);
        this.db.prepare('DELETE FROM contact_tags WHERE contact_id = ?').run(contactId);
        const ins = this.db.prepare('INSERT INTO contact_tags (contact_id, tag) VALUES (?, ?)');
        for (const tag of clean) ins.run(contactId, tag);
        this._audit(actor, 'contact.tags', contactId, clean.join(','));
        return clean;
    }

    deleteContact(id, actor = 'system') {
        const c = this.getContact(id);
        if (!c) return false;
        this.db.prepare('DELETE FROM contact_tags WHERE contact_id = ?').run(id);
        this.db.prepare('UPDATE leads SET contact_id = NULL WHERE contact_id = ?').run(id);
        this.db.prepare('UPDATE tasks SET contact_id = NULL WHERE contact_id = ?').run(id);
        this.db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
        this._audit(actor, 'contact.delete', id, c.display_name);
        return true;
    }

    /**
     * Sync member Zalo (từ group-members.json) → contacts. Idempotent.
     *
     * `m.groups` (mảng `{groupId, name}`) được nối luôn — đây là điểm khác so với bản cũ: trước đây
     * import xong thì khách nằm rời, không biết đến từ nhóm nào, nên CRM không dùng được dữ liệu mà
     * bot vốn đã có. Nối theo `uid` chứ không theo tên: tên Zalo trùng nhau và đổi được.
     */
    importMembers(members, accountId = 'default', actor = 'sync') {
        let created = 0, updated = 0, linked = 0;
        for (const m of members || []) {
            if (!m?.uid || !m?.name) continue;
            const before = this.db.prepare('SELECT id FROM contacts WHERE account_id = ? AND zalo_uid = ?')
                .get(String(accountId), String(m.uid));
            const saved = this.upsertContact({
                accountId,
                zaloUid: String(m.uid),
                displayName: String(m.name),
                avatarUrl: m.avatar,
                source: m.source || 'zalo-group',
                lastContactAt: m.lastSeen,
                // Bốn trường này là lý do tồn tại của bản import mới: trước đây khách nhập vào CRM chỉ
                // có tên + avatar, nên mọi bộ lọc đều lọc trên bảng trống. `upsertContact` bỏ qua
                // undefined và không ghi đè bằng rỗng, nên sync lại từ bot chưa kết bạn không xoá mất.
                phone: m.phone,
                birthday: m.birthday,
                gender: m.gender,
                isFriend: m.isFriend,
            }, actor);
            if (before) updated++; else created++;
            if (Array.isArray(m.groups) && m.groups.length) {
                // Gộp với nhóm đã nối trước đó — import từng nhóm nhiều lần không được xoá nhóm cũ.
                const merged = new Map(this.listContactGroups(saved.id).map(g => [g.groupId, g]));
                for (const g of m.groups) {
                    const gid = String(g?.groupId || g || '').trim();
                    if (gid) merged.set(gid, { groupId: gid, name: String(g?.name || merged.get(gid)?.name || '') });
                }
                this.setContactGroups(saved.id, [...merged.values()], actor);
                linked += m.groups.length;
            }
        }
        return { created, updated, linked };
    }

    // ── Leads pipeline ───────────────────────────────────────────────────

    createLead(fields, actor = 'system') {
        const title = s(fields.title)?.trim();
        if (!title) throw new Error('title là bắt buộc');
        const stage = s(fields.stage, 20) || 'new';
        if (!LEAD_STAGES.includes(stage)) throw new Error(`stage không hợp lệ: ${stage}`);
        const value = num(fields.value, 0);
        if (value < 0) throw new Error('value phải >= 0');
        if (fields.contactId && !this.getContact(fields.contactId)) {
            throw new Error('contact không tồn tại');
        }
        const now = this._now();
        const id = crypto.randomUUID();
        this.db.prepare(`INSERT INTO leads
            (id, contact_id, group_id, title, stage, value, currency, expected_close, product, source,
             assignee, loss_reason, next_action, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, fields.contactId || null, s(fields.groupId) || null, title, stage, value,
                s(fields.currency, 10) || 'VND',
                num(fields.expectedClose), s(fields.product), s(fields.source),
                s(fields.assignee), null, s(fields.nextAction), now, now);
        this.db.prepare('INSERT INTO lead_stage_history (id, lead_id, from_stage, to_stage, actor, at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(crypto.randomUUID(), id, null, stage, s(actor), now);
        this._audit(actor, 'lead.create', id, title);
        return this.getLead(id);
    }

    getLead(id) {
        const row = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
        if (!row) return null;
        if (row.contact_id) row.contact = this.getContact(row.contact_id);
        return row;
    }

    updateLead(id, fields, actor = 'system') {
        const lead = this.getLead(id);
        if (!lead) throw new Error('lead không tồn tại');
        if (fields.stage !== undefined) throw new Error('đổi stage phải dùng moveLeadStage');
        const patch = {
            title: fields.title !== undefined ? (s(fields.title)?.trim() || lead.title) : lead.title,
            value: fields.value !== undefined ? Math.max(num(fields.value, 0), 0) : lead.value,
            currency: fields.currency !== undefined ? (s(fields.currency, 10) || 'VND') : lead.currency,
            expected_close: fields.expectedClose !== undefined ? num(fields.expectedClose) : lead.expected_close,
            product: fields.product !== undefined ? s(fields.product) : lead.product,
            source: fields.source !== undefined ? s(fields.source) : lead.source,
            assignee: fields.assignee !== undefined ? s(fields.assignee) : lead.assignee,
            loss_reason: fields.lossReason !== undefined ? s(fields.lossReason) : lead.loss_reason,
            next_action: fields.nextAction !== undefined ? s(fields.nextAction) : lead.next_action,
            contact_id: fields.contactId !== undefined ? (fields.contactId || null) : lead.contact_id,
            group_id: fields.groupId !== undefined ? (s(fields.groupId) || null) : lead.group_id,
        };
        if (patch.contact_id && !this.getContact(patch.contact_id)) throw new Error('contact không tồn tại');
        this.db.prepare(`UPDATE leads SET title=?, value=?, currency=?, expected_close=?, product=?,
            source=?, assignee=?, loss_reason=?, next_action=?, contact_id=?, group_id=?, updated_at=? WHERE id=?`)
            .run(patch.title, patch.value, patch.currency, patch.expected_close, patch.product,
                patch.source, patch.assignee, patch.loss_reason, patch.next_action, patch.contact_id,
                patch.group_id, this._now(), id);
        this._audit(actor, 'lead.update', id, patch.title);
        return this.getLead(id);
    }

    /** Chuyển stage (kéo-thả kanban). Ghi history để undo được. */
    moveLeadStage(id, toStage, actor = 'system', opts = {}) {
        const lead = this.getLead(id);
        if (!lead) throw new Error('lead không tồn tại');
        if (!LEAD_STAGES.includes(toStage)) throw new Error(`stage không hợp lệ: ${toStage}`);
        if (lead.stage === toStage) return lead;
        if (toStage === 'lost' && opts.lossReason !== undefined) {
            this.db.prepare('UPDATE leads SET loss_reason = ? WHERE id = ?').run(s(opts.lossReason), id);
        }
        const now = this._now();
        this.db.prepare('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?').run(toStage, now, id);
        this.db.prepare('INSERT INTO lead_stage_history (id, lead_id, from_stage, to_stage, actor, at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(crypto.randomUUID(), id, lead.stage, toStage, s(actor), now);
        this._audit(actor, 'lead.move', id, `${lead.stage} → ${toStage}`);
        return this.getLead(id);
    }

    /** Undo lần chuyển stage gần nhất (nút hoàn tác sau kéo-thả). */
    undoLeadStage(id, actor = 'system') {
        const last = this.db.prepare(
            'SELECT * FROM lead_stage_history WHERE lead_id = ? AND from_stage IS NOT NULL ORDER BY at DESC LIMIT 1')
            .get(id);
        if (!last) return this.getLead(id);
        return this.moveLeadStage(id, last.from_stage, actor);
    }

    deleteLead(id, actor = 'system') {
        const lead = this.getLead(id);
        if (!lead) return false;
        this.db.prepare('DELETE FROM lead_stage_history WHERE lead_id = ?').run(id);
        this.db.prepare('UPDATE tasks SET lead_id = NULL WHERE lead_id = ?').run(id);
        this.db.prepare('DELETE FROM leads WHERE id = ?').run(id);
        this._audit(actor, 'lead.delete', id, lead.title);
        return true;
    }

    /** Toàn bộ pipeline nhóm theo stage — cho kanban. */
    pipeline() {
        const rows = this.db.prepare('SELECT * FROM leads ORDER BY updated_at DESC').all();
        const contactStmt = this.db.prepare('SELECT display_name, avatar_url FROM contacts WHERE id = ?');
        const byStage = Object.fromEntries(LEAD_STAGES.map(st => [st, []]));
        const totals = Object.fromEntries(LEAD_STAGES.map(st => [st, 0]));
        for (const r of rows) {
            if (r.contact_id) {
                const c = contactStmt.get(r.contact_id);
                if (c) { r.contactName = c.display_name; r.contactAvatar = c.avatar_url; }
            }
            (byStage[r.stage] || (byStage[r.stage] = [])).push(r);
            totals[r.stage] = (totals[r.stage] || 0) + (r.value || 0);
        }
        return { stages: LEAD_STAGES, byStage, totals, count: rows.length };
    }

    // ── Tasks ────────────────────────────────────────────────────────────

    createTask(fields, actor = 'system') {
        const title = s(fields.title)?.trim();
        if (!title) throw new Error('title là bắt buộc');
        if (fields.contactId && !this.getContact(fields.contactId)) throw new Error('contact không tồn tại');
        if (fields.leadId && !this.getLead(fields.leadId)) throw new Error('lead không tồn tại');
        const now = this._now();
        const id = crypto.randomUUID();
        this.db.prepare(`INSERT INTO tasks (id, title, note, due_at, done_at, contact_id, lead_id, group_id, assignee, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
            .run(id, title, s(fields.note, 2000) || '', num(fields.dueAt),
                fields.contactId || null, fields.leadId || null, s(fields.groupId) || null,
                s(fields.assignee), now, now);
        this._audit(actor, 'task.create', id, title);
        return this.getTask(id);
    }

    getTask(id) {
        return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) || null;
    }

    setTaskDone(id, done, actor = 'system') {
        const task = this.getTask(id);
        if (!task) throw new Error('task không tồn tại');
        const now = this._now();
        this.db.prepare('UPDATE tasks SET done_at = ?, updated_at = ? WHERE id = ?')
            .run(done ? now : null, now, id);
        this._audit(actor, done ? 'task.done' : 'task.reopen', id, task.title);
        return this.getTask(id);
    }

    deleteTask(id, actor = 'system') {
        const task = this.getTask(id);
        if (!task) return false;
        this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
        this._audit(actor, 'task.delete', id, task.title);
        return true;
    }

    /**
     * @param {object} [opts] { filter: 'open'|'overdue'|'done'|'all', contactId, leadId, limit }
     */
    listTasks(opts = {}) {
        const where = [];
        const params = [];
        const now = this._now();
        switch (opts.filter || 'open') {
            case 'open': where.push('done_at IS NULL'); break;
            case 'overdue': where.push('done_at IS NULL AND due_at IS NOT NULL AND due_at < ?'); params.push(now); break;
            case 'done': where.push('done_at IS NOT NULL'); break;
            case 'all': break;
            default: throw new Error(`filter không hợp lệ: ${opts.filter}`);
        }
        if (opts.contactId) { where.push('contact_id = ?'); params.push(opts.contactId); }
        if (opts.leadId) { where.push('lead_id = ?'); params.push(opts.leadId); }
        const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const limit = Math.min(num(opts.limit, 100), 500);
        const rows = this.db.prepare(
            `SELECT * FROM tasks ${cond} ORDER BY (due_at IS NULL), due_at ASC, created_at DESC LIMIT ?`)
            .all(...params, limit);
        for (const r of rows) {
            r.overdue = !r.done_at && r.due_at != null && r.due_at < now;
        }
        return rows;
    }

    /** Số liệu cho Overview: lead theo stage, task quá hạn... */
    stats() {
        const now = this._now();
        const leadRows = this.db.prepare('SELECT stage, COUNT(*) AS n, SUM(value) AS total FROM leads GROUP BY stage').all();
        const leads = Object.fromEntries(LEAD_STAGES.map(st => [st, { n: 0, total: 0 }]));
        for (const r of leadRows) leads[r.stage] = { n: r.n, total: r.total || 0 };
        return {
            contacts: this.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
            leads,
            tasksOpen: this.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE done_at IS NULL').get().n,
            tasksOverdue: this.db.prepare(
                'SELECT COUNT(*) AS n FROM tasks WHERE done_at IS NULL AND due_at IS NOT NULL AND due_at < ?').get(now).n,
        };
    }
}
