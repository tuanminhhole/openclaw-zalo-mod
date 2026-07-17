import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyMentionCorrelator } from '../src/messaging/reply-mention-correlator.js';

test('gắn đúng sender theo runId khi hai lượt cùng session chạy xen kẽ', () => {
    const c = new ReplyMentionCorrelator();
    c.capture({ runId: 'run-a', sessionKey: 'group-1', senderId: 'u-a', senderName: 'An' });
    c.capture({ runId: 'run-b', sessionKey: 'group-1', senderId: 'u-b', senderName: 'Bình Trần' });

    assert.equal(c.decorate({ runId: 'run-b', kind: 'final', payload: { text: 'B trả lời' } }).text,
        '@[Bình Trần] B trả lời');
    assert.equal(c.decorate({ runId: 'run-a', kind: 'final', payload: { text: 'A trả lời' } }).text,
        '@An A trả lời');
});

test('chỉ gắn tag ở payload hiển thị đầu tiên của một lượt', () => {
    const c = new ReplyMentionCorrelator();
    c.capture({ runId: 'run-1', sessionKey: 'group-1', senderId: 'u1', senderName: 'Minh Khang' });

    assert.equal(c.decorate({ runId: 'run-1', kind: 'tool', payload: { text: 'tool' } }), null);
    assert.equal(c.decorate({ runId: 'run-1', kind: 'block', payload: { text: 'Phần một' } }).text,
        '@[Minh Khang] Phần một');
    assert.equal(c.decorate({ runId: 'run-1', kind: 'final', payload: { text: 'Phần cuối' } }), null);
});

test('không lặp tag nếu model đã mở đầu bằng đúng tên', () => {
    const c = new ReplyMentionCorrelator();
    c.capture({ runId: 'run-1', senderId: 'u1', senderName: 'Kent' });
    const result = c.decorate({ runId: 'run-1', kind: 'final', payload: { text: '@Kent chào bạn' } });
    assert.equal(result.text, '@Kent chào bạn');
    assert.equal(result.changed, false);
});

test('fallback FIFO theo sessionKey khi outbound không có runId', () => {
    const c = new ReplyMentionCorrelator();
    c.capture({ sessionKey: 's1', senderId: 'u1', senderName: 'Một' });
    c.capture({ sessionKey: 's1', senderId: 'u2', senderName: 'Hai' });

    assert.equal(c.decorate({ sessionKey: 's1', kind: 'final', payload: { text: 'R1' } }).text, '@Một R1');
    assert.equal(c.decorate({ sessionKey: 's1', kind: 'final', payload: { text: 'R2' } }).text, '@Hai R2');
});

test('dọn record quá TTL', () => {
    let now = 1_000;
    const c = new ReplyMentionCorrelator({ ttlMs: 100, now: () => now });
    c.capture({ runId: 'old', senderId: 'u1', senderName: 'Cũ' });
    now = 1_101;
    assert.equal(c.decorate({ runId: 'old', kind: 'final', payload: { text: 'Không tag' } }), null);
});
