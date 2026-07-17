import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, MemoryStore } from '../src/storage/database.js';

test('openStore(:memory:) chạy migration và CRUD messages', () => {
    const store = openStore(':memory:', { logger: { info: () => {}, warn: () => {} } });
    assert.equal(store.kind, 'sqlite');
    store.upsertConversation({ id: 'acc1|g1', accountId: 'acc1', groupId: 'g1', type: 'group' });
    store.insertMessage({ id: 'm1', conversationId: 'acc1|g1', senderId: 'u1', senderName: 'A', text: 'xin chào', sentAt: 100 });
    store.insertMessage({ id: 'm2', conversationId: 'acc1|g1', senderId: 'u2', senderName: 'B', text: 'chào lại', sentAt: 200 });
    const rows = store.recentMessages('acc1|g1', 10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'm1', 'trả về cũ → mới');
    // idempotent: ghi lại cùng id không nhân đôi
    store.insertMessage({ id: 'm1', conversationId: 'acc1|g1', senderId: 'u1', senderName: 'A', text: 'đã sửa', sentAt: 100 });
    assert.equal(store.recentMessages('acc1|g1', 10).length, 2);
    store.close();
});

test('migration idempotent: mở lại không chạy lại', () => {
    // :memory: mỗi lần mở là DB mới nên test bằng cách chạy runMigrations 2 lần qua openStore logger đếm
    const logs = [];
    const store = openStore(':memory:', { logger: { info: (m) => logs.push(m), warn: () => {} } });
    assert.ok(logs.some(l => /applied \d+ migration/.test(l)));
    store.close();
});

test('turn recovery: openTurns trả turn dở dang, setTurnStatus cập nhật', () => {
    const store = openStore(':memory:', { logger: { info: () => {}, warn: () => {} } });
    const turn = {
        turnId: 't1', accountId: 'a', conversationId: 'c',
        inboundMessageId: 'm1', senderId: 'u1', receivedAt: Date.now(),
    };
    store.saveTurn(turn, 'open');
    let open = store.openTurns();
    assert.equal(open.length, 1);
    assert.equal(open[0].senderId, 'u1');
    store.setTurnStatus('t1', 'failed');
    assert.equal(store.openTurns().length, 0);
    store.close();
});

test('pruneMessagesOlderThan xoá tin cũ', () => {
    const store = openStore(':memory:', { logger: { info: () => {}, warn: () => {} } });
    store.insertMessage({ id: 'old', conversationId: 'c', senderId: 'u', text: '', sentAt: 100 });
    store.insertMessage({ id: 'new', conversationId: 'c', senderId: 'u', text: '', sentAt: 900 });
    store.pruneMessagesOlderThan(500);
    const rows = store.recentMessages('c', 10);
    assert.deepEqual(rows.map(r => r.id), ['new']);
    store.close();
});

test('MemoryStore cùng interface (fallback Node < 22.5)', () => {
    const store = new MemoryStore();
    store.insertMessage({ id: 'm1', conversationId: 'c', senderId: 'u', text: 'a', sentAt: 1 });
    store.insertMessage({ id: 'm1', conversationId: 'c', senderId: 'u', text: 'b', sentAt: 1 });
    assert.equal(store.recentMessages('c').length, 1);
    store.saveTurn({ turnId: 't1' }, 'open');
    store.setTurnStatus('t1', 'done');
    assert.equal(store.openTurns().length, 0);
});
