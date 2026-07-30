import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// index.js chạy trong closure register() nên không import trực tiếp được. Theo đúng lối của
// dashboard-permissions.test.js: trích hàm cần kiểm rồi chạy thật với dependency được nạp vào —
// kiểm HÀNH VI, không kiểm chuỗi văn bản.
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function extract(signature) {
    const re = new RegExp(`(?:async )?function ${signature}\\([\\s\\S]*?\\n        \\}`);
    const match = source.match(re);
    assert.ok(match, `không tìm thấy hàm ${signature}() trong index.js`);
    return match[0];
}

const normalizeReportJob = new Function(
    `${extract('normReportTime')}\n${extract('normalizeReportJob')}\nreturn normalizeReportJob;`,
)();

test('digest KHÔNG được giữ eachGroup — một tin gộp không thuộc nhóm nào để gửi vào', () => {
    const j = normalizeReportJob({ kind: 'digest', groups: ['a'], deliver: { eachGroup: true, ownerDm: true } });
    assert.equal(j.kind, 'digest');
    assert.equal(j.deliver.eachGroup, false, 'digest phải tự tắt eachGroup');
    assert.equal(j.deliver.ownerDm, true);
});

test('báo cáo lẻ thì eachGroup được giữ', () => {
    const j = normalizeReportJob({ kind: 'group', groups: ['a'], deliver: { eachGroup: true } });
    assert.equal(j.deliver.eachGroup, true);
});

test('giờ được zero-pad để so sánh chuỗi theo giờ VN không lệch', () => {
    assert.equal(normalizeReportJob({ time: '9:05' }).time, '09:05');
    assert.equal(normalizeReportJob({ time: 'rác' }).time, '23:55', 'giờ vô nghĩa → mặc định');
});

test("groups '*' được giữ nguyên để resolve lúc chạy, không đóng băng danh sách", () => {
    assert.equal(normalizeReportJob({ groups: '*' }).groups, '*');
    assert.deepEqual(normalizeReportJob({ groups: ['a', '', 'b'] }).groups, ['a', 'b']);
    assert.deepEqual(normalizeReportJob({}).groups, [], 'thiếu groups → mảng rỗng, không phải *');
});

test('enabled mặc định bật; input không phải object → null', () => {
    assert.equal(normalizeReportJob({}).enabled, true);
    assert.equal(normalizeReportJob({ enabled: false }).enabled, false);
    assert.equal(normalizeReportJob(null), null);
    assert.equal(normalizeReportJob('x'), null);
});

test('tên rỗng thì tự đặt theo kiểu báo cáo', () => {
    assert.equal(normalizeReportJob({ kind: 'digest' }).name, 'Báo cáo tổng hợp');
    assert.equal(normalizeReportJob({ kind: 'group' }).name, 'Báo cáo từng nhóm');
});

// ── Cắt digest ────────────────────────────────────────────────────────────────────────────────
// Zalo tự cắt tin quá dài và cắt GIỮA CÂU — chính là thứ owner phàn nàn. Digest phải tự cắt trước
// theo ranh giới NHÓM. Nạp buildDigestParts giả để kiểm riêng phần cắt.
function loadSplitter(parts, safeChars = 3500) {
    return new Function('parts', 'DIGEST_SAFE_CHARS', `
        const buildDigestParts = async () => parts;
        ${extract('buildDigestMessages')}
        return buildDigestMessages([], '2026-07-29');
    `)(parts, safeChars);
}

const block = (name, size) => `📋 ${name} — 10 tin · 3 người\n  • ${'x'.repeat(size)}`;

test('ít nhóm → đúng một tin, không có nhãn phần', async () => {
    const texts = await loadSplitter({
        blocks: [block('A', 50), block('B', 50)], totalMsgs: 20, totalLinks: 2, totalAppts: 1, groupCount: 2,
    });
    assert.equal(texts.length, 1);
    assert.match(texts[0], /^📊 TỔNG HỢP 2026-07-29 · 2 nhóm · 20 tin/);
    assert.doesNotMatch(texts[0], /phần/);
    assert.match(texts[0], /🔗 2 link · 📅 1 hẹn lịch/);
});

test('nhiều nhóm → cắt thành nhiều phần, mỗi phần có tiêu đề và nhãn phần', async () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`Nhóm ${i}`, 400));
    const texts = await loadSplitter({ blocks, totalMsgs: 300, totalLinks: 0, totalAppts: 0, groupCount: 12 });
    assert.ok(texts.length > 1, 'phải tách thành nhiều tin');
    for (const [i, tx] of texts.entries()) {
        assert.match(tx, /^📊 TỔNG HỢP 2026-07-29/, `tin ${i + 1} phải có tiêu đề`);
        assert.match(tx, new RegExp(`\\(phần ${i + 1}/${texts.length}\\)`), `tin ${i + 1} phải ghi rõ phần`);
    }
});

test('cắt ĐÚNG ranh giới nhóm — không nhóm nào bị xé làm hai', async () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`Nhóm ${i}`, 400));
    const texts = await loadSplitter({ blocks, totalMsgs: 300, totalLinks: 0, totalAppts: 0, groupCount: 12 });
    const joined = texts.join('\n');
    for (const b of blocks) {
        assert.ok(joined.includes(b), 'mỗi block phải còn nguyên vẹn trong đúng một tin');
        assert.equal(texts.filter(tx => tx.includes(b)).length, 1, 'block không được xuất hiện ở hai tin');
    }
});

test('footer chỉ nằm ở tin cuối', async () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`Nhóm ${i}`, 400));
    const texts = await loadSplitter({ blocks, totalMsgs: 300, totalLinks: 5, totalAppts: 2, groupCount: 12 });
    assert.equal(texts.filter(tx => tx.includes('xem chi tiết ở dashboard')).length, 1);
    assert.match(texts.at(-1), /xem chi tiết ở dashboard/);
});

test('không nhóm nào có tin → nói rõ, không gửi tin rỗng', async () => {
    const texts = await loadSplitter({ blocks: [], totalMsgs: 0, totalLinks: 0, totalAppts: 0, groupCount: 0 });
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Không có nhóm nào có tin nhắn/);
});
