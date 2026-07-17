/**
 * MockZaloConnectAdapter — adapter giả lập cho test, cùng interface với adapter thật.
 * Cho phép test toàn bộ bridge/turn/queue/mention mà không cần tài khoản Zalo.
 */

export class MockZaloConnectAdapter {
    constructor(opts = {}) {
        this.executed = [];                 // mọi action đã gọi, theo thứ tự
        this.actionNames = opts.actionNames || [
            'send-message', 'group-mention', 'add-reaction',
            'send-sticker', 'search-stickers', 'send-styled',
            'send-file', 'send-image',
        ];
        this.statusByAccount = opts.statusByAccount || {};
        this.executeDelayMs = opts.executeDelayMs ?? 0;
        this.failActions = new Set(opts.failActions || []);
        this._inboundCb = null;
        this._groupCb = null;
        this.groupPolicies = new Map();
    }

    async getStatus(accountId) {
        return this.statusByAccount[accountId]
            ?? { connected: true, accountId, lastInboundAt: null, lastOutboundAt: null };
    }

    async listActions() {
        return [...this.actionNames];
    }

    async executeAction(accountId, action) {
        if (this.executeDelayMs) await new Promise(r => setTimeout(r, this.executeDelayMs));
        if (this.failActions.has(action.action)) {
            throw new Error(`mock failure for ${action.action}`);
        }
        const record = { accountId, ...action, _at: this.executed.length };
        this.executed.push(record);
        return { ok: true, messageId: `out-${this.executed.length}` };
    }

    async setGroupPolicy(accountId, groupId, mode) {
        const policy = {
            mode,
            enabled: mode !== 'mute',
            requireMention: mode !== 'free',
        };
        this.groupPolicies.set(`${accountId || 'default'}|${String(groupId).replace(/^group:/, '')}`, policy);
        return policy;
    }

    async getGroupPolicy(accountId, groupId) {
        return this.groupPolicies.get(`${accountId || 'default'}|${String(groupId).replace(/^group:/, '')}`);
    }

    subscribeInbound(cb) {
        this._inboundCb = cb;
        return () => { this._inboundCb = null; };
    }

    subscribeGroupEvents(cb) {
        this._groupCb = cb;
        return () => { this._groupCb = null; };
    }

    /** Test helper: giả lập một tin nhắn đến (đã normalized hoặc raw). */
    async emitInbound(event) {
        if (this._inboundCb) await this._inboundCb(event);
    }

    async emitGroupEvent(event) {
        if (this._groupCb) await this._groupCb(event);
    }

    /** Lọc action đã gửi theo loại. */
    sent(actionName) {
        return this.executed.filter(a => a.action === actionName);
    }
}

/** Dựng NormalizedInboundEvent nhanh cho test. */
export function makeInbound(overrides = {}) {
    const n = makeInbound._seq = (makeInbound._seq || 0) + 1;
    return {
        accountId: 'acc1',
        conversationId: 'group-1',
        groupId: 'group-1',
        isGroup: true,
        messageId: `msg-${n}`,
        senderId: 'uid-A',
        senderName: 'An',
        text: 'hello',
        mentions: [],
        quote: undefined,
        attachments: [],
        timestamp: Date.now(),
        rawType: 'message',
        ...overrides,
    };
}
