/**
 * ConversationBuffer — capture thụ động mọi tin nhắn group TRƯỚC mention-gate.
 *
 * Zero-token: chỉ ghi vào bộ nhớ (và storage nếu gắn), tuyệt đối không gọi LLM.
 * Buffer là ring buffer per (accountId|conversationId), dedupe theo messageId,
 * tin edit (cùng messageId) thay thế bản cũ.
 */

const DEFAULT_MAX_PER_CONVERSATION = 200;

export class ConversationBuffer {
    /**
     * @param {object} [opts]
     * @param {number} [opts.maxPerConversation]
     * @param {() => number} [opts.now]
     * @param {{ insertMessage?: (rec: object) => void }} [opts.storage] persistence tuỳ chọn (SQLite)
     */
    constructor(opts = {}) {
        this._max = opts.maxPerConversation ?? DEFAULT_MAX_PER_CONVERSATION;
        this._now = opts.now || Date.now;
        this._storage = opts.storage || null;
        this._buffers = new Map(); // key -> Array<record>
    }

    static key(accountId, conversationId) {
        return `${accountId}|${conversationId}`;
    }

    /**
     * Ghi một NormalizedInboundEvent (hoặc tin bot tự gửi với fromBot=true).
     * @returns {object} record đã chuẩn hoá + đóng băng
     */
    record(event) {
        if (!event || !event.accountId || !event.conversationId || !event.messageId) {
            throw new Error('ConversationBuffer.record: thiếu accountId/conversationId/messageId');
        }
        const rec = Object.freeze({
            messageId: String(event.messageId),
            senderId: String(event.senderId ?? ''),
            senderName: event.senderName || '',
            text: typeof event.text === 'string' ? event.text : '',
            timestamp: event.timestamp ?? this._now(),
            rawType: event.rawType || 'message',
            fromBot: !!event.fromBot,
            botSubstantiveReply: !!event.botSubstantiveReply,
            quote: event.quote ? Object.freeze({
                messageId: event.quote.messageId != null ? String(event.quote.messageId) : undefined,
                senderId: event.quote.senderId != null ? String(event.quote.senderId) : undefined,
                text: event.quote.text,
            }) : undefined,
            attachments: Object.freeze((event.attachments || []).map(a => ({
                kind: a.kind, filename: a.filename, mime: a.mime, size: a.size,
            }))),
            reactions: event.reactions ? Object.freeze([...event.reactions]) : undefined,
        });

        const key = ConversationBuffer.key(event.accountId, event.conversationId);
        let buf = this._buffers.get(key);
        if (!buf) {
            buf = [];
            this._buffers.set(key, buf);
        }
        // Dedupe / edit-replace theo messageId (quét từ cuối — tin mới gần cuối).
        for (let i = buf.length - 1; i >= 0; i--) {
            if (buf[i].messageId === rec.messageId) {
                buf[i] = rec;
                this._persist(event, rec);
                return rec;
            }
        }
        buf.push(rec);
        if (buf.length > this._max) buf.splice(0, buf.length - this._max);
        this._persist(event, rec);
        return rec;
    }

    _persist(event, rec) {
        if (!this._storage?.insertMessage) return;
        try {
            this._storage.insertMessage({
                id: rec.messageId,
                conversationId: ConversationBuffer.key(event.accountId, event.conversationId),
                senderId: rec.senderId,
                senderName: rec.senderName,
                text: rec.text,
                rawType: rec.rawType,
                sentAt: rec.timestamp,
                quoteId: rec.quote?.messageId ?? null,
            });
        } catch {
            // Persistence là best-effort; buffer trong RAM vẫn là nguồn cho context.
        }
    }

    /**
     * Lấy các tin gần nhất (mặc định đã lọc theo tuổi), cũ → mới.
     * @param {string} accountId
     * @param {string} conversationId
     * @param {object} [opts]
     * @param {number} [opts.limit]
     * @param {number} [opts.maxAgeMs]
     * @param {number} [opts.now]
     */
    recent(accountId, conversationId, opts = {}) {
        const buf = this._buffers.get(ConversationBuffer.key(accountId, conversationId)) || [];
        const now = opts.now ?? this._now();
        let items = buf;
        if (opts.maxAgeMs) items = items.filter(r => now - r.timestamp <= opts.maxAgeMs);
        if (opts.limit && items.length > opts.limit) items = items.slice(-opts.limit);
        return [...items];
    }

    clear(accountId, conversationId) {
        this._buffers.delete(ConversationBuffer.key(accountId, conversationId));
    }

    get conversationCount() {
        return this._buffers.size;
    }
}
