/**
 * ZaloConnectBridge — lớp tích hợp DUY NHẤT giữa Zalo Mod và ZaloConnect.
 *
 * Contract (product plan §4):
 *   getStatus(accountId)        -> Promise<ConnectionStatus>
 *   getCapabilities(accountId)  -> Promise<Capabilities>
 *   execute(accountId, action)  -> Promise<T>
 *   onInbound(handler)          -> Unsubscribe
 *   onGroupEvent(handler)       -> Unsubscribe
 *
 * Bridge KHÔNG import private dist của ZaloConnect. Transport thật được inject
 * qua `adapter` (implement bởi runtime-adapter dựa trên plugin SDK public);
 * test dùng MockZaloConnectAdapter cùng interface.
 *
 * Không module nào được đọc mutable global "lastSender" — mọi identity đi qua
 * NormalizedInboundEvent / TurnContext.
 */

/** Các action ZaloConnect mà Zalo Mod cần cho Z1/Z2. */
export const REQUIRED_ACTIONS = Object.freeze([
    'send-message',
    'group-mention',
    'add-reaction',
    'send-sticker',
    'search-stickers',
    'send-styled',
    'send-file',
    'send-image',
]);

/** Suy ra capability map từ danh sách action names runtime công bố. */
export function deriveCapabilities(actionNames = []) {
    const set = new Set(actionNames);
    // Chấp nhận cả vocabulary của tool zalo-connect ('send', 'image',
    // 'remove-from-group'...) lẫn tên chuẩn của bridge contract.
    return {
        connection: true,
        mention: set.has('group-mention') || set.has('send'),
        sticker: set.has('send-sticker') && set.has('search-stickers'),
        reaction: set.has('add-reaction'),
        quoteReply: set.has('send-message') || set.has('group-mention') || set.has('send'),
        styledText: set.has('send-styled'),
        sendFile: set.has('send-file'),
        sendImage: set.has('send-image') || set.has('image'),
        groupAdmin: set.has('remove-group-member') || set.has('group-kick') || set.has('remove-from-group'),
        passiveHistory: true, // Zalo Mod tự capture, không phụ thuộc action
    };
}

/**
 * Chuẩn hoá event thô (từ hook before_dispatch của OpenClaw hoặc event stream
 * của ZaloConnect) về NormalizedInboundEvent. Trả null nếu thiếu trường bắt buộc.
 *
 * @param {object} raw { event, ctx } như before_dispatch nhận được
 */
export function normalizeInboundEvent(raw) {
    const { event = {}, ctx = {} } = raw || {};
    const accountId = ctx.accountId ?? event.accountId ?? 'default';
    const conversationId = ctx.conversationId ?? event.conversationId;
    const senderId = ctx.senderId ?? event.senderId ?? event.uidFrom;
    const messageId = event.messageId ?? event.msgId ?? event.cliMsgId
        ?? ctx.messageId ?? null;
    if (!conversationId || senderId == null) return null;

    const isGroup = ctx.isGroup ?? event.isGroup
        ?? String(conversationId).includes('group')
        ?? false;
    const senderName = event.senderName || event.sender?.name || event.dName
        || event.data?.dName || '';
    const text = typeof event.body === 'string' ? event.body
        : (typeof event.content === 'string' ? event.content : '');

    const mentions = Array.isArray(event.mentions)
        ? event.mentions.map(m => ({
            userId: String(m.uid ?? m.userId ?? m.id ?? ''),
            displayName: m.displayName ?? m.dName ?? m.name ?? '',
        })).filter(m => m.userId)
        : [];

    let quote;
    const q = event.quote || event.quoteMsg || event.data?.quote;
    if (q) {
        quote = {
            messageId: q.messageId != null ? String(q.messageId)
                : (q.globalMsgId != null ? String(q.globalMsgId) : undefined),
            senderId: q.senderId != null ? String(q.senderId)
                : (q.ownerId != null ? String(q.ownerId) : undefined),
            text: q.text ?? q.msg ?? undefined,
        };
    }

    const attachments = Array.isArray(event.attachments)
        ? event.attachments.map(a => ({
            kind: a.kind ?? a.type ?? 'file',
            filename: a.filename ?? a.fileName ?? a.title ?? '',
            mime: a.mime ?? a.mimeType ?? '',
            size: a.size ?? a.fileSize ?? 0,
            url: a.url ?? a.href ?? undefined,
        }))
        : [];

    return Object.freeze({
        accountId: String(accountId),
        conversationId: String(conversationId),
        groupId: isGroup ? String(ctx.groupId ?? event.groupId ?? conversationId) : undefined,
        isGroup: !!isGroup,
        // messageId bắt buộc cho correlation; nếu runtime không cấp thì derive
        // ổn định từ nội dung + thời điểm để vẫn dedupe/correlate được.
        messageId: messageId != null ? String(messageId)
            : `derived:${senderId}:${event.timestamp ?? ''}:${hashLite(text)}`,
        senderId: String(senderId),
        senderName,
        text,
        mentions,
        quote,
        attachments,
        timestamp: Number(event.timestamp ?? event.ts ?? Date.now()),
        rawType: event.type ?? event.rawType ?? 'message',
    });
}

