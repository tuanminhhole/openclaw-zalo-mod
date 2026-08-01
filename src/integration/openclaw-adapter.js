/**
 * OpenclawZaloConnectAdapter — adapter thật cho ZaloConnectBridge, chạy trong OpenClaw.
 *
 * Thứ tự bind transport (mọi tier đều là interface CÔNG KHAI, không patch dist):
 *   1. `globalThis.__zaloConnectBridgeService` — service do zalo-connect expose theo
 *      bridge contract v2 (149 action đầy đủ).
 *   2. `runtime.channel.outbound.loadAdapter('zalo-connect')` — outbound adapter
 *      chính thức của OpenClaw plugin SDK (chính là đường relay core dùng để
 *      gửi reply). Phủ send-message / send-image / group-mention(text-based).
 *
 * Ghi chú tier 2: mention qua sendText là name-based — zalo-connect tự resolve
 * "@Tên" → UID qua group member cache (tên trùng nhau sẽ không gắn mention,
 * text vẫn gửi). Mention exact-UID array + sticker/reaction cần tier 1.
 */

const OUTBOUND_TIER_ACTIONS = new Set(['send-message', 'send-image', 'group-mention']);

/**
 * Dịch action chuẩn của bridge sang vocabulary của tool zalo-connect:
 *   send-message / group-mention → 'send' (tool tự resolve "@Tên"→UID khi isGroup)
 *   send-image                   → 'image'
 * Action khác giữ nguyên tên — caller dùng đúng tên tool zalo-connect (149 action).
 */
function translateForToolService(action) {
    switch (action.action) {
        case 'send-message':
        case 'group-mention':
            return {
                action: 'send',
                threadId: String(action.threadId),
                message: String(action.message ?? ''),
                isGroup: action.action === 'group-mention' ? true : !!action.isGroup,
            };
        case 'send-image':
            return {
                action: 'image',
                threadId: String(action.threadId),
                url: action.imageUrl,
                message: action.message || undefined,
                isGroup: !!action.isGroup,
            };
        default:
            return action;
    }
}

/**
 * Tool zalo-connect KHÔNG throw — lỗi trả về dạng data ({error:true} cho action lạ,
 * {success:false} cho send fail). Phải chuyển thành exception để caller không
 * tưởng nhầm đã gửi thành công (bug "bot câm không lỗi").
 */
function normalizeToolResult(result) {
    if (result && typeof result === 'object') {
        if (result.error === true) throw new Error(String(result.message || 'zalo-connect tool error'));
        if (result.success === false) throw new Error(String(result.error || 'zalo-connect send failed'));
        return { ok: true, messageId: result.msgId ?? result.messageId, raw: result };
    }
    return { ok: true, raw: result };
}

/**
 * @param {object} deps
 * @param {object} [deps.logger]
 * @param {object} [deps.runtime] api.runtime của OpenClaw plugin SDK
 * @param {() => object} [deps.getConfig] trả api.config (OpenClawConfig) cho outbound ctx
 * @param {() => object|null} [deps.getZaloConnectService] override cho test
 */
