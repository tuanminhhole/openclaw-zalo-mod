import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZaloConnectBridge, normalizeInboundEvent, deriveCapabilities, BridgeActionError } from '../src/integration/zalo-connect-bridge.js';
import { MockZaloConnectAdapter, makeInbound } from './helpers/mock-zalo-connect.js';

test('getStatus/getCapabilities đi qua adapter', async () => {
    const adapter = new MockZaloConnectAdapter({
        statusByAccount: { acc1: { connected: true, accountId: 'acc1' } },
    });
    const bridge = createZaloConnectBridge(adapter);
    const status = await bridge.getStatus('acc1');
    assert.equal(status.connected, true);
    const caps = await bridge.getCapabilities('acc1');
    assert.equal(caps.mention, true);
    assert.equal(caps.sticker, true);
    assert.equal(caps.sendFile, true);
});

test('capability degrade khi runtime thiếu action (không crash)', async () => {
    const adapter = new MockZaloConnectAdapter({ actionNames: ['send-message'] });
    const bridge = createZaloConnectBridge(adapter);
    const caps = await bridge.getCapabilities('acc1');
    assert.equal(caps.mention, false);
    assert.equal(caps.sticker, false);
    assert.equal(caps.quoteReply, true);
});

test('execute chuyển action nguyên vẹn và trả kết quả', async () => {
    const adapter = new MockZaloConnectAdapter();
    const bridge = createZaloConnectBridge(adapter);
    const res = await bridge.execute('acc1', {
        action: 'group-mention', threadId: 'g1', message: '@A chào',
        mentions: [{ uid: 'uid-A', displayName: 'A' }],
    });
    assert.equal(res.ok, true);
    assert.equal(adapter.executed.length, 1);
    assert.equal(adapter.executed[0].mentions[0].uid, 'uid-A');
});

test('execute lỗi → BridgeActionError kèm action', async () => {
    const adapter = new MockZaloConnectAdapter({ failActions: ['send-sticker'] });
    const bridge = createZaloConnectBridge(adapter);
    await assert.rejects(
        bridge.execute('acc1', { action: 'send-sticker', stickerId: 1 }),
        (e) => e instanceof BridgeActionError && e.action.action === 'send-sticker',
    );
    await assert.rejects(bridge.execute('acc1', {}), /missing action name/);
});

test('setGroupPolicy map free/silent/mute qua adapter, tách theo account', async () => {
    const adapter = new MockZaloConnectAdapter();
    const bridge = createZaloConnectBridge(adapter);
    assert.deepEqual(await bridge.setGroupPolicy('acc1', 'group:g1', 'free'), {
        mode: 'free', enabled: true, requireMention: false,
    });
    assert.deepEqual(await bridge.setGroupPolicy('acc1', 'g1', 'silent'), {
        mode: 'silent', enabled: true, requireMention: true,
    });
    assert.deepEqual(await bridge.setGroupPolicy('acc1', 'g1', 'mute'), {
        mode: 'mute', enabled: false, requireMention: true,
    });
    assert.equal(await bridge.getGroupPolicy('acc2', 'g1'), undefined);
    await assert.rejects(bridge.setGroupPolicy('acc1', 'g1', 'other'), /invalid group mode/);
});

test('nameTriggers passthrough: set/get theo account, dedupe', async () => {
    const adapter = new MockZaloConnectAdapter();
    const bridge = createZaloConnectBridge(adapter);
    assert.deepEqual((await bridge.getNameTriggers('acc1')).triggers, []);
    const set = await bridge.setNameTriggers('acc1', [' Mkt ', 'mei', 'mkt', '']);
    assert.deepEqual(set.triggers, ['Mkt', 'mei']);
    assert.deepEqual((await bridge.getNameTriggers('acc1')).triggers, ['Mkt', 'mei']);
    assert.deepEqual((await bridge.getNameTriggers('acc2')).triggers, []);
    assert.deepEqual((await bridge.setNameTriggers('acc1', [])).triggers, []);
});

