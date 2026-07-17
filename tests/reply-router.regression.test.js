/**
 * Regression acceptance theo product plan §5.5 + §6 — checkpoint bắt buộc
 * của CLAUDE_HANDOFF.md. Chạy hoàn toàn trên mock, không cần tài khoản Zalo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyRouter } from '../src/messaging/reply-router.js';
import { createZaloConnectBridge } from '../src/integration/zalo-connect-bridge.js';
import { MockZaloConnectAdapter, makeInbound } from './helpers/mock-zalo-connect.js';
import { openStore } from '../src/storage/database.js';

const quietLogger = { info: () => {}, warn: () => {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeRouter(opts = {}) {
    const adapter = new MockZaloConnectAdapter(opts.adapter);
    const bridge = createZaloConnectBridge(adapter, { logger: quietLogger });
    const router = new ReplyRouter({ bridge, logger: quietLogger, storage: opts.storage }, {
        turnTimeoutMs: opts.turnTimeoutMs ?? 5_000,
        ...opts.router,
    });
    return { adapter, bridge, router };
}

test('REGRESSION 1: A và B mention đồng thời 50 lần — 0 cross-mention', async () => {
    const { adapter, router } = makeRouter();
    let modelCalls = 0;
    // Agent giả có độ trễ NGẪU NHIÊN — mô phỏng LLM chậm nhanh khác nhau,
    // chính là điều kiện gây bug cũ (reply của A hoàn thành sau khi B đã ghi đè state).
    const runAgent = async (turn) => {
        modelCalls++;
        await sleep(Math.random() * 20);
        return `trả lời cho ${turn.senderName}`;
    };

    const jobs = [];
    for (let i = 0; i < 50; i++) {
        jobs.push(router.handleTriggeringMessage(makeInbound({
            messageId: `a-${i}`, senderId: 'uid-A', senderName: 'An', text: `@Bot câu A${i}`,
        }), runAgent));
        jobs.push(router.handleTriggeringMessage(makeInbound({
            messageId: `b-${i}`, senderId: 'uid-B', senderName: 'Binh', text: `@Bot câu B${i}`,
        }), runAgent));
    }
    await Promise.all(jobs);

    const sent = adapter.sent('group-mention');
    assert.equal(sent.length, 100);
    assert.equal(modelCalls, 100);
    let crossTags = 0;
    for (const action of sent) {
        const mentionedUid = action.mentions[0].uid;
        const expectedUid = action.message.includes('An') ? 'uid-A' : 'uid-B';
        if (mentionedUid !== expectedUid) crossTags++;
    }
    assert.equal(crossTags, 0, `phát hiện ${crossTags} cross-tag!`);
});

test('REGRESSION 2: A mention 2 lần liên tiếp — reply đúng thứ tự, đúng correlation', async () => {
    const { adapter, router } = makeRouter();
    const runAgent = async (turn) => {
        // câu 1 chạy CHẬM hơn câu 2 — không có FIFO thì reply sẽ đảo thứ tự
        await sleep(turn.inboundMessageId === 'q1' ? 40 : 5);
        return `đáp ${turn.inboundMessageId}`;
    };
    await Promise.all([
        router.handleTriggeringMessage(makeInbound({ messageId: 'q1', senderId: 'uid-A', senderName: 'An' }), runAgent),
        router.handleTriggeringMessage(makeInbound({ messageId: 'q2', senderId: 'uid-A', senderName: 'An' }), runAgent),
    ]);
    const sent = adapter.sent('group-mention');
    assert.deepEqual(sent.map(a => a.quoteMessageId), ['q1', 'q2'], 'FIFO phải giữ thứ tự');
    assert.ok(sent[0].message.includes('đáp q1'));
    assert.ok(sent[1].message.includes('đáp q2'));
});

test('REGRESSION 3: trùng displayName khác UID — dùng đúng UID', async () => {
    const { adapter, router } = makeRouter();
    const runAgent = async () => 'ok';
    await Promise.all([
        router.handleTriggeringMessage(makeInbound({
            messageId: 'x1', senderId: 'uid-111', senderName: 'Nguyen Van A',
        }), runAgent),
        router.handleTriggeringMessage(makeInbound({
            messageId: 'x2', senderId: 'uid-222', senderName: 'Nguyen Van A',
            conversationId: 'group-2', groupId: 'group-2',
        }), runAgent),
    ]);
    const uids = adapter.sent('group-mention').map(a => a.mentions[0].uid).sort();
    assert.deepEqual(uids, ['uid-111', 'uid-222']);
});

test('REGRESSION 4: hai account trong cùng group — context tách biệt theo account', async () => {
    const { adapter, router } = makeRouter();
    const seenContexts = {};
    const runAgent = async (turn, ctx) => {
        seenContexts[turn.accountId] = ctx.records.map(r => r.messageId);
        return 'ok';
    };
    // account 1 có history riêng
    router.capture(makeInbound({ accountId: 'acc1', messageId: 'h1', senderId: 'uid-A', text: 'history acc1' }));
    // account 2 cùng groupId nhưng là account khác
    router.capture(makeInbound({ accountId: 'acc2', messageId: 'h2', senderId: 'uid-A', text: 'history acc2' }));

    await Promise.all([
        router.handleTriggeringMessage(makeInbound({ accountId: 'acc1', messageId: 't1', senderId: 'uid-A' }), runAgent),
        router.handleTriggeringMessage(makeInbound({ accountId: 'acc2', messageId: 't2', senderId: 'uid-A' }), runAgent),
    ]);
    assert.ok(seenContexts.acc1.includes('h1') && !seenContexts.acc1.includes('h2'));
    assert.ok(seenContexts.acc2.includes('h2') && !seenContexts.acc2.includes('h1'));
});

test('REGRESSION 5: timeout/retry không mượn sender của turn khác', async () => {
    const { adapter, router } = makeRouter({ turnTimeoutMs: 30 });
    const runAgent = async (turn) => {
        if (turn.senderId === 'uid-SLOW') await sleep(200); // sẽ timeout
        return `reply ${turn.senderName}`;
    };
    const slow = router.handleTriggeringMessage(
        makeInbound({ messageId: 's1', senderId: 'uid-SLOW', senderName: 'Slow' }), runAgent);
    const fast = router.handleTriggeringMessage(
        makeInbound({ messageId: 'f1', senderId: 'uid-FAST', senderName: 'Fast' }), runAgent);

    await assert.rejects(slow, /timed out/);
    await fast;
    const sent = adapter.sent('group-mention');
    assert.equal(sent.length, 1, 'turn timeout không được gửi reply');
    assert.equal(sent[0].mentions[0].uid, 'uid-FAST');
});

test('REGRESSION 6 (silent): tin không mention → capture nhưng 0 model call', async () => {
    const { router } = makeRouter();
    let modelCalls = 0;
    // Silent flow: KHÔNG gọi handleTriggeringMessage, chỉ capture.
    for (let i = 0; i < 20; i++) {
        router.capture(makeInbound({ messageId: `s${i}`, senderId: 'uid-A', text: `tin thường ${i}` }));
    }
    assert.equal(modelCalls, 0);
    assert.equal(router.buffer.recent('acc1', 'group-1').length, 20);

    // Khi được tag, context bounded từ các tin silent phải tới agent.
    let gotContext = null;
    await router.handleTriggeringMessage(
        makeInbound({ messageId: 'trigger', senderId: 'uid-A', text: '@Bot tóm tắt' }),
        async (turn, ctx) => { modelCalls++; gotContext = ctx; return 'tóm tắt xong'; });
    assert.equal(modelCalls, 1, 'chỉ đúng 1 model call cho turn được tag');
    assert.ok(gotContext.block.includes('tin thường 19'));
    assert.ok(gotContext.records.length <= 20);
});

test('REGRESSION 7 (kịch bản handoff): abc, xyz rồi tag — turn nhận đúng bounded context', async () => {
    const { adapter, router } = makeRouter();
    router.capture(makeInbound({ messageId: 'm1', senderId: 'uid-A', senderName: 'A', text: 'abc' }));
    router.capture(makeInbound({ messageId: 'm2', senderId: 'uid-A', senderName: 'A', text: 'xyz' }));
    router.capture(makeInbound({ messageId: 'm3', senderId: 'uid-B', senderName: 'B', text: 'use option 2' }));

    let block = null;
    await router.handleTriggeringMessage(
        makeInbound({ messageId: 'm4', senderId: 'uid-A', senderName: 'A', text: 'what should we do?' }),
        async (turn, ctx) => { block = ctx.block; return 'dùng option 2 nhé'; });

    assert.ok(block.includes('abc'), 'context phải chứa tin abc gửi trước khi tag');
    assert.ok(block.includes('xyz'));
    assert.ok(block.includes('use option 2'));
    assert.ok(block.includes('UNTRUSTED'));
    // reply mention đúng A
    assert.equal(adapter.sent('group-mention')[0].mentions[0].uid, 'uid-A');
});

test('turn dở dang persist vào storage và recovery đánh dấu failed', async () => {
    const storage = openStore(':memory:', { logger: quietLogger });
    const { router } = makeRouter({ storage, turnTimeoutMs: 20 });
    await assert.rejects(
        router.handleTriggeringMessage(makeInbound({ messageId: 'z1', senderId: 'u' }),
            async () => { await sleep(100); return 'x'; }),
        /timed out/);
    // turn timeout đã được đánh failed ngay
    assert.equal(storage.openTurns().length, 0);

    // giả lập crash: turn 'open' còn trong DB
    storage.saveTurn({ turnId: 'ghost', accountId: 'a', conversationId: 'c', inboundMessageId: 'm', senderId: 'u', receivedAt: Date.now() }, 'open');
    const { router: router2 } = makeRouter({ storage });
    assert.equal(router2.recoverUnfinishedTurns(), 1);
    assert.equal(storage.openTurns().length, 0);
    storage.close();
});

test('DM (không groupId) gửi send-message thường, không group-mention', async () => {
    const { adapter, router } = makeRouter();
    await router.handleTriggeringMessage(makeInbound({
        messageId: 'd1', senderId: 'uid-A', conversationId: 'dm-uid-A',
        groupId: undefined, isGroup: false,
    }), async () => 'chào bạn');
    assert.equal(adapter.sent('group-mention').length, 0);
    const sent = adapter.sent('send-message');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].threadId, 'dm-uid-A');
});

test('reply rỗng → không gửi gì', async () => {
    const { adapter, router } = makeRouter();
    await router.handleTriggeringMessage(makeInbound({ messageId: 'e1', senderId: 'u' }), async () => '');
    assert.equal(adapter.executed.length, 0);
});

test('panel debug: lastContextByTurn lưu snapshot đã dùng', async () => {
    const { router } = makeRouter();
    router.capture(makeInbound({ messageId: 'c1', senderId: 'uid-A', text: 'ngữ cảnh' }));
    const { turn } = await router.handleTriggeringMessage(
        makeInbound({ messageId: 't1', senderId: 'uid-A' }), async () => 'ok');
    const dbg = router.lastContextByTurn.get(turn.turnId);
    assert.ok(dbg.block.includes('ngữ cảnh'));
    assert.ok(dbg.records.length >= 1);
});
