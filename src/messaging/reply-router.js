/**
 * ReplyRouter — điều phối một lượt agent từ tin nhắn kích hoạt đến reply.
 *
 * Luồng chuẩn (diệt bug A/B cross-tag):
 *   1. Tin mention bot đến → tạo TurnContext BẤT BIẾN (senderId đóng băng ngay).
 *   2. Snapshot passive context bounded từ ConversationBuffer, gắn vào turn.
 *   3. Enqueue vào FIFO theo accountId+conversationId — cùng nhóm chạy tuần tự,
 *      nhóm khác song song.
 *   4. Agent chạy với context snapshot; reply xong build group-mention bằng
 *      UID TỪ TURN (không phải "người gửi gần nhất").
 *   5. complete(turn) + TTL cleanup.
 *
 * Timeout một lượt chỉ fail lượt đó — hàng vẫn chạy tiếp.
 */

import { TurnContextStore } from '../context/turn-context.js';
import { ConversationQueue, conversationKey } from './conversation-queue.js';
import { ConversationBuffer } from '../context/conversation-buffer.js';
import { selectContext } from '../context/context-selector.js';
import { buildContextBlock } from '../context/prompt-injector.js';
import { buildGroupMentionAction, buildMentionPayload } from './mention-builder.js';

export class ReplyRouter {
    /**
     * @param {object} deps
     * @param {object} deps.bridge ZaloConnectBridge
     * @param {object} [deps.turnStore]
     * @param {object} [deps.queue]
     * @param {object} [deps.buffer]
     * @param {object} [deps.storage] SqliteStore/MemoryStore (persist turn cho recovery)
     * @param {object} [deps.logger]
     * @param {object} [opts]
     * @param {'sender'|'quoted-author'|'all-addressed'|'off'} [opts.mentionPolicy='sender']
     * @param {number} [opts.turnTimeoutMs=120000]
     * @param {object} [opts.selector] override context-selector options
     * @param {number} [opts.contextCharBudget]
     */
    constructor(deps, opts = {}) {
        if (!deps?.bridge) throw new Error('ReplyRouter requires bridge');
        this.bridge = deps.bridge;
        this.turnStore = deps.turnStore || new TurnContextStore();
        this.buffer = deps.buffer || new ConversationBuffer();
        this.storage = deps.storage || null;
        this.logger = deps.logger || console;
        this.queue = deps.queue || new ConversationQueue({
            defaultTimeoutMs: opts.turnTimeoutMs ?? 120_000,
            onError: (err, meta) => this.logger.warn?.(
                `[zalo-mod] turn failed (${meta.label || meta.key}): ${err.message}`),
        });
        this.mentionPolicy = opts.mentionPolicy || 'sender';
        this.selectorOpts = opts.selector || {};
        this.contextCharBudget = opts.contextCharBudget;
        // Debug: snapshot context đã dùng cho từng turn (cho panel "Context used by bot").
        this.lastContextByTurn = new Map();
    }

    /**
     * Ghi tin nhắn vào passive buffer (gọi cho MỌI tin group được phép,
     * TRƯỚC mention gating — zero token).
     */
    capture(event) {
        return this.buffer.record(event);
    }

    /** Ghi nhận reply của bot vào buffer (để selector cắt tại bot reply). */
    captureBotReply(accountId, conversationId, text, { substantive = true } = {}) {
        return this.buffer.record({
            accountId,
            conversationId,
            messageId: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            senderId: 'bot',
            senderName: 'BOT',
            text,
            fromBot: true,
            botSubstantiveReply: substantive,
        });
    }

    /**
     * Xử lý một tin nhắn kích hoạt agent (đã qua mention gate).
     *
     * @param {object} event NormalizedInboundEvent
     * @param {(turn: object, context: {block:string|null, records:Array}) => Promise<string>} runAgent
     *   chạy lượt agent, trả text reply. Nhận turn bất biến + context snapshot.
     * @param {object} [opts]
     * @param {number} [opts.timeoutMs]
     * @param {'sender'|'quoted-author'|'all-addressed'|'off'} [opts.mentionPolicy]
     * @returns {Promise<{turn: object, response: string, sent: object|null}>}
     */
    async handleTriggeringMessage(event, runAgent, opts = {}) {
        // 1) Đóng băng danh tính NGAY khi nhận tin — trước mọi await.
        const turn = this.turnStore.create({
            accountId: event.accountId,
            conversationId: event.conversationId,
            groupId: event.groupId,
            inboundMessageId: event.messageId,
            senderId: event.senderId,
            senderName: event.senderName,
            receivedAt: event.timestamp,
            mentionedBot: true,
            quotedMessageId: event.quote?.messageId,
            quotedSenderId: event.quote?.senderId,
        });
        this.storage?.saveTurn?.(turn, 'open');

        // 2) Snapshot context tại thời điểm nhận tin (không trôi khi chờ queue).
        const records = selectContext(
            this.buffer.recent(event.accountId, event.conversationId, {
                maxAgeMs: this.selectorOpts.maxAgeMs,
            }),
            {
                triggerSenderId: event.senderId,
                triggerMessageId: event.messageId,
                now: event.timestamp,
            },
            this.selectorOpts,
        );
        const context = buildContextBlock(records, { charBudget: this.contextCharBudget });
        this.lastContextByTurn.set(turn.turnId, { records, block: context?.block ?? null });

        // 3) FIFO per-conversation.
        const key = conversationKey(event.accountId, event.conversationId);
        try {
            const result = await this.queue.enqueue(key, async () => {
                const response = await runAgent(turn, {
                    block: context?.block ?? null,
                    records,
                });
                const sent = await this._sendReply(turn, response, opts);
                return { turn, response, sent };
            }, { timeoutMs: opts.timeoutMs, label: `turn:${turn.turnId.slice(0, 8)}` });
            this.storage?.setTurnStatus?.(turn.turnId, 'done');
            return result;
        } catch (err) {
            this.storage?.setTurnStatus?.(turn.turnId, 'failed');
            throw err;
        } finally {
            this.turnStore.complete(turn.turnId);
            this.turnStore.sweep();
        }
    }

    async _sendReply(turn, response, opts = {}) {
        const text = String(response ?? '').trim();
        if (!text) return null;
        const policy = opts.mentionPolicy || this.mentionPolicy;

        let sent;
        if (turn.groupId && policy !== 'off') {
            const action = buildGroupMentionAction(turn, text, {
                policy,
                addressedUsers: opts.addressedUsers,
            });
            sent = await this.bridge.execute(turn.accountId, action);
        } else {
            const { message } = buildMentionPayload(turn, text, { policy: 'off' });
            sent = await this.bridge.execute(turn.accountId, {
                action: 'send-message',
                threadId: turn.conversationId,
                isGroup: !!turn.groupId,
                message,
                quoteMessageId: turn.inboundMessageId,
            });
        }
        this.captureBotReply(turn.accountId, turn.conversationId, text);
        return sent;
    }

    /**
     * Recovery sau restart: đánh dấu failed mọi turn còn 'open' trong storage
     * (plan §5.3 — không tự chạy lại để tránh double-send).
     */
    recoverUnfinishedTurns() {
        if (!this.storage?.openTurns) return 0;
        const open = this.storage.openTurns();
        for (const t of open) this.storage.setTurnStatus(t.turnId, 'failed');
        if (open.length) {
            this.logger.warn?.(`[zalo-mod] ${open.length} turn dở dang từ phiên trước → đánh dấu failed.`);
        }
        return open.length;
    }
}