export function createOpenclawAdapter(deps = {}) {
    const logger = deps.logger || console;
    const runtime = deps.runtime || null;
    const getConfig = deps.getConfig || (() => ({}));
    const getService = deps.getZaloConnectService
        || (() => globalThis.__zaloConnectBridgeService || null);
    let warnedDegradedMention = false;
    let loggedBackend = '';
    let outboundAdapterPromise = null;

    function logBackendOnce(name) {
        if (loggedBackend === name) return;
        loggedBackend = name;
        logger.info?.(`[zalo-mod] bridge backend: ${name}`);
    }

    async function loadOutboundAdapter() {
        const load = runtime?.channel?.outbound?.loadAdapter;
        if (typeof load !== 'function') return null;
        if (!outboundAdapterPromise) {
            outboundAdapterPromise = Promise.resolve(load('zalo-connect')).catch((e) => {
                logger.warn?.(`[zalo-mod] loadAdapter('zalo-connect') lỗi: ${e.message}`);
                return null;
            });
        }
        return (await outboundAdapterPromise) || null;
    }

    async function executeViaOutbound(accountId, action) {
        const adapter = await loadOutboundAdapter();
        if (!adapter) return null;
        logBackendOnce('zalo-connect-outbound-adapter');

        if (action.action === 'group-mention' && !warnedDegradedMention) {
            warnedDegradedMention = true;
            logger.info?.('[zalo-mod] group-mention qua outbound adapter: zalo-connect resolve "@Tên"→UID theo tên (name-based). Mention exact-UID cần bridge service v2.');
        }

        const ctx = {
            cfg: getConfig() || {},
            to: String(action.threadId),
            text: String(action.message ?? ''),
            accountId: accountId || undefined,
            replyToId: action.quoteMessageId != null ? String(action.quoteMessageId) : undefined,
        };
        let result;
        if (action.action === 'send-image' && action.imageUrl && adapter.sendMedia) {
            result = await adapter.sendMedia({ ...ctx, mediaUrl: action.imageUrl });
        } else if (adapter.sendText) {
            result = await adapter.sendText(ctx);
        } else {
            return null;
        }
        if (result?.error) throw (result.error instanceof Error ? result.error : new Error(String(result.error)));
        return { ok: result?.ok !== false, messageId: result?.messageId || undefined };
    }

    return {
        async getStatus(accountId) {
            const svc = getService();
            if (svc?.getStatus) {
                logBackendOnce('zalo-connect-bridge-service');
                return svc.getStatus(accountId);
            }
            if (await loadOutboundAdapter()) {
                return { connected: true, backend: 'zalo-connect-outbound-adapter', accountId,
                    note: 'Send qua outbound adapter public; action nâng cao chờ bridge service.' };
            }
            return { connected: false, backend: 'unavailable', accountId,
                note: 'OpenClaw Zalo Connect chưa được cài hoặc chưa sẵn sàng.' };
        },

        async listActions(accountId) {
            const svc = getService();
            if (svc?.listActions) return svc.listActions(accountId);
            if (await loadOutboundAdapter()) return [...OUTBOUND_TIER_ACTIONS];
            return [];
        },

        async executeAction(accountId, action) {
            const svc = getService();
            if (svc?.executeAction) {
                logBackendOnce('zalo-connect-bridge-service');
                const result = await svc.executeAction(accountId, translateForToolService(action));
                return normalizeToolResult(result);
            }
            if (OUTBOUND_TIER_ACTIONS.has(action.action)) {
                const sent = await executeViaOutbound(accountId, action);
                if (sent) return sent;
            }
            throw new Error(`không có transport OpenClaw Zalo Connect cho action '${action.action}'`);
        },

        async setGroupPolicy(accountId, groupId, mode) {
            const svc = getService();
            if (typeof svc?.setGroupPolicy !== 'function') {
                throw new Error('zalo-connect bridge does not support live group policy');
            }
            logBackendOnce('zalo-connect-bridge-service');
            return svc.setGroupPolicy(accountId, String(groupId), mode);
        },

        async getGroupPolicy(accountId, groupId) {
            const svc = getService();
            if (typeof svc?.getGroupPolicy !== 'function') return undefined;
            return svc.getGroupPolicy(accountId, String(groupId));
        },

        async getNameTriggers(accountId) {
            const svc = getService();
            if (typeof svc?.getNameTriggers !== 'function') {
                throw new Error('zalo-connect bridge quá cũ (cần v4) cho name-trigger — hãy cập nhật OpenClaw Zalo Connect.');
            }
            logBackendOnce('zalo-connect-bridge-service');
            return svc.getNameTriggers(accountId);
        },

        async setNameTriggers(accountId, triggers) {
            const svc = getService();
            if (typeof svc?.setNameTriggers !== 'function') {
                throw new Error('zalo-connect bridge quá cũ (cần v4) cho name-trigger — hãy cập nhật OpenClaw Zalo Connect.');
            }
            logBackendOnce('zalo-connect-bridge-service');
            return svc.setNameTriggers(accountId, Array.isArray(triggers) ? triggers : []);
        },

        subscribeInbound(cb) {
            const svc = getService();
            if (svc?.subscribeInbound) return svc.subscribeInbound(cb);
            // Inbound đã đi qua hook before_dispatch của OpenClaw — không cần stream riêng.
            return () => {};
        },

        subscribeGroupEvents(cb) {
            const svc = getService();
            if (svc?.subscribeGroupEvents) return svc.subscribeGroupEvents(cb);
            return () => {};
        },

        /**
         * Lịch sử chat kéo về từ Zalo — chỉ có ở bridge contract v5 trở lên.
         *
         * Kiểm service lúc GỌI chứ không lúc dựng adapter: hai plugin nạp không đảm bảo thứ tự, nên
         * quyết định "có hỗ trợ hay không" ngay lúc khởi tạo sẽ khoá cứng thành "không" nếu hôm đó
         * zalo-mod nạp trước — và sẽ hỏng im lặng, không có lỗi nào để lần ra.
         *
         * Trả `null` (không phải hàm huỷ rỗng như hai hàm trên) khi runtime chưa hỗ trợ: bên gọi
         * cần phân biệt "có kênh nhưng chưa có tin" với "runtime này chưa có kênh", để UI nói đúng
         * là phải nâng cấp zalo-connect thay vì để owner ngồi chờ.
         */
        subscribeHistory(cb) {
            const svc = getService();
            if (typeof svc?.subscribeHistory !== 'function') return null;
            return svc.subscribeHistory(cb);
        },

        supportsHistory() {
            return typeof getService()?.subscribeHistory === 'function';
        },
    };
}
