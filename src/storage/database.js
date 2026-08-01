/**
 * Storage — SQLite (node:sqlite, Node >= 22.5) với migration framework.
 *
 * Nếu node:sqlite không khả dụng (Node 20/21), trả về store in-memory cùng
 * interface — passive context vẫn hoạt động qua RAM buffer, chỉ mất persistence.
 * Không thêm dependency ngoài.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runMigrations, MIGRATIONS } from './migrations.js';

const requireBuiltin = createRequire(import.meta.url);

/**
 * @param {string} filePath đường dẫn file .db (hoặc ':memory:')
 * @param {{ logger?: {info?:Function, warn?:Function} }} [opts]
 * @returns {SqliteStore|MemoryStore}
 */
export function openStore(filePath, opts = {}) {
    const logger = opts.logger || console;
    let DatabaseSync;
    try {
        ({ DatabaseSync } = requireBuiltin('node:sqlite'));
    } catch (e) {
        logger.warn?.(`[zalo-mod] node:sqlite unavailable (${e.message}) — dùng in-memory store, không persist.`);
        return new MemoryStore();
    }
    try {
        if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true });
        const db = new DatabaseSync(filePath);
        db.exec('PRAGMA journal_mode = WAL;');
        const applied = runMigrations(db);
        if (applied > 0) logger.info?.(`[zalo-mod] storage: applied ${applied} migration(s), schema v${MIGRATIONS.length}`);
        return new SqliteStore(db);
    } catch (e) {
        logger.warn?.(`[zalo-mod] không mở được SQLite tại ${filePath} (${e.message}) — dùng in-memory store.`);
        return new MemoryStore();
    }
}

/** Interface chung cho SqliteStore & MemoryStore. */
export class SqliteStore {
    constructor(db) {
        this.db = db;
        this.kind = 'sqlite';
        this._insMsg = db.prepare(`INSERT OR REPLACE INTO messages
            (id, conversation_id, sender_id, sender_name, text, raw_type, sent_at, quote_id, from_self, media_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        this._insTurn = db.prepare(`INSERT OR REPLACE INTO turn_contexts
            (id, message_id, sender_id, snapshot_json, status, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`);
        this._updTurn = db.prepare(`UPDATE turn_contexts SET status = ? WHERE id = ?`);
        this._selTurnsByStatus = db.prepare(`SELECT * FROM turn_contexts WHERE status = ?`);
        this._delExpired = db.prepare(`DELETE FROM messages WHERE sent_at < ?`);
        this._selRecent = db.prepare(`SELECT * FROM messages WHERE conversation_id = ?
            ORDER BY sent_at DESC LIMIT ?`);
        this._upsertConv = db.prepare(`INSERT INTO conversations (id, account_id, group_id, type, title, last_message_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET last_message_at = excluded.last_message_at,
                title = COALESCE(excluded.title, conversations.title)`);
    }

    upsertConversation({ id, accountId, groupId, type, title, lastMessageAt }) {
        this._upsertConv.run(id, accountId, groupId ?? null, type, title ?? null, lastMessageAt ?? Date.now());
    }

    insertMessage({ id, conversationId, senderId, senderName, text, rawType, sentAt, quoteId, fromSelf, mediaUrls }) {
        this._insMsg.run(id, conversationId, senderId, senderName ?? '', text ?? '',
            rawType ?? 'message', sentAt ?? Date.now(), quoteId ?? null,
            fromSelf ? 1 : 0, mediaUrls?.length ? JSON.stringify(mediaUrls) : null);
    }

    /**
     * Ghi một LÔ tin trong MỘT transaction.
     *
     * Kéo lịch sử về là hàng trăm tin mỗi lô; ghi từng tin thì mỗi lần là một transaction ngầm của
     * SQLite, tức mỗi tin một lần fsync. Gói lại một transaction là khác biệt giữa vài mili-giây và
     * vài giây.
     *
     * `INSERT OR REPLACE` theo `id` nên kéo lại lần hai không nhân đôi — điều kiện để owner bấm
     * "lấy lịch sử" bao nhiêu lần cũng được.
     */
    insertMessages(rows) {
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) return 0;
        this.db.exec('BEGIN');
        try {
            for (const r of list) this.insertMessage(r);
            this.db.exec('COMMIT');
            return list.length;
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }

    recentMessages(conversationId, limit = 50) {
        return this._selRecent.all(conversationId, limit).reverse();
    }

    /** Danh sách hội thoại, mới nhất trước — cột trái của khung chat. */
    listConversations({ accountId, limit = 100 } = {}) {
        const where = accountId ? 'WHERE account_id = ?' : '';
        const params = accountId ? [accountId] : [];
        return this.db.prepare(`SELECT c.*,
                (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_text,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
            FROM conversations c ${where}
            ORDER BY c.last_message_at DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 100, 500));
    }

    saveTurn(turn, status = 'open') {
        this._insTurn.run(turn.turnId, turn.inboundMessageId, turn.senderId,
            JSON.stringify(turn), status, turn.receivedAt, turn.receivedAt + 10 * 60 * 1000);
    }

    setTurnStatus(turnId, status) {
        this._updTurn.run(status, turnId);
    }

    /** Turn dở dang sau restart → caller đánh dấu failed (plan §5.3). */
    openTurns() {
        return this._selTurnsByStatus.all('open').map(r => ({ ...JSON.parse(r.snapshot_json), status: r.status }));
    }

    pruneMessagesOlderThan(ts) {
        this._delExpired.run(ts);
    }

    close() {
        this.db.close();
    }
}

/** Fallback in-memory với cùng interface (không persist qua restart). */
export class MemoryStore {
    constructor() {
        this.kind = 'memory';
        this._messages = new Map(); // conversationId -> array
        this._turns = new Map();
        this._convs = new Map();
    }
    upsertConversation(c) { this._convs.set(c.id, c); }
    insertMessage(m) {
        const arr = this._messages.get(m.conversationId) || [];
        const idx = arr.findIndex(x => x.id === m.id);
        if (idx >= 0) arr[idx] = m; else arr.push(m);
        this._messages.set(m.conversationId, arr.slice(-500));
    }
    insertMessages(rows) {
        const list = Array.isArray(rows) ? rows : [];
        for (const r of list) this.insertMessage(r);
        return list.length;
    }
    recentMessages(conversationId, limit = 50) {
        return (this._messages.get(conversationId) || []).slice(-limit);
    }
    listConversations({ accountId, limit = 100 } = {}) {
        return [...this._convs.values()]
            .filter(c => !accountId || c.accountId === accountId)
            .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
            .slice(0, limit);
    }
    saveTurn(turn, status = 'open') { this._turns.set(turn.turnId, { ...turn, status }); }
    setTurnStatus(turnId, status) {
        const t = this._turns.get(turnId);
        if (t) t.status = status;
    }
    openTurns() { return [...this._turns.values()].filter(t => t.status === 'open'); }
    pruneMessagesOlderThan(ts) {
        for (const [k, arr] of this._messages) {
            this._messages.set(k, arr.filter(m => (m.sentAt ?? 0) >= ts));
        }
    }
    close() {}
}
