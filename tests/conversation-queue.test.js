import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationQueue, conversationKey, ConversationQueueTimeoutError } from '../src/messaging/conversation-queue.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('cùng key chạy tuần tự FIFO', async () => {
    const q = new ConversationQueue();
    const order = [];
    const p1 = q.enqueue('k', async () => { await sleep(30); order.push(1); });
    const p2 = q.enqueue('k', async () => { await sleep(5); order.push(2); });
    const p3 = q.enqueue('k', async () => { order.push(3); });
    await Promise.all([p1, p2, p3]);
    assert.deepEqual(order, [1, 2, 3]);
});

test('khác key chạy song song', async () => {
    const q = new ConversationQueue();
    let aRunning = false, overlapped = false;
    const p1 = q.enqueue('a', async () => { aRunning = true; await sleep(40); aRunning = false; });
    const p2 = q.enqueue('b', async () => { await sleep(10); if (aRunning) overlapped = true; });
    await Promise.all([p1, p2]);
    assert.ok(overlapped, 'task key b phải chạy trong lúc key a đang chạy');
});

test('lỗi một task không chặn task sau', async () => {
    const errors = [];
    const q = new ConversationQueue({ onError: (e) => errors.push(e.message) });
    const results = [];
    const p1 = q.enqueue('k', async () => { throw new Error('boom'); });
    const p2 = q.enqueue('k', async () => { results.push('ok'); });
    await assert.rejects(p1, /boom/);
    await p2;
    assert.deepEqual(results, ['ok']);
    assert.deepEqual(errors, ['boom']);
});

test('timeout chỉ fail turn đó, turn sau vẫn chạy', async () => {
    const q = new ConversationQueue({ defaultTimeoutMs: 30, onError: () => {} });
    const results = [];
    const p1 = q.enqueue('k', async () => { await sleep(200); results.push('slow'); });
    const p2 = q.enqueue('k', async () => { results.push('fast'); });
    await assert.rejects(p1, ConversationQueueTimeoutError);
    await p2;
    assert.ok(results.includes('fast'));
});

test('depth và stats phản ánh hàng đợi', async () => {
    const q = new ConversationQueue();
    const p1 = q.enqueue('k', () => sleep(30));
    const p2 = q.enqueue('k', () => sleep(1));
    assert.equal(q.depth('k'), 2);
    assert.ok(q.stats()['k'].depth === 2);
    await Promise.all([p1, p2]);
    assert.equal(q.depth('k'), 0);
    assert.deepEqual(q.stats(), {});
});

test('conversationKey ghép account + conversation', () => {
    assert.equal(conversationKey('a', 'c'), 'a|c');
});
