import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnContextStore } from '../src/context/turn-context.js';

test('TurnContext là bất biến và đủ trường', () => {
    const store = new TurnContextStore();
    const turn = store.create({
        accountId: 'acc1', conversationId: 'g1', groupId: 'g1',
        inboundMessageId: 'm1', senderId: 'uid-A', senderName: 'An', mentionedBot: true,
    });
    assert.equal(turn.senderId, 'uid-A');
    assert.ok(turn.turnId);
    assert.ok(Object.isFrozen(turn));
    assert.throws(() => { turn.senderId = 'uid-B'; }, TypeError);
});

test('thiếu trường bắt buộc thì ném lỗi', () => {
    const store = new TurnContextStore();
    assert.throws(() => store.create({ accountId: 'a', conversationId: 'c', inboundMessageId: 'm' }),
        /senderId/);
});

test('lookup theo message key và session binding', () => {
    const store = new TurnContextStore();
    const turn = store.create({
        accountId: 'acc1', conversationId: 'g1', inboundMessageId: 'm1', senderId: 'uid-A',
    });
    assert.equal(store.getByMessage('acc1', 'g1', 'm1'), turn);
    assert.ok(store.bindSession('sess-9', turn.turnId));
    assert.equal(store.getBySession('sess-9'), turn);
    assert.equal(store.getByMessage('acc1', 'g1', 'unknown'), undefined);
});

test('hai turn cùng conversation không ghi đè nhau (nền tảng fix A/B)', () => {
    const store = new TurnContextStore();
    const a = store.create({ accountId: 'acc1', conversationId: 'g1', inboundMessageId: 'mA', senderId: 'uid-A', senderName: 'An' });
    const b = store.create({ accountId: 'acc1', conversationId: 'g1', inboundMessageId: 'mB', senderId: 'uid-B', senderName: 'Binh' });
    assert.equal(store.getByMessage('acc1', 'g1', 'mA').senderId, 'uid-A');
    assert.equal(store.getByMessage('acc1', 'g1', 'mB').senderId, 'uid-B');
    assert.notEqual(a.turnId, b.turnId);
});

test('TTL: complete + sweep xoá sau recovery window', () => {
    let now = 1_000_000;
    const store = new TurnContextStore({ now: () => now, ttlMs: 10_000, recoveryMs: 2_000 });
    const turn = store.create({ accountId: 'a', conversationId: 'c', inboundMessageId: 'm', senderId: 'u' });
    store.bindSession('s1', turn.turnId);
    store.complete(turn.turnId);
    now += 1_000;
    store.sweep();
    assert.equal(store.getByTurnId(turn.turnId), turn, 'còn trong recovery window');
    now += 2_000;
    store.sweep();
    assert.equal(store.getByTurnId(turn.turnId), undefined);
    assert.equal(store.getBySession('s1'), undefined);
    assert.equal(store.getByMessage('a', 'c', 'm'), undefined);
});

test('turn chưa complete cũng hết hạn theo ttl (không leak)', () => {
    let now = 0;
    const store = new TurnContextStore({ now: () => now, ttlMs: 5_000 });
    store.create({ accountId: 'a', conversationId: 'c', inboundMessageId: 'm', senderId: 'u' });
    now = 6_000;
    assert.equal(store.sweep(), 1);
    assert.equal(store.size, 0);
});

test('getOpenTurnForConversation trả turn mở mới nhất đúng account', () => {
    let now = 0;
    const store = new TurnContextStore({ now: () => now });
    store.create({ accountId: 'a1', conversationId: 'c1', inboundMessageId: 'm1', senderId: 'u1', receivedAt: 1 });
    const t2 = store.create({ accountId: 'a1', conversationId: 'c1', inboundMessageId: 'm2', senderId: 'u2', receivedAt: 2 });
    store.create({ accountId: 'a2', conversationId: 'c1', inboundMessageId: 'm3', senderId: 'u3', receivedAt: 3 });
    assert.equal(store.getOpenTurnForConversation('a1', 'c1'), t2);
    store.complete(t2.turnId);
    assert.equal(store.getOpenTurnForConversation('a1', 'c1').senderId, 'u1');
});
