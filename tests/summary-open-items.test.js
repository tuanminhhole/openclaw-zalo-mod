import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// P2: `openItems` là field mới trong schema JSON của generateDailySummary — RÚT thô từ output AI,
// không quyết định trạng thái cuối cùng (đó là việc của task-reconcile.js). Vì model không đảm bảo
// tuân thủ đúng giới hạn đã dặn trong prompt (≤8 việc, ≤120 ký tự, state hợp lệ), normalizeOpenItems
// phải tự phòng vệ — lỗi ở đây không được làm hỏng các field khác của bản tổng hợp.
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function extract(signature) {
    const re = new RegExp(`(?:async )?function ${signature}\\([\\s\\S]*?\\n        \\}`);
    const match = source.match(re);
    assert.ok(match, `không tìm thấy hàm ${signature}() trong index.js`);
    return match[0];
}
const normalizeOpenItems = new Function(
    `const OPEN_ITEM_STATES = new Set(['pending', 'done', 'blocked']);\n${extract('normalizeOpenItems')}\nreturn normalizeOpenItems;`,
)();

test('input không phải mảng → mảng rỗng, không ném lỗi', () => {
    assert.deepEqual(normalizeOpenItems(undefined), []);
    assert.deepEqual(normalizeOpenItems(null), []);
    assert.deepEqual(normalizeOpenItems('rác'), []);
    assert.deepEqual(normalizeOpenItems({}), []);
});

test('item hợp lệ giữ nguyên đủ 5 field', () => {
    const out = normalizeOpenItems([
        { what: 'Gửi bổ sung giấy tờ', who: 'An', due: '19/08', state: 'pending', evidence: '09:15' },
    ]);
    assert.deepEqual(out, [{ what: 'Gửi bổ sung giấy tờ', who: 'An', due: '19/08', state: 'pending', evidence: '09:15' }]);
});

test('quá 8 việc → cắt còn 8', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ what: `việc ${i}` }));
    assert.equal(normalizeOpenItems(items).length, 8);
});

test('what quá 120 ký tự → cắt, không ném lỗi', () => {
    const out = normalizeOpenItems([{ what: 'x'.repeat(200) }]);
    assert.equal(out[0].what.length, 120);
});

test('who không rõ → giữ rỗng, KHÔNG đoán tên', () => {
    const out = normalizeOpenItems([{ what: 'chốt đơn' }]);
    assert.equal(out[0].who, '');
});

test('state lạ/thiếu → mặc định "pending", không rơi field khác', () => {
    assert.equal(normalizeOpenItems([{ what: 'a', state: 'huỷ' }])[0].state, 'pending');
    assert.equal(normalizeOpenItems([{ what: 'a' }])[0].state, 'pending');
    assert.equal(normalizeOpenItems([{ what: 'a', state: 'done' }])[0].state, 'done');
});

test('what rỗng sau khi trim → loại khỏi kết quả (không ghi việc trống)', () => {
    assert.deepEqual(normalizeOpenItems([{ what: '   ' }, { what: 'việc thật' }]), [
        { what: 'việc thật', who: '', due: '', state: 'pending', evidence: '' },
    ]);
});
