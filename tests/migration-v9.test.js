import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runMigrations, MIGRATIONS } from '../src/storage/migrations.js';

const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = requireBuiltin('node:sqlite');

/**
 * Dựng một DB "đã ở v8" giống context.db thật trên vps_asa trước khi P2 chạm vào — áp thủ công các
 * migration ≤8 rồi tự đánh dấu `schema_migrations`, KHÔNG gọi runMigrations() cho đoạn này. Mục đích:
 * kiểm v9 đúng như nó sẽ chạy trên một DB có sẵn dữ liệu, không phải trên DB rỗng mới tinh (khác hẳn
 * production, nơi bảng `tasks` đã có việc gõ tay từ lâu).
 */
function makeV8Db(filePath) {
    const db = new DatabaseSync(filePath);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);`);
    const mark = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
    for (const m of MIGRATIONS) {
        if (m.version > 8) continue;
        db.exec(m.sql);
        mark.run(m.version, m.name, Date.now());
    }
    return db;
}

function withTmpDb(fn) {
    const dir = mkdtempSync(path.join(tmpdir(), 'zalo-mod-migration-v9-'));
    const file = path.join(dir, 'context.db');
    try {
        return fn(file);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('v9: cột mới có mặt, task gõ tay CŨ đã done_at được suy ra status=done', () => {
    withTmpDb((file) => {
        const db = makeV8Db(file);
        // Task gõ tay từ trước migration — đúng dạng dữ liệu thật đang có trên vps_asa.
        db.exec(`INSERT INTO tasks (id, title, note, due_at, done_at, created_at, updated_at)
                 VALUES ('t-done', 'Việc cũ đã xong', '', NULL, 1000, 900, 1000)`);
        db.exec(`INSERT INTO tasks (id, title, note, due_at, done_at, created_at, updated_at)
                 VALUES ('t-open', 'Việc cũ chưa xong', '', NULL, NULL, 900, 900)`);

        const applied = runMigrations(db);
        assert.equal(applied, 1, 'chỉ v9 mới, v1-8 đã đánh dấu applied từ trước');

        const done = db.prepare('SELECT source, status FROM tasks WHERE id = ?').get('t-done');
        assert.equal(done.source, 'manual');
        assert.equal(done.status, 'done', 'done_at có giá trị → status suy ra done');
        const open = db.prepare('SELECT source, status FROM tasks WHERE id = ?').get('t-open');
        assert.equal(open.source, 'manual');
        assert.equal(open.status, 'todo', 'chưa done_at → giữ mặc định todo');

        db.close();
    });
});

test('v9: chạy migration HAI LẦN trên cùng file không lỗi, lần hai không áp lại gì', () => {
    withTmpDb((file) => {
        let db = new DatabaseSync(file);
        const first = runMigrations(db);
        assert.equal(first, MIGRATIONS.length, 'DB rỗng → áp hết mọi migration, kể cả v9');
        db.close();

        // Mở lại file (mô phỏng service restart) rồi chạy lại — đúng kịch bản thật khi service khởi động.
        db = new DatabaseSync(file);
        assert.doesNotThrow(() => runMigrations(db), 'chạy lần 2 trên DB đã ở v9 không được ném lỗi');
        const second = runMigrations(db);
        assert.equal(second, 0, 'lần 2 (và 3) không áp lại migration nào — đã applied hết');
        db.close();
    });
});

test('v9: dedupe_key là PARTIAL UNIQUE INDEX — việc gõ tay (NULL) không bị coi là trùng nhau', () => {
    withTmpDb((file) => {
        const db = makeV8Db(file);
        runMigrations(db);
        // Nhiều việc gõ tay cùng group_id, dedupe_key đều NULL — SQL không so NULL=NULL nên KHÔNG vi
        // phạm unique index, đúng ý đồ thiết kế (chỉ AI mới cần dedupe).
        assert.doesNotThrow(() => {
            db.exec(`INSERT INTO tasks (id, title, group_id, dedupe_key, created_at, updated_at)
                     VALUES ('m1', 'A', 'g1', NULL, 1, 1)`);
            db.exec(`INSERT INTO tasks (id, title, group_id, dedupe_key, created_at, updated_at)
                     VALUES ('m2', 'B', 'g1', NULL, 1, 1)`);
        });
        // Hai việc AI cùng group_id + cùng dedupe_key → VI PHẠM unique, đúng ý đồ chống trùng của AI.
        db.exec(`INSERT INTO tasks (id, title, group_id, dedupe_key, source, created_at, updated_at)
                 VALUES ('a1', 'X', 'g1', 'goi-dien-xac-nhan', 'ai', 1, 1)`);
        assert.throws(() => {
            db.exec(`INSERT INTO tasks (id, title, group_id, dedupe_key, source, created_at, updated_at)
                     VALUES ('a2', 'X lặp', 'g1', 'goi-dien-xac-nhan', 'ai', 1, 1)`);
        }, /UNIQUE/i);
        db.close();
    });
});
