/**
 * CrmStore — CRM core (Z4 subset): Contacts, Leads pipeline, Tasks, Audit.
 *
 * - Chạy trên cùng SQLite DB của context engine (schema v2, migrations.js).
 * - Idempotent: contact khoá unique theo (account_id, zalo_uid) — sync lại
 *   member không nhân đôi; mọi mutation ghi audit log.
 * - Validation tập trung ở đây để API/UI mỏng.
 */

import crypto from 'node:crypto';
import { birthdayDayMonth, daysUntilBirthday, foldName, normalizeGender, normalizePhone } from './zalo-people.js';

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
        // `_maxLimit` là cửa nội bộ cho `exportContacts` — trần 200 giữ cho API công khai không bị
        // ai đó gọi limit=100000 làm nghẽn, còn xuất file thì cần lấy hết thật.
        const limit = Math.min(num(opts.limit, 50), num(opts._maxLimit, 200));
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
        if (opts.source) { where.push('source = ?'); params.push(s(opts.source)); }
        const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';

        // Hai nhánh dưới đây phải đọc HẾT rồi mới cắt trang, vì SQL không làm đúng được:
        //
        // - **Sinh nhật trong N ngày tới**: `birthday` là chuỗi thô của Zalo (nhiều định dạng, có
        //   cái thiếu năm) và khoảng ngày còn phải vòng qua giao thừa. Nhét vào SQL thì hoặc sai,
        //   hoặc phải chuẩn hoá lúc ghi — mà chuẩn hoá lúc ghi sẽ nuốt mất chuỗi không parse được.
        // - **Sắp Tên A→Z**: `COLLATE NOCASE` của SQLite so theo ASCII, nên mọi tên bắt đầu bằng
        //   Đ/Ê/Ô/Ư bị đẩy xuống sau hết chữ Z — với danh bạ tiếng Việt thì đó là danh sách sai,
        //   nhìn phát ra ngay. `localeCompare('vi')` xếp đúng nhưng chỉ chạy được trong JS.
        //
        // Đổi lại là mất khả năng phân trang trong SQL. Chấp nhận được: danh bạ Zalo của một tài
        // khoản cỡ vài nghìn người, sắp trong JS tốn vài mili-giây. Nếu có ngày nó lên hàng chục
        // nghìn thì thêm cột khoá-sắp-xếp đã bỏ dấu, đừng quay lại COLLATE.
        // Nhánh thứ ba dùng chung đường này: **gộp trùng người ở chế độ tất cả bot** — phải có đủ
        // tags/groups của MỌI dòng mới hợp nhất được, nên cũng đọc hết rồi mới cắt trang.
        const withinDays = num(opts.birthdayWithin, null);
        const byBirthday = withinDays != null && withinDays >= 0;
        const byName = opts.sort === 'name';
        const merge = opts.mergePeople === true;
        if (byBirthday || byName || merge) {
            const today = opts.today instanceof Date ? opts.today : new Date(this._now());
            const all = this.db.prepare(`SELECT * FROM contacts ${cond} ORDER BY updated_at DESC`).all(...params);
            let matched = [];
            for (const r of all) {
                if (byBirthday) {
                    const days = daysUntilBirthday(birthdayDayMonth(r.birthday), today);
                    if (days == null || days > withinDays) continue;
                    r.birthdayInDays = days;
                } else if (r.birthday) {
                    r.birthdayInDays = daysUntilBirthday(birthdayDayMonth(r.birthday), today);
                }
                matched.push(r);
            }
            // Hydrate TRƯỚC khi gộp: hợp nhất nhãn và nhóm của các bot cần biết chúng là gì.
            if (merge) {
                this._hydrate(matched);
                matched = this._mergePeople(matched);
            }
            // Lọc sinh nhật thì thứ duy nhất owner cần là "ai sắp tới sinh nhật trước" — nó thắng
            // cả yêu cầu sắp theo tên.
            if (byBirthday) matched.sort((a, b) => a.birthdayInDays - b.birthdayInDays);
            else if (byName) matched.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name), 'vi'));
            const page = matched.slice(offset, offset + limit);
            if (!merge) this._hydrate(page);
            return { contacts: page, total: matched.length, limit, offset };
        }
        const order = 'updated_at DESC';

        const rows = this.db.prepare(
            `SELECT * FROM contacts ${cond} ORDER BY ${order} LIMIT ? OFFSET ?`)
            .all(...params, limit, offset);
        const total = this.db.prepare(`SELECT COUNT(*) AS n FROM contacts ${cond}`).all(...params)[0].n;
        this._hydrate(rows);
        return { contacts: rows, total, limit, offset };
    }

    /**
     * Gộp các dòng CÙNG MỘT NGƯỜI ở nhiều bot thành một dòng — chỉ dùng cho chế độ "tất cả bot".
     *
     * Zalo cấp uid khác nhau cho cùng một người ở mỗi tài khoản, nên cùng một khách nằm trong nhóm
     * của hai bot sẽ là hai bản ghi thật, hợp lệ, không thể gộp ở tầng dữ liệu (bot nào nhắn cũng
     * phải dùng đúng uid của mình). Chỉ gộp lúc HIỂN THỊ.
     *
     * Khoá gộp đi từ bằng chứng mạnh xuống yếu: **sđt** (trùng là chắc chắn một người) → **tên
     * không dấu + ngày sinh** → **tên không dấu**. Bậc cuối có thể gộp nhầm hai người trùng tên mà
     * cả hai đều thiếu sđt lẫn ngày sinh; đổi lại là danh sách tổng không còn lặp. Chọn một bot cụ
     * thể thì không gộp gì cả, luôn chính xác.
     */
    _mergePeople(rows) {
        const keyOf = (r) => {
            const phone = normalizePhone(r.phone);
            if (phone) return `p:${phone}`;
            const name = foldName(r.display_name);
            const dm = birthdayDayMonth(r.birthday);
            if (dm) return `nb:${name}|${dm.day}/${dm.month}`;
            return `n:${name}`;
        };
        const byKey = new Map();
        for (const r of rows) {
            const k = keyOf(r);
            const cur = byKey.get(k);
            if (!cur) {
                byKey.set(k, { ...r, mergedIds: [r.id], accounts: [r.account_id] });
                continue;
            }
            cur.mergedIds.push(r.id);
            if (!cur.accounts.includes(r.account_id)) cur.accounts.push(r.account_id);
            // Trường nào bên kia có mà bên này trống thì lấy — hồ sơ chỉ lộ với bot đã kết bạn, nên
            // mỗi bot biết một mẩu khác nhau về cùng một người.
            for (const f of ['phone', 'birthday', 'gender', 'avatar_url', 'notes']) {
                if (!cur[f] && r[f]) cur[f] = r[f];
            }
            cur.is_friend = cur.is_friend || r.is_friend;
            cur.last_contact_at = Math.max(cur.last_contact_at || 0, r.last_contact_at || 0) || null;
            cur.tags = [...new Set([...(cur.tags || []), ...(r.tags || [])])].sort();
            const seenGroups = new Set((cur.groups || []).map(g => g.groupId));
            for (const g of (r.groups || [])) if (!seenGroups.has(g.groupId)) { cur.groups.push(g); seenGroups.add(g.groupId); }
        }
        return [...byKey.values()];
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

    // ── Danh mục nhãn (màu + emoji) ──────────────────────────────────────

    /** Nhãn kèm số liên hệ đang mang — không có số thì owner không biết nhãn nào còn dùng. */
    listTags() {
        const rows = this.db.prepare(`
            SELECT t.name, t.color, t.emoji, t.zalo_label_id, t.source,
                   (SELECT COUNT(*) FROM contact_tags ct WHERE ct.tag = t.name) AS n
            FROM crm_tags t ORDER BY t.name`).all();
        // Nhãn đã gắn cho liên hệ nhưng CHƯA có hàng danh mục (tag cũ, gõ tay) vẫn phải hiện ra —
        // giấu đi thì bộ lọc "Nhãn" thiếu mất đúng những nhãn owner đang dùng.
        const known = new Set(rows.map(r => r.name));
        const orphans = this.db.prepare(
            'SELECT tag AS name, COUNT(*) AS n FROM contact_tags GROUP BY tag ORDER BY tag').all();
        for (const o of orphans) {
            if (known.has(o.name)) continue;
            rows.push({ name: o.name, color: null, emoji: null, zalo_label_id: null, source: 'manual', n: o.n });
        }
        rows.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
        return rows;
    }

    upsertTag(fields, actor = 'system') {
        const name = s(fields.name, 50)?.trim();
        if (!name) throw new Error('tên nhãn là bắt buộc');
        this.db.prepare(`INSERT INTO crm_tags (name, color, emoji, zalo_label_id, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET color=excluded.color, emoji=excluded.emoji,
                zalo_label_id=excluded.zalo_label_id, source=excluded.source, updated_at=excluded.updated_at`)
            .run(name, s(fields.color, 20) || null, s(fields.emoji, 16) || null,
                num(fields.zaloLabelId), s(fields.source, 20) || 'manual', this._now());
        this._audit(actor, 'tag.upsert', name, s(fields.color, 20) || '');
        return this.db.prepare('SELECT * FROM crm_tags WHERE name = ?').get(name);
    }

    /** Xoá nhãn: bỏ khỏi danh mục VÀ gỡ khỏi mọi liên hệ — nửa vời thì nhãn ma vẫn hiện ở bộ lọc. */
    deleteTag(name, actor = 'system') {
        const tag = s(name, 50)?.trim();
        if (!tag) return { removed: 0 };
        const removed = this.db.prepare('SELECT COUNT(*) AS n FROM contact_tags WHERE tag = ?').get(tag).n;
        this.db.prepare('DELETE FROM contact_tags WHERE tag = ?').run(tag);
        this.db.prepare('DELETE FROM crm_tags WHERE name = ?').run(tag);
        this._audit(actor, 'tag.delete', tag, `gỡ khỏi ${removed} liên hệ`);
        return { removed };
    }

    /**
     * Kéo nhãn phân loại có sẵn của Zalo về CRM.
     *
     * `labels` là `LabelData[]` của zca-js: `{ id, text, color, emoji, conversations[] }`, trong đó
     * `conversations` là danh sách id hội thoại đang mang nhãn đó.
     *
     * Hai quyết định:
     * - **Thay thế, không gộp, cho riêng nhãn nguồn Zalo.** Owner bỏ nhãn trên app Zalo thì CRM phải
     *   bỏ theo, không thì hai bên lệch dần và không ai tin bên nào. Nhãn owner tự đặt trong CRM
     *   (`source: 'manual'`) tuyệt đối không đụng tới.
     * - **Đếm và trả về số KHÔNG khớp.** `conversations` có cả id nhóm và người chưa import, khớp
     *   không hết là chuyện bình thường — nhưng phải nói ra, không thì owner thấy "đồng bộ xong"
     *   mà danh sách chẳng đổi gì và tưởng hỏng.
     *
     * `opts.prune = false` để gọi khi **có tài khoản đọc nhãn hỏng**: lúc đó danh sách nhãn nhận
     * được là KHÔNG đầy đủ, mà luật "thay thế" ở trên lại hiểu thiếu-nghĩa-là-đã-xoá — sẽ gỡ sạch
     * nhãn của đúng tài khoản vừa hỏng. Thiếu dữ liệu thì chỉ được thêm, không được xoá.
     */
    syncZaloLabels(labels, actor = 'system', opts = {}) {
        const prune = opts.prune !== false;
        const list = Array.isArray(labels) ? labels : [];
        const now = this._now();

        // `accountId` giới hạn cả việc KHỚP lẫn việc XOÁ vào đúng liên hệ của một bot. Bắt buộc khi
        // có nhiều bot: uid của cùng một người khác nhau giữa các tài khoản, nên nhãn của bot A
        // không bao giờ khớp liên hệ của bot B — mà bước "thay thế" thì lại xoá theo TÊN nhãn, nên
        // đồng bộ bot A sẽ gỡ sạch nhãn mà bot B vừa gắn. Hai bot thay nhau xoá của nhau.
        const acc = opts.accountId != null ? String(opts.accountId) : null;
        const uidRows = acc
            ? this.db.prepare('SELECT id, zalo_uid FROM contacts WHERE zalo_uid IS NOT NULL AND account_id = ?').all(acc)
            : this.db.prepare('SELECT id, zalo_uid FROM contacts WHERE zalo_uid IS NOT NULL').all();
        const uidToId = new Map(uidRows.map(r => [String(r.zalo_uid), r.id]));

        const prevZaloTags = this.db.prepare("SELECT name FROM crm_tags WHERE source = 'zalo'").all().map(r => r.name);
        const seen = [];
        let assigned = 0, unmatched = 0;

        this.db.exec('BEGIN');
        try {
            const clearScoped = this.db.prepare(`DELETE FROM contact_tags WHERE tag = ? AND contact_id IN
                (SELECT id FROM contacts WHERE account_id = ?)`);
            const clearAll = this.db.prepare('DELETE FROM contact_tags WHERE tag = ?');
            const clearTag = (name) => (acc ? clearScoped.run(name, acc) : clearAll.run(name));
            const assignStmt = this.db.prepare('INSERT OR IGNORE INTO contact_tags (contact_id, tag) VALUES (?, ?)');
            const tagStmt = this.db.prepare(`INSERT INTO crm_tags (name, color, emoji, zalo_label_id, source, updated_at)
                VALUES (?, ?, ?, ?, 'zalo', ?)
                ON CONFLICT(name) DO UPDATE SET color=excluded.color, emoji=excluded.emoji,
                    zalo_label_id=excluded.zalo_label_id, source='zalo', updated_at=excluded.updated_at`);

            for (const raw of list) {
                const name = s(raw?.text, 50)?.trim();
                if (!name) continue;
                seen.push(name);
                tagStmt.run(name, s(raw?.color, 20) || null, s(raw?.emoji, 16) || null, num(raw?.id), now);
                clearTag(name);
                for (const conv of (Array.isArray(raw?.conversations) ? raw.conversations : [])) {
                    const contactId = uidToId.get(String(conv).replace(/_0$/, ''));
                    if (!contactId) { unmatched++; continue; }
                    assignStmt.run(contactId, name);
                    assigned++;
                }
            }

            // Nhãn Zalo đã bị xoá hẳn bên app → gỡ luôn khỏi CRM, kể cả hàng danh mục.
            const gone = prune ? prevZaloTags.filter(n => !seen.includes(n)) : [];
            for (const n of gone) {
                clearTag(n);
                this.db.prepare('DELETE FROM crm_tags WHERE name = ? AND source = ?').run(n, 'zalo');
            }
            this.db.exec('COMMIT');
            this._audit(actor, 'tag.sync-zalo', `${seen.length} nhãn`, `gắn ${assigned}, không khớp ${unmatched}, gỡ ${gone.length}`);
            return { tags: seen.length, assigned, unmatched, removed: gone.length };
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }

    /**
     * Dọn nhãn nguồn Zalo đã biến mất khỏi app — TÁCH RIÊNG khỏi `syncZaloLabels` vì nó là việc
     * toàn cục: một nhãn chỉ thật sự "đã xoá" khi KHÔNG tài khoản nào còn nó. Gọi dọn bên trong
     * vòng lặp từng bot sẽ xoá nhãn mà bot kế tiếp vẫn đang dùng.
     *
     * @param {string[]} keepNames tên nhãn còn thấy trên MỌI tài khoản đọc được
     */
    pruneZaloTags(keepNames, actor = 'system') {
        const keep = new Set((Array.isArray(keepNames) ? keepNames : []).map(n => String(n)));
        const gone = this.db.prepare("SELECT name FROM crm_tags WHERE source = 'zalo'").all()
            .map(r => r.name).filter(n => !keep.has(n));
        if (!gone.length) return 0;
        const delTag = this.db.prepare('DELETE FROM contact_tags WHERE tag = ?');
        const delCat = this.db.prepare("DELETE FROM crm_tags WHERE name = ? AND source = 'zalo'");
        for (const n of gone) { delTag.run(n); delCat.run(n); }
        this._audit(actor, 'tag.prune-zalo', `${gone.length} nhãn`, gone.join(', '));
        return gone.length;
    }

    // ── Thao tác hàng loạt ───────────────────────────────────────────────

    /**
     * Gắn/bỏ một nhãn cho nhiều liên hệ cùng lúc.
     *
     * Bỏ qua id không tồn tại thay vì ném: thao tác hàng loạt chạy trên danh sách người dùng vừa
     * tick, mà giữa lúc tick và lúc bấm có thể một bản ghi đã bị xoá ở tab khác — ném lỗi thì cả
     * lô 500 người không có gì được ghi vì một id lạc.
     */
    tagContacts(contactIds, tag, add = true, actor = 'system') {
        const name = s(tag, 50)?.trim();
        if (!name) throw new Error('tên nhãn là bắt buộc');
        const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).map(String).filter(Boolean))];
        if (!ids.length) return { changed: 0, skipped: 0 };
        const exists = this.db.prepare('SELECT id FROM contacts WHERE id = ?');
        const ins = this.db.prepare('INSERT OR IGNORE INTO contact_tags (contact_id, tag) VALUES (?, ?)');
        const del = this.db.prepare('DELETE FROM contact_tags WHERE contact_id = ? AND tag = ?');
        let changed = 0, skipped = 0;
        this.db.exec('BEGIN');
        try {
            for (const id of ids) {
                if (!exists.get(id)) { skipped++; continue; }
                (add ? ins : del).run(id, name);
                changed++;
            }
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        this._audit(actor, add ? 'contacts.tag-add' : 'contacts.tag-remove', name, `${changed} liên hệ`);
        return { changed, skipped };
    }

    /** Xoá nhiều liên hệ — dùng lại deleteContact để lead/task được gỡ liên kết chứ không mất. */
    deleteContacts(contactIds, actor = 'system') {
        const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).map(String).filter(Boolean))];
        let deleted = 0;
        for (const id of ids) if (this.deleteContact(id, actor)) deleted++;
        return { deleted, skipped: ids.length - deleted };
    }

    /**
     * Nhập liên hệ từ file (CSV) — KHÔNG có `zalo_uid` nên phải tự tìm bản trùng.
     *
     * Thứ tự khớp đi từ chắc xuống yếu: `zalo_uid` (nếu file có) → **sđt** trong cùng tài khoản →
     * **tên không dấu** trong cùng tài khoản. Thiếu bước này thì nhập lại cùng một file lần thứ hai
     * là nhân đôi toàn bộ danh bạ — lỗi mà người dùng chỉ phát hiện khi đã muộn.
     *
     * Chỉ ghi đè trường có giá trị trong file: cột để trống nghĩa là "không đụng tới", không phải
     * "xoá đi" — cùng luật với import từ Zalo.
     */
    importRows(rows, accountId = 'default', actor = 'import') {
        const acc = s(accountId) || 'default';
        let created = 0, updated = 0, skipped = 0;
        const byPhone = new Map();
        const byName = new Map();
        for (const r of this.db.prepare('SELECT id, phone, display_name FROM contacts WHERE account_id = ?').all(acc)) {
            const p = normalizePhone(r.phone);
            if (p && !byPhone.has(p)) byPhone.set(p, r.id);
            const n = foldName(r.display_name);
            if (n && !byName.has(n)) byName.set(n, r.id);
        }

        for (const raw of (Array.isArray(rows) ? rows : [])) {
            const name = s(raw?.displayName)?.trim();
            if (!name) { skipped++; continue; }
            const phone = normalizePhone(raw.phone);
            const uid = s(raw.zaloUid)?.trim() || null;

            let existingId = null;
            if (uid) {
                existingId = this.db.prepare('SELECT id FROM contacts WHERE account_id = ? AND zalo_uid = ?')
                    .get(acc, uid)?.id || null;
            }
            if (!existingId && phone) existingId = byPhone.get(phone) || null;
            if (!existingId) existingId = byName.get(foldName(name)) || null;

            const saved = this.upsertContact({
                id: existingId || undefined,
                accountId: acc,
                zaloUid: existingId ? undefined : uid,
                displayName: name,
                phone: phone || undefined,
                gender: raw.gender || undefined,
                birthday: raw.birthday || undefined,
                notes: raw.notes || undefined,
                source: raw.source || (existingId ? undefined : 'import'),
            }, actor);

            if (existingId) updated++; else created++;
            const p2 = normalizePhone(saved.phone);
            if (p2) byPhone.set(p2, saved.id);
            byName.set(foldName(saved.display_name), saved.id);

            const tags = String(raw.tags || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
            if (tags.length) {
                const ins = this.db.prepare('INSERT OR IGNORE INTO contact_tags (contact_id, tag) VALUES (?, ?)');
                for (const tg of tags.slice(0, 20)) ins.run(saved.id, s(tg, 50));
            }
        }
        this._audit(actor, 'contacts.import-file', acc, `thêm ${created}, cập nhật ${updated}, bỏ ${skipped}`);
        return { created, updated, skipped };
    }

    /** Toàn bộ liên hệ khớp bộ lọc, không phân trang — cho việc xuất file. */
    exportContacts(opts = {}) {
        return this.listContacts({ ...opts, offset: 0, limit: 10000, _maxLimit: 10000 }).contacts;
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
        // Bảng nối nhóm thêm ở v3 nhưng chỗ xoá này không được cập nhật theo — bản ghi mồ côi
        // không lộ ra khi xoá lẻ, nhưng xoá hàng loạt 500 người thì `listContactsByGroup` sẽ đếm
        // cả người đã xoá.
        this.db.prepare('DELETE FROM contact_groups WHERE contact_id = ?').run(id);
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
