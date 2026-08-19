import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileOpenItems, fuzzyKey, REJECT_TOMBSTONE_DAYS } from '../src/crm/task-reconcile.js';

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
test('items rỗng/không truyền → cả 5 mảng đều rỗng, không ném lỗi', () => {
    assert.deepEqual(reconcileOpenItems({ existing: [], items: [], groupId: 'g1', date: '2026-08-19' }),
        { insert: [], update: [], close: [], skipped: [], revive: [] });
    assert.deepEqual(reconcileOpenItems({ existing: [], groupId: 'g1', date: '2026-08-19' }),
        { insert: [], update: [], close: [], skipped: [], revive: [] });
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

// ── P10 (4): trùng lặp ngữ nghĩa mà slug(what) không bắt được ─────────────────────────────────
// Đo thật 18/08: "Ngủ sớm hơn" · "Ngủ sớm hơn để dần vào guồng dậy đúng giờ" ·
// "Kết thúc công việc sớm hơn và ngủ sớm hơn" · "Kết thúc công việc sớm hơn để ngủ sớm" — 4 dòng
// cho 1-2 việc thật. `fuzzyKey` (bỏ dấu + bỏ stopword + sắp từ) là mức RẺ, KHÔNG phải NLP đầy đủ —
// chỉ bắt được khi tập từ (sau khi bỏ từ nối) giống hệt nhau, không bắt được diễn đạt khác từ vựng.

test('fuzzyKey: 2 câu chỉ khác từ NỐI (và/để) nhưng cùng tập từ chính → CÙNG key', () => {
    assert.equal(
        fuzzyKey('Kết thúc công việc sớm hơn và ngủ sớm hơn'),
        fuzzyKey('Kết thúc công việc sớm hơn để ngủ sớm'),
    );
});

test('fuzzyKey: câu ngắn và câu dài hơn nhiều từ (dù cùng chủ đề) → key KHÁC nhau — giới hạn đã biết', () => {
    // "Ngủ sớm hơn" vs "Ngủ sớm hơn để dần vào guồng dậy đúng giờ": tập từ chính khác nhau thật sự
    // (câu sau có thêm dặn dò cụ thể) — mức rẻ CHƯA gộp được cặp này, ghi lại để không ai tưởng bug.
    assert.notEqual(fuzzyKey('Ngủ sớm hơn'), fuzzyKey('Ngủ sớm hơn để dần vào guồng dậy đúng giờ'));
});

test('fuzzyKey: rỗng/chỉ toàn stopword → chuỗi rỗng, không ném lỗi', () => {
    assert.equal(fuzzyKey(''), '');
    assert.equal(fuzzyKey('   '), '');
    assert.equal(fuzzyKey('và để hơn'), '');
    assert.equal(fuzzyKey(undefined), '');
});

test('reconcileOpenItems: việc DIỄN ĐẠT KHÁC nhưng cùng tập từ chính khớp title việc AI đã có → gặp lại, KHÔNG insert đôi', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 't-rem', title: 'Kết thúc công việc sớm hơn và ngủ sớm hơn', dedupe_key: slugOf('Kết thúc công việc sớm hơn và ngủ sớm hơn'), source: 'ai', status: 'todo' }],
        items: [{ what: 'Kết thúc công việc sớm hơn để ngủ sớm', state: 'pending' }],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.insert.length, 0, 'không được tạo việc mới — đây là cùng một việc, chỉ diễn đạt khác');
    assert.deepEqual(r.update, [{ id: 't-rem', dedupeKey: slugOf('Kết thúc công việc sớm hơn và ngủ sớm hơn'), lastSeenDate: '2026-08-19' }]);
});

test('reconcileOpenItems: fuzzy match KHÔNG được ghi đè việc gõ tay — vẫn skipped như dedupe_key cũ', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 'm1', title: 'Kết thúc công việc sớm hơn và ngủ sớm hơn', dedupe_key: slugOf('Kết thúc công việc sớm hơn và ngủ sớm hơn'), source: 'manual', status: 'todo' }],
        items: [{ what: 'Kết thúc công việc sớm hơn để ngủ sớm', state: 'pending' }],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.insert.length, 0);
    assert.equal(r.update.length, 0);
    assert.equal(r.skipped.length, 1, 'khớp ngữ nghĩa với việc gõ tay vẫn phải bị chặn y hệt khớp dedupe_key');
});

test('reconcileOpenItems: hai item CÙNG NGÀY diễn đạt khác nhau nhưng cùng tập từ chính → chỉ insert 1', () => {
    const r = reconcileOpenItems({
        existing: [],
        items: [
            { what: 'Kết thúc công việc sớm hơn và ngủ sớm hơn' },
            { what: 'Kết thúc công việc sớm hơn để ngủ sớm' },
        ],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.insert.length, 1);
});

test('reconcileOpenItems: existing thiếu `title` → chỉ so được dedupe_key cũ, không lỗi, không fuzzy-match nhầm', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 't1', dedupe_key: 'khong-lien-quan', source: 'ai', status: 'todo' }], // không có title
        items: [{ what: 'Kết thúc công việc sớm hơn để ngủ sớm', state: 'pending' }],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.insert.length, 1, 'không có title để so ngữ nghĩa thì coi là việc mới, không ném lỗi');
});