test('nameTriggers ném lỗi rõ ràng khi adapter cũ (bridge < v4)', async () => {
    const bareAdapter = { getStatus: async () => ({}), listActions: async () => [], executeAction: async () => ({}) };
    const bridge = createZaloConnectBridge(bareAdapter);
    await assert.rejects(bridge.getNameTriggers('acc1'), /does not support name triggers/);
    await assert.rejects(bridge.setNameTriggers('acc1', ['x']), /does not support name triggers/);
});

test('onInbound nhận event; unsubscribe dừng nhận', async () => {
    const adapter = new MockZaloConnectAdapter();
    const bridge = createZaloConnectBridge(adapter);
    const seen = [];
    const unsub = bridge.onInbound(async (ev) => seen.push(ev.messageId));
    await adapter.emitInbound(makeInbound({ messageId: 'x1' }));
    unsub();
    await adapter.emitInbound(makeInbound({ messageId: 'x2' }));
    assert.deepEqual(seen, ['x1']);
});

test('handler lỗi không giết dispatcher (các handler khác vẫn chạy)', async () => {
    const adapter = new MockZaloConnectAdapter();
    const warned = [];
    const bridge = createZaloConnectBridge(adapter, { logger: { warn: (m) => warned.push(m) } });
    const seen = [];
    bridge.onInbound(async () => { throw new Error('handler hỏng'); });
    bridge.onInbound(async (ev) => seen.push(ev.messageId));
    await adapter.emitInbound(makeInbound({ messageId: 'x1' }));
    assert.deepEqual(seen, ['x1']);
    assert.equal(warned.length, 1);
});

test('onInbound truyền handled ngược về Zalo Connect để chặn mention/model gate', async () => {
    const adapter = new MockZaloConnectAdapter();
    const bridge = createZaloConnectBridge(adapter, { logger: { warn() {} } });
    bridge.onInbound(async (event) => event.text.startsWith('/bot-') ? { handled: true } : undefined);

    assert.equal(await adapter.emitInbound(makeInbound({ text: '/bot-noi-quy' })), true);
    assert.equal(await adapter.emitInbound(makeInbound({ text: 'alo' })), false);
});

test('normalizeInboundEvent map đủ trường từ before_dispatch shape', () => {
    const ev = normalizeInboundEvent({
        ctx: { accountId: 'acc1', conversationId: 'group-77', senderId: 'uid-A', isGroup: true },
        event: {
            body: 'xin chào @Bot', msgId: 'zmsg-1', senderName: 'An',
            mentions: [{ uid: 'bot-uid', dName: 'Bot' }],
            quote: { globalMsgId: 999, ownerId: 'uid-B', msg: 'tin gốc' },
            attachments: [{ type: 'file', fileName: 'a.pdf', mimeType: 'application/pdf', fileSize: 123 }],
            timestamp: 1700000000000,
        },
    });
    assert.equal(ev.accountId, 'acc1');
    assert.equal(ev.messageId, 'zmsg-1');
    assert.equal(ev.senderId, 'uid-A');
    assert.equal(ev.isGroup, true);
    assert.equal(ev.mentions[0].userId, 'bot-uid');
    assert.equal(ev.quote.messageId, '999');
    assert.equal(ev.quote.senderId, 'uid-B');
    assert.equal(ev.attachments[0].filename, 'a.pdf');
    assert.ok(Object.isFrozen(ev));
});

test('normalizeInboundEvent: thiếu conversation/sender → null; thiếu messageId → derive ổn định', () => {
    assert.equal(normalizeInboundEvent({ ctx: {}, event: {} }), null);
    const a = normalizeInboundEvent({
        ctx: { conversationId: 'c1', senderId: 'u1' },
        event: { body: 'hello', timestamp: 5 },
    });
    const b = normalizeInboundEvent({
        ctx: { conversationId: 'c1', senderId: 'u1' },
        event: { body: 'hello', timestamp: 5 },
    });
    assert.equal(a.messageId, b.messageId, 'derive phải deterministic để dedupe');
});

