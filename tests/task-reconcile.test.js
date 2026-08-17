import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileOpenItems } from '../src/crm/task-reconcile.js';

// 5 nhánh bắt buộc theo điều kiện dừng P2 (TASKS.md): thêm mới · gặp lại · done · trùng việc tay →
// skipped · parse rỗng.

test('thêm mới: việc chưa từng thấy → insert với source=ai, review_state=pending', () => {
    const r = reconcileOpenItems({
        existing: [],
        items: [{ what: 'Gửi bổ sung giấy tờ kiểm nghiệm', who: 'An', due: '19/08', state: 'pending', evidence: '09:15' }],
        groupId: 'g1',
        date: '2026-08-18',
    });
    assert.equal(r.insert.length, 1);
    assert.equal(r.update.length, 0);
    assert.equal(r.close.length, 0);
    assert.equal(r.skipped.length, 0);
    assert.deepEqual(r.insert[0], {
        title: 'Gửi bổ sung giấy tờ kiểm nghiệm',
        assignee: 'An',
        note: 'Hạn: 19/08',
        groupId: 'g1',
        source: 'ai',
        status: 'todo',
        reviewState: 'pending',
        dedupeKey: 'gui-bo-sung-giay-to-kiem-nghiem',
        evidence: '09:15',
        firstSeenDate: '2026-08-18',
        lastSeenDate: '2026-08-18',
    });
});

test('gặp lại: việc AI đã có, hôm nay còn pending → chỉ cập nhật last_seen_date', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 't1', dedupe_key: 'goi-dien-xac-nhan', source: 'ai', status: 'todo' }],
        items: [{ what: 'Gọi điện xác nhận', who: '', due: '', state: 'pending', evidence: '' }],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.insert.length, 0, 'đã có rồi thì không insert lại');
    assert.equal(r.close.length, 0);
    assert.deepEqual(r.update, [{ id: 't1', dedupeKey: 'goi-dien-xac-nhan', lastSeenDate: '2026-08-19' }]);
});

test('done: việc AI đã có, hôm nay state=done → đóng', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 't2', dedupe_key: 'chot-phi-hop-quy', source: 'ai', status: 'todo' }],
        items: [{ what: 'Chốt phí hợp quy', who: '', due: '', state: 'done', evidence: '' }],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.update.length, 0);
    assert.equal(r.insert.length, 0);
    assert.deepEqual(r.close, [{ id: 't2', dedupeKey: 'chot-phi-hop-quy' }]);
});

test('trùng với việc tay: dedupe_key khớp một task source=manual → skipped, KHÔNG đụng gì', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 'm1', dedupe_key: 'tra-200-000d-du-ship', source: 'manual', status: 'todo' }],
        items: [{ what: 'Trả 200.000đ dư ship', who: '', due: '', state: 'pending', evidence: '' }],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.insert.length, 0);
    assert.equal(r.update.length, 0);
    assert.equal(r.close.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /gõ tay/);
});

test('parse rỗng: what rỗng/thiếu → bỏ qua im lặng, không insert việc trống', () => {
    const r = reconcileOpenItems({
        existing: [],
        items: [{ what: '   ', who: 'An' }, {}, { what: 'Việc thật' }],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.insert.length, 1, 'chỉ đúng 1 item có what thật được xử lý');
    assert.equal(r.insert[0].title, 'Việc thật');
});

// ── Ngoài 5 nhánh bắt buộc: hai hành vi Kent nhấn mạnh, đáng có test riêng ─────────────────────
test('items rỗng/không truyền → cả 4 mảng đều rỗng, không ném lỗi', () => {
    assert.deepEqual(reconcileOpenItems({ existing: [], items: [], groupId: 'g1', date: '2026-08-19' }),
        { insert: [], update: [], close: [], skipped: [] });
    assert.deepEqual(reconcileOpenItems({ existing: [], groupId: 'g1', date: '2026-08-19' }),
        { insert: [], update: [], close: [], skipped: [] });
});

test('task cũ KHÔNG xuất hiện lại trong items hôm nay → không bị đụng (không tự đổi trạng thái)', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 't-cu', dedupe_key: 'viec-im-lang', source: 'ai', status: 'todo' }],
        items: [{ what: 'Việc khác hoàn toàn', state: 'pending' }],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.ok(!r.update.some(u => u.id === 't-cu'));
    assert.ok(!r.close.some(c => c.id === 't-cu'));
});

test('cùng một việc nhắc 2 lần trong CÙNG một ngày → chỉ insert một lần', () => {
    const r = reconcileOpenItems({
        existing: [],
        items: [{ what: 'Gọi lại khách' }, { what: 'gọi lại khách' }],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.insert.length, 1);
});
