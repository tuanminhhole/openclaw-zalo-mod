/**
 * Migration framework — schema version lưu trong bảng schema_migrations,
 * mỗi migration là SQL idempotent chạy trong transaction.
 */

export const MIGRATIONS = [
    {
        version: 1,
        name: 'core-context-tables',
        sql: `
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                group_id TEXT,
                type TEXT NOT NULL DEFAULT 'group',
                title TEXT,
                last_message_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                sender_name TEXT,
                text TEXT,
                raw_type TEXT DEFAULT 'message',
                sent_at INTEGER NOT NULL,
                quote_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conv_time
                ON messages(conversation_id, sent_at);
            CREATE TABLE IF NOT EXISTS attachments (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                kind TEXT,
                filename TEXT,
                mime TEXT,
                size INTEGER,
                local_path TEXT,
                status TEXT DEFAULT 'pending',
                checksum TEXT
            );
            CREATE TABLE IF NOT EXISTS turn_contexts (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                created_at INTEGER NOT NULL,
                expires_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_turns_status ON turn_contexts(status);
        `,
    },
    {
        version: 2,
        name: 'crm-core-tables',
        sql: `
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL DEFAULT 'default',
                zalo_uid TEXT,
                display_name TEXT NOT NULL,
                avatar_url TEXT,
                phone TEXT,
                friend_status TEXT DEFAULT 'unknown',
                source TEXT,
                owner TEXT,
                consent TEXT DEFAULT 'unknown',
                notes TEXT DEFAULT '',
                first_contact_at INTEGER,
                last_contact_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_acc_uid
                ON contacts(account_id, zalo_uid) WHERE zalo_uid IS NOT NULL;
            CREATE TABLE IF NOT EXISTS contact_tags (
                contact_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY (contact_id, tag)
            );
            CREATE TABLE IF NOT EXISTS leads (
                id TEXT PRIMARY KEY,
                contact_id TEXT,
                title TEXT NOT NULL,
                stage TEXT NOT NULL DEFAULT 'new',
                value REAL DEFAULT 0,
                currency TEXT DEFAULT 'VND',
                expected_close INTEGER,
                product TEXT,
                source TEXT,
                assignee TEXT,
                loss_reason TEXT,
                next_action TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
            CREATE TABLE IF NOT EXISTS lead_stage_history (
                id TEXT PRIMARY KEY,
                lead_id TEXT NOT NULL,
                from_stage TEXT,
                to_stage TEXT NOT NULL,
                actor TEXT,
                at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lead_history_lead ON lead_stage_history(lead_id, at);
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                note TEXT DEFAULT '',
                due_at INTEGER,
                done_at INTEGER,
                contact_id TEXT,
                lead_id TEXT,
                assignee TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
            CREATE TABLE IF NOT EXISTS crm_audit_logs (
                id TEXT PRIMARY KEY,
                actor TEXT,
                action TEXT NOT NULL,
                target TEXT,
                detail TEXT,
                at INTEGER NOT NULL
            );
        `,
    },
    {
        version: 3,
        name: 'crm-group-links',
        // CRM v2 không có đường nào trỏ tới NHÓM Zalo: khách hàng, deal, việc đều đứng rời khỏi thứ
        // duy nhất bot đang quan sát được. Nên nó chỉ là một sổ tay gõ tay, không dùng được dữ liệu
        // sẵn có. Bảng nối riêng (không phải cột trên contacts) vì một khách có mặt ở NHIỀU nhóm.
        //
        // `group_name` là bản sao có chủ ý: CRM phải hiển thị được tên nhóm kể cả khi danh sách nhóm
        // chưa nạp hoặc bot đã rời nhóm đó. Nó là nhãn tại thời điểm nối, làm mới mỗi lần nối lại.
        sql: `
            CREATE TABLE IF NOT EXISTS contact_groups (
                contact_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                group_name TEXT,
                linked_at INTEGER NOT NULL,
                PRIMARY KEY (contact_id, group_id)
            );
            CREATE INDEX IF NOT EXISTS idx_contact_groups_group ON contact_groups(group_id);
            ALTER TABLE leads ADD COLUMN group_id TEXT;
            ALTER TABLE tasks ADD COLUMN group_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_leads_group ON leads(group_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id);
        `,
    },
];

/**
 * Chạy các migration chưa áp dụng. Trả về số migration đã chạy.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function runMigrations(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
    );`);
    const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
    const applied = new Set(appliedRows.map(r => r.version));
    let count = 0;
    const mark = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
    for (const m of MIGRATIONS) {
        if (applied.has(m.version)) continue;
        db.exec('BEGIN');
        try {
            db.exec(m.sql);
            mark.run(m.version, m.name, Date.now());
            db.exec('COMMIT');
            count++;
        } catch (e) {
            db.exec('ROLLBACK');
            throw new Error(`Migration v${m.version} (${m.name}) failed: ${e.message}`);
        }
    }
    return count;
}