test('deriveCapabilities với danh sách rỗng', () => {
    const caps = deriveCapabilities([]);
    assert.equal(caps.mention, false);
    assert.equal(caps.passiveHistory, true);
});

// ── Tier outbound adapter (runtime.channel.outbound.loadAdapter) ──────────

import { createOpenclawAdapter } from '../src/integration/openclaw-adapter.js';

function makeFakeRuntime(overrides = {}) {
    const calls = [];
    const outboundAdapter = {
        sendText: async (ctx) => { calls.push({ kind: 'sendText', ctx }); return { ok: true, messageId: 'zc-1' }; },
        sendMedia: async (ctx) => { calls.push({ kind: 'sendMedia', ctx }); return { ok: true, messageId: 'zc-2' }; },
        ...overrides.adapter,
    };
    const runtime = {
        channel: { outbound: { loadAdapter: async (id) => (id === 'zalo-connect' ? outboundAdapter : undefined) } },
    };
    return { runtime, calls };
}

test('tier 2: send-message đi qua outbound adapter public của zalo-connect', async () => {
    const { runtime, calls } = makeFakeRuntime();
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        runtime,
        getConfig: () => ({ marker: 'cfg' }),
        getZaloConnectService: () => null,
    });
    const r = await adapter.executeAction('default', {
        action: 'send-message', threadId: 'g123', isGroup: true, message: 'xin chào',
    });
    assert.equal(r.ok, true);
    assert.equal(r.messageId, 'zc-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.to, 'g123');
    assert.equal(calls[0].ctx.text, 'xin chào');
    assert.equal(calls[0].ctx.cfg.marker, 'cfg');
});

test('tier 2: group-mention degrade thành sendText (zalo-connect resolve tên→UID)', async () => {
    const { runtime, calls } = makeFakeRuntime();
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        runtime, getConfig: () => ({}), getZaloConnectService: () => null,
    });
    await adapter.executeAction('default', {
        action: 'group-mention', threadId: 'g1', message: '@Nguyen Van A trả lời đây', quoteMessageId: 'q9',
    });
    assert.equal(calls[0].kind, 'sendText');
    assert.ok(calls[0].ctx.text.startsWith('@Nguyen Van A'));
    assert.equal(calls[0].ctx.replyToId, 'q9');
});

test('tier 2: send-image có imageUrl → sendMedia', async () => {
    const { runtime, calls } = makeFakeRuntime();
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        runtime, getConfig: () => ({}), getZaloConnectService: () => null,
    });
    await adapter.executeAction('default', {
        action: 'send-image', threadId: 'u1', message: 'caption', imageUrl: 'http://x/y.png',
    });
    assert.equal(calls[0].kind, 'sendMedia');
    assert.equal(calls[0].ctx.mediaUrl, 'http://x/y.png');
});

test('tier 1 service được ưu tiên trước tier 2', async () => {
    const { runtime, calls } = makeFakeRuntime();
    const svcCalls = [];
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        runtime, getConfig: () => ({}),
        getZaloConnectService: () => ({
            executeAction: async (acc, action) => { svcCalls.push(action.action); return { ok: true, messageId: 'svc-1' }; },
        }),
    });
    const r = await adapter.executeAction('default', { action: 'send-sticker', threadId: 'g1', stickerId: 7 });
    assert.equal(r.messageId, 'svc-1');
    assert.deepEqual(svcCalls, ['send-sticker']);
    assert.equal(calls.length, 0);
});

test('tier 1 live group policy gọi thẳng service, không ghi config/action tool', async () => {
    const calls = [];
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        getZaloConnectService: () => ({
            setGroupPolicy: async (accountId, groupId, mode) => {
                calls.push({ accountId, groupId, mode });
                return { mode, enabled: mode !== 'mute', requireMention: mode !== 'free' };
            },
            getGroupPolicy: async () => ({ mode: 'silent', enabled: true, requireMention: true }),
        }),
    });
    const result = await adapter.setGroupPolicy('default', 'g1', 'silent');
    assert.equal(result.requireMention, true);
    assert.deepEqual(calls, [{ accountId: 'default', groupId: 'g1', mode: 'silent' }]);
    assert.equal((await adapter.getGroupPolicy('default', 'g1')).mode, 'silent');
});

