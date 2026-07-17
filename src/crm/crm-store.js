/**
 * CrmStore — CRM core (Z4 subset): Contacts, Leads pipeline, Tasks, Audit.
 *
 * - Chạy trên cùng SQLite DB của context engine (schema v2, migrations.js).
 * - Idempotent: contact khoá unique theo (account_id, zalo_uid) — sync lại
 *   member không nhân đôi; mọi mutation ghi audit log.
 * - Validation tập trung ở đây để API/UI mỏng.
 */

import crypto from 'node:crypto';

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

        if (existing) {
            const merged = {
                display_name: name,
                avatar_url: fields.avatarUrl !== undefined ? s(fields.avatarUrl, 1000) : existing.avatar_url,
                phone: fields.phone !== undefined ? s(fields.phone, 30) : existing.phone,
                friend_status: fields.friendStatus !== undefined ? s(fields.friendStatus, 20) : existing.friend_status,
                source: fields.source !== undefined ? s(fields.source) : existing.source,
                owner: fields.owner !== undefined ? s(fields.owner) : existing.owner,
                consent: fields.consent !== undefined ? s(fields.consent, 20) : existing.consent,
                notes: fields.notes !== undefined ? s(fields.notes, MAX_NOTES) : existing.notes,
                last_contact_at: fields.lastContactAt !== undefined ? num(fields.lastContactAt) : existing.last_contact_at,
            };
            this.db.prepare(`UPDATE contacts SET display_name=?, avatar_url=?, phone=?, friend_status=?,
                source=?, owner=?, consent=?, notes=?, last_contact_at=?, updated_at=? WHERE id=?`)
                .run(merged.display_name, merged.avatar_url, merged.phone, merged.friend_status,
                    merged.source, merged.owner, merged.consent, merged.notes, merged.last_contact_at,
                    now, existing.id);
            this._audit(actor, 'contact.update', existing.id, name);
            return this.getContact(existing.id);
        }

        const id = crypto.randomUUID();
        this.db.prepare(`INSERT INTO contacts
            (id, account_id, zalo_uid, display_name, avatar_url, phone, friend_status, source, owner,
             consent, notes, first_contact_at, last_contact_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, accountId, zaloUid, name, s(fields.avatarUrl, 1000), s(fields.phone, 30),
                s(fields.friendStatus, 20) || 'unknown', s(fields.source), s(fields.owner),
                s(fields.consent, 20) || 'unknown', s(fields.notes, MAX_NOTES) || '',
                num(fields.firstContactAt, now), num(fields.lastContactAt, now), now, now);
        this._audit(actor, 'contact.create', id, name);
        return this.getContact(id);
    }

    getContact(id) {
        const row = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
        if (!row) return null;
        row.tags = this.db.prepare('SELECT tag FROM contact_tags WHERE contact_id = ? ORDER BY tag')
            .all(id).map(r => r.tag);
        return row;
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
        const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const rows = this.db.prepare(
            `SELECT * FROM contacts ${cond} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
            .all(...params, limit, offset);
        const total = this.db.prepare(`SELECT COUNT(*) AS n FROM contacts ${cond}`).all(...params)[0].n;
        const tagStmt = this.db.prepare('SELECT tag FROM contact_tags WHERE contact_id = ? ORDER BY tag');
        for (const r of rows) r.tags = tagStmt.all(r.id).map(t => t.tag);
        return { contacts: rows, total, limit, offset };
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

    /** Sync member Zalo (từ group-members.json) → contacts. Idempotent. */
    importMembers(members, accountId = 'default', actor = 'sync') {
        let created = 0, updated = 0;
        for (const m of members || []) {
            if (!m?.uid || !m?.name) continue;
            const before = this.db.prepare('SELECT id FROM contacts WHERE account_id = ? AND zalo_uid = ?')
                .get(String(accountId), String(m.uid));
            this.upsertContact({
                accountId,
                zaloUid: String(m.uid),
                displayName: String(m.name),
                avatarUrl: m.avatar,
                source: m.source || 'zalo-group',
                lastContactAt: m.lastSeen,
            }, actor);
            if (before) updated++; else created++;
        }
        return { created, updated };
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
            (id, contact_id, title, stage, value, currency, expected_close, product, source,
             assignee, loss_reason, next_action, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, fields.contactId || null, title, stage, value, s(fields.currency, 10) || 'VND',
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
        };
        if (patch.contact_id && !this.getContact(patch.contact_id)) throw new Error('contact không tồn tại');
        this.db.prepare(`UPDATE leads SET title=?, value=?, currency=?, expected_close=?, product=?,
            source=?, assignee=?, loss_reason=?, next_action=?, contact_id=?, updated_at=? WHERE id=?`)
            .run(patch.title, patch.value, patch.currency, patch.expected_close, patch.product,
                patch.source, patch.assignee, patch.loss_reason, patch.next_action, patch.contact_id,
                this._now(), id);
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
        this.db.prepare(`INSERT INTO tasks (id, title, note, due_at, done_at, contact_id, lead_id, assignee, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
            .run(id, title, s(fields.note, 2000) || '', num(fields.dueAt),
                fields.contactId || null, fields.leadId || null, s(fields.assignee), now, now);
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
