/**
 * TurnContext — immutable per-message context for agent-triggering turns.
 *
 * Mỗi tin nhắn kích hoạt agent tạo ra MỘT TurnContext đóng băng (Object.freeze).
 * Mọi thông tin người gửi (senderId/senderName) khi trả lời PHẢI đọc từ turn,
 * không bao giờ đọc từ state mutable cấp group (nguồn bug A/B cross-tag).
 *
 * Indexes:
 *   - turnId -> TurnContext
 *   - sessionKey (session/run id do OpenClaw cấp) -> turnId
 *   - accountId|conversationId|inboundMessageId -> turnId (fallback)
 *
 * TTL: turn hoàn tất được giữ thêm một recovery window rồi mới xoá.
 */

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;        // turn chưa hoàn tất: 10 phút
const DEFAULT_RECOVERY_MS = 2 * 60 * 1000;    // sau complete: giữ thêm 2 phút

export function messageKey(accountId, conversationId, inboundMessageId) {
    return `${accountId}|${conversationId}|${inboundMessageId}`;
}

export class TurnContextStore {
    /**
     * @param {object} [opts]
     * @param {() => number} [opts.now] clock injectable cho test
     * @param {number} [opts.ttlMs]
     * @param {number} [opts.recoveryMs]
     */
    constructor(opts = {}) {
        this._now = opts.now || Date.now;
        this._ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
        this._recoveryMs = opts.recoveryMs ?? DEFAULT_RECOVERY_MS;
        this._byTurnId = new Map();
        this._bySession = new Map();
        this._byMessage = new Map();
        this._expiry = new Map(); // turnId -> expireAt
    }

    /**
     * Tạo TurnContext bất biến cho một tin nhắn kích hoạt agent.
     * @returns {Readonly<object>} turn đã freeze
     */
    create(fields) {
        const required = ['accountId', 'conversationId', 'inboundMessageId', 'senderId'];
        for (const f of required) {
            if (fields[f] === undefined || fields[f] === null || fields[f] === '') {
                throw new Error(`TurnContext missing required field: ${f}`);
            }
        }
        const receivedAt = fields.receivedAt ?? this._now();
        const turn = Object.freeze({
            turnId: fields.turnId || crypto.randomUUID(),
            accountId: String(fields.accountId),
            conversationId: String(fields.conversationId),
            groupId: fields.groupId != null ? String(fields.groupId) : undefined,
            inboundMessageId: String(fields.inboundMessageId),
            senderId: String(fields.senderId),
            senderName: fields.senderName || '',
            receivedAt,
            mentionedBot: !!fields.mentionedBot,
            quotedMessageId: fields.quotedMessageId != null ? String(fields.quotedMessageId) : undefined,
            quotedSenderId: fields.quotedSenderId != null ? String(fields.quotedSenderId) : undefined,
            contextSnapshotId: fields.contextSnapshotId,
        });
        this._byTurnId.set(turn.turnId, turn);
        this._byMessage.set(messageKey(turn.accountId, turn.conversationId, turn.inboundMessageId), turn.turnId);
        this._expiry.set(turn.turnId, receivedAt + this._ttlMs);
        return turn;
    }

    /** Gắn session/run id của OpenClaw vào turn (khi runtime expose). */
    bindSession(sessionId, turnId) {
        if (!sessionId || !this._byTurnId.has(turnId)) return false;
        this._bySession.set(String(sessionId), turnId);
        return true;
    }

    getByTurnId(turnId) {
        return this._byTurnId.get(turnId);
    }

    getBySession(sessionId) {
        const turnId = this._bySession.get(String(sessionId));
        return turnId ? this._byTurnId.get(turnId) : undefined;
    }

    /** Fallback lookup theo accountId + conversationId + messageId. */
    getByMessage(accountId, conversationId, inboundMessageId) {
        const turnId = this._byMessage.get(messageKey(accountId, conversationId, inboundMessageId));
        return turnId ? this._byTurnId.get(turnId) : undefined;
    }

    /**
     * Lấy turn ĐANG mở gần nhất của một conversation (cứu cánh cuối cùng khi
     * không có session id lẫn message id — chỉ an toàn vì queue đã serialize
     * mỗi conversation chỉ chạy 1 turn tại một thời điểm).
     */
    getOpenTurnForConversation(accountId, conversationId) {
        let latest;
        for (const turn of this._byTurnId.values()) {
            if (turn.accountId !== accountId || turn.conversationId !== conversationId) continue;
            if (this._completed?.has(turn.turnId)) continue;
            if (!latest || turn.receivedAt > latest.receivedAt) latest = turn;
        }
        return latest;
    }

    /** Đánh dấu turn xong; giữ lại trong recovery window rồi sweep xoá. */
    complete(turnId) {
        if (!this._byTurnId.has(turnId)) return false;
        (this._completed ??= new Set()).add(turnId);
        this._expiry.set(turnId, this._now() + this._recoveryMs);
        return true;
    }

    /** Xoá các turn hết hạn. Gọi định kỳ hoặc sau mỗi lượt. */
    sweep(now = this._now()) {
        let removed = 0;
        for (const [turnId, expireAt] of this._expiry) {
            if (expireAt > now) continue;
            const turn = this._byTurnId.get(turnId);
            this._byTurnId.delete(turnId);
            this._expiry.delete(turnId);
            this._completed?.delete(turnId);
            if (turn) {
                this._byMessage.delete(messageKey(turn.accountId, turn.conversationId, turn.inboundMessageId));
            }
            for (const [sid, tid] of this._bySession) {
                if (tid === turnId) this._bySession.delete(sid);
            }
            removed++;
        }
        return removed;
    }

    get size() {
        return this._byTurnId.size;
    }
}