function hashLite(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

/**
 * @param {object} adapter transport thật hoặc mock:
 *   { getStatus(accountId), listActions(accountId), executeAction(accountId, action),
 *     subscribeInbound(cb), subscribeGroupEvents(cb) }
 * @param {{ logger?: object }} [opts]
 */
export function createZaloConnectBridge(adapter, opts = {}) {
    if (!adapter) throw new Error('createZaloConnectBridge: adapter is required');
    const logger = opts.logger || console;
    const inboundHandlers = new Set();
    const groupHandlers = new Set();
    let inboundUnsub = null;
    let groupUnsub = null;

    async function dispatchSafe(handlers, event, kind) {
        let handled = false;
        for (const h of handlers) {
            try {
                const outcome = await h(event);
                if (outcome === true || outcome?.handled === true) handled = true;
            } catch (e) {
                logger.warn?.(`[zalo-mod] bridge ${kind} handler error: ${e.message}`);
            }
        }
        return handled;
    }

    return {
        async getStatus(accountId) {
            return adapter.getStatus(accountId);
        },

        async getCapabilities(accountId) {
            const names = await adapter.listActions(accountId);
            return deriveCapabilities(names);
        },

        /**
         * Thực thi một ZaloConnect action. `action` = { action: string, ...params }.
         * Ném BridgeActionError khi runtime từ chối/không hỗ trợ.
         */
        async execute(accountId, action) {
            if (!action?.action) throw new BridgeActionError('missing action name', action);
            try {
                return await adapter.executeAction(accountId, action);
            } catch (e) {
                throw new BridgeActionError(e.message, action, e);
            }
        },

        /**
         * Apply free/silent/mute inside ZaloConnect's inbound listener. This is a
         * runtime override: no openclaw.json write, no gateway restart, and
         * mute/silent are enforced before relay/model token usage.
         */
        async setGroupPolicy(accountId, groupId, mode) {
            if (!['free', 'silent', 'mute'].includes(mode)) {
                throw new Error(`invalid group mode: ${String(mode)}`);
            }
            if (!groupId) throw new Error('groupId required');
            if (typeof adapter.setGroupPolicy !== 'function') {
                throw new Error('adapter does not support live group policy');
            }
            return adapter.setGroupPolicy(accountId, String(groupId), mode);
        },

        async getGroupPolicy(accountId, groupId) {
            if (typeof adapter.getGroupPolicy !== 'function') return undefined;
            return adapter.getGroupPolicy(accountId, String(groupId));
        },

        /**
         * Silent-mode name gate. Read the bot's own Zalo display name (auto) plus
         * the runtime alias overrides that let a silent-mode bot answer when
         * addressed by name (besides @mention). Needs zalo-connect bridge ≥ v4.
         */
        async getNameTriggers(accountId) {
            if (typeof adapter.getNameTriggers !== 'function') {
                throw new Error('adapter does not support name triggers');
            }
            return adapter.getNameTriggers(accountId);
        },

        /**
         * Replace the runtime alias overrides for an account. Runtime-only inside
         * zalo-connect (no openclaw.json write, no gateway restart); persistence
         * lives in Zalo Mod settings and is replayed on boot.
         */
        async setNameTriggers(accountId, triggers) {
            if (typeof adapter.setNameTriggers !== 'function') {
                throw new Error('adapter does not support name triggers');
            }
            return adapter.setNameTriggers(accountId, Array.isArray(triggers) ? triggers : []);
        },

        onInbound(handler) {
            inboundHandlers.add(handler);
            if (!inboundUnsub && adapter.subscribeInbound) {
                inboundUnsub = adapter.subscribeInbound(async (raw) => {
                    const ev = raw.accountId && raw.messageId ? raw : normalizeInboundEvent(raw);
                    if (ev) return dispatchSafe(inboundHandlers, ev, 'inbound');
                    return false;
                });
            }
            return () => {
                inboundHandlers.delete(handler);
                if (inboundHandlers.size === 0 && inboundUnsub) {
                    inboundUnsub();
                    inboundUnsub = null;
                }
            };
        },

        onGroupEvent(handler) {
            groupHandlers.add(handler);
            if (!groupUnsub && adapter.subscribeGroupEvents) {
                groupUnsub = adapter.subscribeGroupEvents(async (ev) => {
                    await dispatchSafe(groupHandlers, ev, 'group');
                });
            }
            return () => {
                groupHandlers.delete(handler);
                if (groupHandlers.size === 0 && groupUnsub) {
                    groupUnsub();
                    groupUnsub = null;
                }
            };
        },
    };
}

export class BridgeActionError extends Error {
    constructor(message, action, cause) {
        super(`ZaloConnect action failed: ${message}`);
        this.name = 'BridgeActionError';
        this.action = action;
        this.cause = cause;
    }
}
