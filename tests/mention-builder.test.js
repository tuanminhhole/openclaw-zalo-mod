import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMentionPayload, buildGroupMentionAction } from '../src/messaging/mention-builder.js';

const turnA = Object.freeze({
    turnId: 't1', accountId: 'acc1', conversationId: 'g1', groupId: 'g1',
    inboundMessageId: 'mA', senderId: 'uid-A', senderName: 'Nguyen Van A',
    receivedAt: 0, mentionedBot: true,
});

test('policy sender: mention đúng UID người kích hoạt', () => {
    const { message, mentions } = buildMentionPayload(turnA, 'Nội dung trả lời');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].uid, 'uid-A');
    assert.equal(mentions[0].displayName, 'Nguyen Van A');
    assert.equal(message, '@Nguyen Van A Nội dung trả lời');
    assert.equal(mentions[0].offset, 0);
    assert.equal(mentions[0].length, '@Nguyen Van A'.length);
});

test('cùng displayName khác UID: dùng đúng UID từ turn', () => {
    const turnB = { ...turnA, senderId: 'uid-B', senderName: 'Nguyen Van A' };
    const a = buildMentionPayload(turnA, 'x');
    const b = buildMentionPayload(turnB, 'x');
    assert.equal(a.mentions[0].uid, 'uid-A');
    assert.equal(b.mentions[0].uid, 'uid-B');
});

test('policy off: không mention', () => {
    const { message, mentions } = buildMentionPayload(turnA, 'reply', { policy: 'off' });
    assert.equal(mentions.length, 0);
    assert.equal(message, 'reply');
});

test('policy quoted-author: mention tác giả quote, fallback sender khi không có quote', () => {
    const withQuote = { ...turnA, quotedSenderId: 'uid-Q' };
    const q = buildMentionPayload(withQuote, 'r', { policy: 'quoted-author', quotedAuthorName: 'Q' });
    assert.equal(q.mentions[0].uid, 'uid-Q');
    const noQuote = buildMentionPayload(turnA, 'r', { policy: 'quoted-author' });
    assert.equal(noQuote.mentions[0].uid, 'uid-A');
});

test('policy all-addressed: chỉ user đã resolve UID, không quét context', () => {
    const { mentions } = buildMentionPayload(turnA, 'r', {
        policy: 'all-addressed',
        addressedUsers: [
            { uid: 'uid-X', displayName: 'X' },
            { uid: '', displayName: 'thiếu uid — phải bị loại' },
            null,
        ],
    });
    assert.deepEqual(mentions.map(m => m.uid), ['uid-X']);
});

test('all-addressed rỗng fallback về sender', () => {
    const { mentions } = buildMentionPayload(turnA, 'r', { policy: 'all-addressed', addressedUsers: [] });
    assert.equal(mentions[0].uid, 'uid-A');
});

test('policy lạ thì ném lỗi', () => {
    assert.throws(() => buildMentionPayload(turnA, 'r', { policy: 'everyone' }), /Unknown mention policy/);
});

test('buildGroupMentionAction đủ payload native + quote tin kích hoạt', () => {
    const action = buildGroupMentionAction(turnA, 'Trả lời');
    assert.equal(action.action, 'group-mention');
    assert.equal(action.threadId, 'g1');
    assert.equal(action.quoteMessageId, 'mA');
    assert.equal(action.mentions[0].uid, 'uid-A');
    const noQuote = buildGroupMentionAction(turnA, 'Trả lời', { quote: false });
    assert.equal(noQuote.quoteMessageId, undefined);
});

test('senderName rỗng vẫn tạo mention hợp lệ bằng uid placeholder', () => {
    const turn = { ...turnA, senderName: '' };
    const { message, mentions } = buildMentionPayload(turn, 'x');
    assert.equal(mentions[0].uid, 'uid-A');
    assert.ok(message.startsWith('@uid-A'));
});
