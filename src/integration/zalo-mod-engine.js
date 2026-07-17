/**
 * ZaloModEngine — facade duy nhất mà index.js gọi cho Z0–Z2:
 *
 *   - Passive capture (zero-token) vào ConversationBuffer + SQLite.
 *   - TurnContext bất biến cho mỗi lượt mention + FIFO correlation
 *     (thay pattern mutable "ghi lúc dispatch, đọc lúc reply" theo sessionKey).
 *   - Inject bounded UNTRUSTED context vào prompt ở before_model_resolve.
 *   - Owner-claim bằng one-time code (vá lỗ hổng first-user-claim công khai).
 *
 * Mọi state nằm trong instance — không dùng globalThis (trừ handshake bridge
 * được định nghĩa bởi bridge contract v2).
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

import { TurnContextStore } from '../context/turn-context.js';
import { ConversationBuffer } from '../context/conversation-buffer.js';
import { selectContext } from '../context/context-selector.js';
import { buildContextBlock, injectIntoPrompt } from '../context/prompt-injector.js';
import { ConversationQueue } from '../messaging/conversation-queue.js';
import { openStore } from '../storage/database.js';
import { CrmStore } from '../crm/crm-store.js';
import { createZaloConnectBridge } from './zalo-connect-bridge.js';
import { createOpenclawAdapter } from './openclaw-adapter.js';

const CLAIM_CODE_TTL_MS = 24 * 60 * 60 * 1000; // one-time code sống 24h rồi tự xoay
const SWEEP_INTERVAL_MS = 60 * 1000;

export function createZaloModEngine({ dataDir, logger, runtime, getConfig, config = {} }) {
    const log = logger || console;
    const storage = openStore(path.join(dataDir, 'context.db'), { logger: log });
    const buffer = new ConversationBuffer({ storage, maxPerConversation: config.bufferSize ?? 200 });
    const turnStore = new TurnContextStore();
    const queue = new ConversationQueue({
        defaultTimeoutMs: config.turnTimeoutMs ?? 120_000,
        onError: (err, meta) => log.warn?.(`[zalo-mod] turn queue error (${meta.label || meta.key}): ${err.message}`),
    });
    const adapter = createOpenclawAdapter({ logger: log, runtime, getConfig });
    const bridge = createZaloConnectBridge(adapter, { logger: log });

    // CRM core (Z4): cần SQLite thật; in-memory fallback thì CRM tắt (API trả 503).
    let crm = null;
    if (storage.kind === 'sqlite') {
        try {
            crm = new CrmStore(storage.db);
        } catch (e) {
            log.warn?.(`[zalo-mod] CRM disabled: ${e.message}`);
        }
    }

    // FIFO turn đang chờ inject/reply theo accountId|conversationId. An toàn hơn
    // hẳn map theo sessionKey ghi-đè: nhiều turn cùng conversation xếp hàng,
    // consume đúng thứ tự đến (relay của OpenClaw xử lý tuần tự per session).
    const pendingTurns = new Map(); // key -> Array<{ turnId, injected }>

    const sweepTimer = setInterval(() => turnStore.sweep(), SWEEP_INTERVAL_MS);
    if (sweepTimer.unref) sweepTimer.unref();

    // Restart recovery: turn 'open' từ phiên trước → failed, không chạy lại (tránh double-send).
    try {
        const open = storage.openTurns();
        for (const t of open) storage.setTurnStatus(t.turnId, 'failed');
        if (open.length) log.warn?.(`[zalo-mod] ${open.length} turn dở dang từ phiên trước → đánh dấu failed.`);
    } catch { /* store rỗng lần đầu */ }

    function convKey(accountId, conversationId) {
        return `${accountId || 'default'}|${conversationId}`;
    }

    return {
        bridge,
        storage,
        buffer,
        turnStore,
        queue,
        crm,

        /**
         * Ghi passive một tin group/DM được phép — gọi TRƯỚC mention gating.
         * Zero-token: chỉ RAM + SQLite. Không bao giờ throw (best-effort).
         */
        captureInbound({ accountId, conversationId, groupId, messageId, senderId, senderName, text, timestamp, rawType, quote }) {
            try {
                const acc = accountId || 'default';
                storage.upsertConversation?.({
                    id: convKey(acc, conversationId),
                    accountId: acc,
                    groupId: groupId || null,
                    type: groupId ? 'group' : 'dm',
                    lastMessageAt: timestamp || Date.now(),
                });
                return buffer.record({
                    accountId: acc,
                    conversationId,
                    messageId: messageId
                        || `derived:${senderId}:${timestamp || ''}:${hashLite(text || '')}`,
                    senderId,
                    senderName,
                    text: text || '',
                    timestamp: timestamp || Date.now(),
                    rawType: rawType || 'message',
                    quote,
                });
            } catch (e) {
                log.warn?.(`[zalo-mod] captureInbound bỏ qua: ${e.message}`);
                return null;
            }
        },

        /** Ghi nhận reply của bot (để selector cắt context tại đây). */
        captureBotReply(accountId, conversationId, text) {
            try {
                return buffer.record({
                    accountId: accountId || 'default',
                    conversationId,
                    messageId: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    senderId: 'bot',
                    senderName: 'BOT',
                    text: String(text || ''),
                    fromBot: true,
                    botSubstantiveReply: true,
                });
            } catch { return null; }
        },

        /**
         * Mở TurnContext cho một tin mention bot (trước khi cho lên LLM).
         * Danh tính người gửi đóng băng tại đây.
         */
        openTurn({ accountId, conversationId, groupId, messageId, senderId, senderName, timestamp, quote }) {
            const acc = accountId || 'default';
            const turn = turnStore.create({
                accountId: acc,
                conversationId,
                groupId,
                inboundMessageId: messageId
                    || `derived:${senderId}:${timestamp || ''}`,
                senderId,
                senderName,
                receivedAt: timestamp || Date.now(),
                mentionedBot: true,
                quotedMessageId: quote?.messageId,
                quotedSenderId: quote?.senderId,
            });
            try { storage.saveTurn(turn, 'open'); } catch { }
            const key = convKey(acc, conversationId);
            if (!pendingTurns.has(key)) pendingTurns.set(key, []);
            pendingTurns.get(key).push({ turnId: turn.turnId, injected: false });
            return turn;
        },

        /**
         * Inject bounded context vào event.prompt tại before_model_resolve.
         * Correlate FIFO: lấy turn chờ lâu nhất chưa inject của conversation.
         * Trả về turn đã dùng (hoặc null nếu không inject).
         */
        injectContext(event, { accountId, conversationId, sessionKey, senderId }) {
            if (!conversationId || typeof event?.prompt !== 'string') return null;
            const acc = accountId || 'default';
            const key = convKey(acc, conversationId);

            // Correlate: turn FIFO đầu tiên chưa inject. Prune entry "chết"
            // (turn đã bị TTL sweep — vd LLM lỗi, không bao giờ có reply) để một
            // turn bỏ rơi không bao giờ gán nhầm trigger-sender cho lượt sau.
            let turn = null;
            const pend = pendingTurns.get(key) || [];
            for (let i = 0; i < pend.length; i++) {
                if (!turnStore.getByTurnId(pend[i].turnId)) {
                    pend.splice(i--, 1);
                }
            }
            const entry = pend.find(p => !p.injected);
            if (entry) {
                entry.injected = true;
                turn = turnStore.getByTurnId(entry.turnId) || null;
            }
            if (pend.length === 0) pendingTurns.delete(key);
            // Fallback (deployment mà before_dispatch không fire cho runtime plugin):
            // không có turn — vẫn inject theo senderId từ ctx nếu có.
            const triggerSenderId = turn?.senderId ?? (senderId != null ? String(senderId) : '');
            if (!triggerSenderId) return null;

            if (sessionKey && turn) turnStore.bindSession(sessionKey, turn.turnId);

            const records = selectContext(
                buffer.recent(acc, conversationId),
                {
                    triggerSenderId,
                    triggerMessageId: turn?.inboundMessageId,
                    now: Date.now(),
                },
                config.selector || {},
            );
            // Chỉ inject khi có nhiều hơn chính tin kích hoạt.
            const meaningful = records.filter(r => r.messageId !== turn?.inboundMessageId);
            if (meaningful.length === 0) return turn;

            const ctxBlock = buildContextBlock(records, { charBudget: config.contextCharBudget });
            if (!ctxBlock) return turn;
            if (!event.prompt.includes('[UNTRUSTED RECENT GROUP CONTEXT]')) {
                event.prompt = injectIntoPrompt(event.prompt, ctxBlock.block);
                log.info?.(`[zalo-mod] context injected: ${ctxBlock.includedCount} tin (${ctxBlock.droppedCount} bị cắt do budget) cho ${key}`);
            }
            if (turn) {
                this.lastContextByTurn.set(turn.turnId, {
                    block: ctxBlock.block,
                    count: ctxBlock.includedCount,
                    at: Date.now(),
                });
                if (this.lastContextByTurn.size > 100) {
                    const first = this.lastContextByTurn.keys().next().value;
                    this.lastContextByTurn.delete(first);
                }
            }
            return turn;
        },

        /** Panel debug "Context used by bot" cho dashboard. */
        lastContextByTurn: new Map(),

        /**
         * Đóng turn khi reply xong (before_agent_reply / message_sent).
         * Consume FIFO entry đã inject lâu nhất của conversation.
         */
        completeTurn({ accountId, conversationId, sessionKey, replyText }) {
            const acc = accountId || 'default';
            const key = convKey(acc, conversationId);
            let turn = sessionKey ? turnStore.getBySession(sessionKey) : null;
            const pend = pendingTurns.get(key) || [];
            for (let i = 0; i < pend.length; i++) {
                if (!turnStore.getByTurnId(pend[i].turnId)) pend.splice(i--, 1);
            }
            if (!turn) {
                const entry = pend.find(p => p.injected) || pend[0];
                if (entry) turn = turnStore.getByTurnId(entry.turnId);
            }
            if (!turn) return null;
            const idx = pend.findIndex(p => p.turnId === turn.turnId);
            if (idx >= 0) pend.splice(idx, 1);
            if (pend.length === 0) pendingTurns.delete(key);
            turnStore.complete(turn.turnId);
            try { storage.setTurnStatus(turn.turnId, 'done'); } catch { }
            if (replyText) this.captureBotReply(acc, conversationId, replyText);
            return turn;
        },

        // ── Owner claim: one-time expiring code (vá first-user-claim công khai) ──

        /**
         * Lấy code claim hiện hành (tạo mới nếu chưa có/hết hạn). Code chỉ hiển thị
         * ở nơi owner thật tiếp cận được: log gateway + dashboard localhost.
         */
        getOwnerClaimCode() {
            const file = path.join(dataDir, 'owner-claim-code.json');
            try {
                if (existsSync(file)) {
                    const cur = JSON.parse(readFileSync(file, 'utf8'));
                    if (cur.code && cur.expiresAt > Date.now()) return cur;
                }
            } catch { }
            const fresh = {
                code: crypto.randomBytes(4).toString('hex').toUpperCase(),
                expiresAt: Date.now() + CLAIM_CODE_TTL_MS,
            };
            try { writeFileSync(file, JSON.stringify(fresh), { mode: 0o600 }); } catch { }
            return fresh;
        },

        /** Verify + consume: đúng code thì xoá file (one-time). */
        verifyOwnerClaimCode(code) {
            if (!code) return false;
            const file = path.join(dataDir, 'owner-claim-code.json');
            try {
                if (!existsSync(file)) return false;
                const cur = JSON.parse(readFileSync(file, 'utf8'));
                const ok = cur.code
                    && cur.expiresAt > Date.now()
                    && timingSafeEqualStr(String(code).trim().toUpperCase(), cur.code);
                if (ok) { try { unlinkSync(file); } catch { } }
                return ok;
            } catch { return false; }
        },

        /** Health snapshot cho dashboard. */
        health() {
            return {
                storage: storage.kind,
                bufferConversations: buffer.conversationCount,
                openTurns: turnStore.size,
                queues: queue.stats(),
            };
        },

        shutdown() {
            clearInterval(sweepTimer);
            try { storage.close(); } catch { }
        },
    };
}

function hashLite(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

function timingSafeEqualStr(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}