test('không runtime, không service → báo transport Zalo Connect không khả dụng', async () => {
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        getZaloConnectService: () => null,
    });
    await assert.rejects(
        adapter.executeAction('default', { action: 'send-message', threadId: 'g1', isGroup: true, message: 'x' }),
        /không có transport OpenClaw Zalo Connect/);
});

test('outbound adapter trả error → BridgeActionError nổi lên (không nuốt lỗi)', async () => {
    const { runtime } = makeFakeRuntime({
        adapter: { sendText: async () => ({ ok: false, error: new Error('zalo rate limit') }) },
    });
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        runtime, getConfig: () => ({}), getZaloConnectService: () => null,
    });
    await assert.rejects(
        adapter.executeAction('default', { action: 'send-message', threadId: 'g1', message: 'x' }),
        /rate limit/);
});

// ── Tier 1 service: dịch action sang vocabulary tool zalo-connect ─────────────

test('tier 1: send-message được dịch thành action "send" của tool zalo-connect', async () => {
    const received = [];
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        getZaloConnectService: () => ({
            executeAction: async (acc, a) => { received.push(a); return { success: true, msgId: 'zc-99' }; },
        }),
    });
    const r = await adapter.executeAction('default', {
        action: 'send-message', threadId: 'u1', isGroup: false, message: 'chào',
    });
    assert.equal(received[0].action, 'send');
    assert.equal(received[0].threadId, 'u1');
    assert.equal(received[0].isGroup, false);
    assert.equal(r.ok, true);
    assert.equal(r.messageId, 'zc-99');
});

test('tier 1: group-mention → "send" với isGroup=true; send-image → "image"', async () => {
    const received = [];
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        getZaloConnectService: () => ({
            executeAction: async (acc, a) => { received.push(a); return { success: true, msgId: 'x' }; },
        }),
    });
    await adapter.executeAction('default', { action: 'group-mention', threadId: 'g1', message: '@A chào' });
    await adapter.executeAction('default', { action: 'send-image', threadId: 'u1', imageUrl: 'http://x/y.png', message: 'cap' });
    assert.deepEqual(received.map(a => a.action), ['send', 'image']);
    assert.equal(received[0].isGroup, true);
    assert.equal(received[1].url, 'http://x/y.png');
});

test('tier 1: tool trả {error:true} (action lạ) → THROW, không nuốt lỗi', async () => {
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        getZaloConnectService: () => ({
            executeAction: async () => ({ error: true, message: 'Unknown action: send-message' }),
        }),
    });
    await assert.rejects(
        adapter.executeAction('default', { action: 'send-message', threadId: 'u1', message: 'x' }),
        /Unknown action/);
});

test('tier 1: tool trả {success:false} (send fail/rate-limit) → THROW', async () => {
    const adapter = createOpenclawAdapter({
        logger: { info: () => {}, warn: () => {} },
        getZaloConnectService: () => ({
            executeAction: async () => ({ success: false, error: 'send failed: no msgId returned' }),
        }),
    });
    await assert.rejects(
        adapter.executeAction('default', { action: 'send-message', threadId: 'u1', message: 'x' }),
        /no msgId/);
});

test('deriveCapabilities nhận vocabulary tool zalo-connect (send/image)', () => {
    const caps = deriveCapabilities(['send', 'image', 'send-sticker', 'search-stickers', 'add-reaction', 'remove-from-group']);
    assert.equal(caps.mention, true);
    assert.equal(caps.sendImage, true);
    assert.equal(caps.sticker, true);
    assert.equal(caps.groupAdmin, true);
});