// ── P14 (5): "Từ chối" là bia mộ (review_state='rejected') — reconcile phải BỎ QUA khi còn hiệu
// lực, và cho quay lại "Chờ xác nhận" (không tự duyệt) khi bia mộ đã hết hạn (30 ngày).

test('reconcileOpenItems: khớp dedupe_key với bia mộ CÒN hiệu lực (< 30 ngày) → skipped, không insert/update', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 't-rej', dedupe_key: 'viec-bi-tu-choi', source: 'ai', status: 'todo', review_state: 'rejected', updated_at: new Date('2026-08-10T00:00:00Z').getTime() }],
        items: [{ what: 'Việc bị từ chối' }],
        groupId: 'g1',
        date: '2026-08-20', // 10 ngày sau khi từ chối
    });
    assert.equal(r.insert.length, 0);
    assert.equal(r.update.length, 0);
    assert.equal(r.revive.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /bia mộ còn hiệu lực/);
});

test('reconcileOpenItems: bia mộ đúng 30 ngày (ranh giới) vẫn CÒN hiệu lực, 31 ngày thì HẾT', () => {
    const rejectedAt = new Date('2026-08-01T00:00:00Z').getTime();
    const atBoundary = reconcileOpenItems({
        existing: [{ id: 't1', dedupe_key: 'x', source: 'ai', review_state: 'rejected', updated_at: rejectedAt }],
        items: [{ what: 'X' }], groupId: 'g1', date: '2026-08-31', // đúng 30 ngày
    });
    assert.equal(atBoundary.skipped.length, 1, 'đúng 30 ngày vẫn tính là CÒN hiệu lực');
    assert.equal(atBoundary.revive.length, 0);

    const pastBoundary = reconcileOpenItems({
        existing: [{ id: 't1', dedupe_key: 'x', source: 'ai', review_state: 'rejected', updated_at: rejectedAt }],
        items: [{ what: 'X' }], groupId: 'g1', date: '2026-09-01', // 31 ngày
    });
    assert.equal(pastBoundary.skipped.length, 0);
    assert.equal(pastBoundary.revive.length, 1, 'qua 30 ngày thì hết hiệu lực, cho quay lại');
});

test('reconcileOpenItems: bia mộ HẾT hiệu lực (> 30 ngày) → revive, KHÔNG tự đặt review_state (đó là việc của caller/DB)', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 't-old', dedupe_key: 'viec-cu', source: 'ai', status: 'todo', review_state: 'rejected', updated_at: new Date('2026-06-01T00:00:00Z').getTime() }],
        items: [{ what: 'Việc cũ' }],
        groupId: 'g1',
        date: '2026-08-19', // gần 80 ngày sau
    });
    assert.equal(r.skipped.length, 0);
    assert.equal(r.insert.length, 0, 'không tạo dòng mới — phải dùng lại dòng cũ để giữ dedupe_key');
    assert.deepEqual(r.revive, [{ id: 't-old', dedupeKey: 'viec-cu', lastSeenDate: '2026-08-19' }]);
});

test('reconcileOpenItems: bia mộ thiếu `updated_at` → coi như đã hết hiệu lực (an toàn hơn khoá mãi mãi)', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 't-no-ts', dedupe_key: 'thieu-moc', source: 'ai', review_state: 'rejected' }],
        items: [{ what: 'Thiếu mốc' }],
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.revive.length, 1);
    assert.equal(r.skipped.length, 0);
});

test('reconcileOpenItems: bia mộ khớp qua fuzzyKey (không phải dedupe_key) cũng bị chặn y hệt khi còn hiệu lực', () => {
    const r = reconcileOpenItems({
        existing: [{ id: 't-rej2', title: 'Kết thúc công việc sớm hơn và ngủ sớm hơn', dedupe_key: slugOf('Kết thúc công việc sớm hơn và ngủ sớm hơn'), source: 'ai', review_state: 'rejected', updated_at: new Date('2026-08-15T00:00:00Z').getTime() }],
        items: [{ what: 'Kết thúc công việc sớm hơn để ngủ sớm' }], // diễn đạt khác, chỉ khớp fuzzyKey
        groupId: 'g1',
        date: '2026-08-19',
    });
    assert.equal(r.skipped.length, 1, 'khớp ngữ nghĩa với bia mộ vẫn phải bị chặn như khớp dedupe_key');
});

test('REJECT_TOMBSTONE_DAYS export đúng giá trị đã dùng để test (30)', () => {
    assert.equal(REJECT_TOMBSTONE_DAYS, 30);
});

/** Trùng đúng slug() thật trong task-reconcile.js — tránh lặp lại thuật toán trong test. */
function slugOf(text) {
    return String(text)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}
