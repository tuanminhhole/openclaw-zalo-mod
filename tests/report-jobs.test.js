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

// REPORT_FOR_VALUES/ISO_DATE_RE là `const` (extract() chỉ bắt được `function`) — khai lại tại đây,
// y hệt định nghĩa trong index.js gần `normalizeReportForFields`.
const REPORT_FOR_CONSTS = `
    const REPORT_FOR_VALUES = new Set(['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'custom']);
    const ISO_DATE_RE = /^\\d{4}-\\d{2}-\\d{2}$/;
`;
const normalizeReportJob = new Function(
    `${REPORT_FOR_CONSTS}\n${extract('normReportTime')}\n${extract('normalizeReportForFields')}\n${extract('normalizeReportJob')}\nreturn normalizeReportJob;`,
)();

test('digest KHÔNG được giữ eachGroup — một tin gộp không thuộc nhóm nào để gửi vào', () => {
    const j = normalizeReportJob({ kind: 'digest', groups: ['a'], deliver: { eachGroup: true, ownerDm: true } });
    assert.equal(j.kind, 'digest');
    assert.equal(j.deliver.eachGroup, false, 'digest phải tự tắt eachGroup');
    assert.equal(j.deliver.ownerDm, true);
});

// P3: kind:'backlog' — một tin gộp như digest, không có "nhóm của chính nó" nên cũng phải tự tắt eachGroup.
test('backlog cũng KHÔNG giữ eachGroup, và có tên mặc định riêng', () => {
    const j = normalizeReportJob({ kind: 'backlog', groups: '*', deliver: { eachGroup: true } });
    assert.equal(j.kind, 'backlog');
    assert.equal(j.deliver.eachGroup, false);
    assert.equal(j.name, 'Việc còn treo');
});

test('kind lạ (không phải digest/backlog) → mặc định group, giữ hành vi cũ', () => {
    assert.equal(normalizeReportJob({ kind: 'rác' }).kind, 'group');
    assert.equal(normalizeReportJob({}).kind, 'group');
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
        return buildDigestMessages([], { from: '2026-07-29', to: '2026-07-29' });
    `)(parts, safeChars);
}

const block = (name, size) => `📋 ${name} — 10 tin · 3 người\n  • ${'x'.repeat(size)}`;

test('ít nhóm → đúng một tin, không có nhãn phần', async () => {
    const { texts } = await loadSplitter({
        blocks: [block('A', 50), block('B', 50)], totalMsgs: 20, totalLinks: 2, totalAppts: 1, groupCount: 2,
    });
    assert.equal(texts.length, 1);
    assert.match(texts[0], /^📊 TỔNG HỢP 2026-07-29 · 2 nhóm · 20 tin/);
    assert.doesNotMatch(texts[0], /phần/);
    assert.match(texts[0], /🔗 2 link · 📅 1 hẹn lịch/);
});

test('nhiều nhóm → cắt thành nhiều phần, mỗi phần có tiêu đề và nhãn phần', async () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`Nhóm ${i}`, 400));
    const { texts } = await loadSplitter({ blocks, totalMsgs: 300, totalLinks: 0, totalAppts: 0, groupCount: 12 });
    assert.ok(texts.length > 1, 'phải tách thành nhiều tin');
    for (const [i, tx] of texts.entries()) {
        assert.match(tx, /^📊 TỔNG HỢP 2026-07-29/, `tin ${i + 1} phải có tiêu đề`);
        assert.match(tx, new RegExp(`\\(phần ${i + 1}/${texts.length}\\)`), `tin ${i + 1} phải ghi rõ phần`);
    }
});

test('cắt ĐÚNG ranh giới nhóm — không nhóm nào bị xé làm hai', async () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`Nhóm ${i}`, 400));
    const { texts } = await loadSplitter({ blocks, totalMsgs: 300, totalLinks: 0, totalAppts: 0, groupCount: 12 });
    const joined = texts.join('\n');
    for (const b of blocks) {
        assert.ok(joined.includes(b), 'mỗi block phải còn nguyên vẹn trong đúng một tin');
        assert.equal(texts.filter(tx => tx.includes(b)).length, 1, 'block không được xuất hiện ở hai tin');
    }
});

test('footer chỉ nằm ở tin cuối', async () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`Nhóm ${i}`, 400));
    const { texts } = await loadSplitter({ blocks, totalMsgs: 300, totalLinks: 5, totalAppts: 2, groupCount: 12 });
    assert.equal(texts.filter(tx => tx.includes('xem chi tiết ở dashboard')).length, 1);
    assert.match(texts.at(-1), /xem chi tiết ở dashboard/);
});

test('không nhóm nào có tin → nói rõ, không gửi tin rỗng', async () => {
    const { texts } = await loadSplitter({ blocks: [], totalMsgs: 0, totalLinks: 0, totalAppts: 0, groupCount: 0 });
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Không có nhóm nào có tin nhắn/);
});

// ── Digest nhiều ngày (P1) — chỉ đọc cache cho ngày ĐÃ QUA, gộp theo NHÓM ─────────────────────
// Range >1 ngày không được đụng LLM cho ngày cũ: 30 nhóm × N ngày sinh lại là hàng trăm lượt gọi
// model cho một tin. `rawHistory` (tuỳ chọn) mô phỏng nhật ký thô: khoá `gid|date` → mảng tin.
// Không khai key nào = mặc định CÓ tin thật (giữ đúng kỳ vọng test cũ: thiếu summary = thiếu thật).
// Chỉ khai `[]` cho đúng ngày/nhóm muốn mô phỏng "chủ nhật không ai nhắn".
//
// P7: ngày CUỐI của range (`to` = runDate) được phép sinh lại nếu thiếu/thiếu-cập-nhật — sandbox
// giờ ĐỊNH NGHĨA `generateDailySummary` (khác P1/P1b cố tình để undefined), nhưng có SPY `generated`
// để test khẳng định nó CHỈ được gọi cho đúng `to`, không bao giờ cho ngày trước đó.
function loadRangeDigest(summaries, rawHistory = {}, generated = []) {
    return new Function('summaries', 'rawHistory', 'generated', `
        // CỐ Ý không định nghĩa callSmartRoute: generateDailySummary ở đây là BẢN GIẢ (không gọi AI
        // thật), nên nhánh nào lỡ gọi thẳng callSmartRoute (bỏ qua generateDailySummary) vẫn nổ
        // ReferenceError ngay.
        const getSummary = async (gid, d) => summaries[gid + '|' + d] || null;
        const readChatHistory = async (gid, d) => {
            const key = gid + '|' + d;
            return key in rawHistory ? rawHistory[key] : [{ fake: true }];
        };
        const generateDailySummary = async (gid, d, opts = {}) => {
            generated.push(gid + '|' + d);
            const rows = await readChatHistory(gid, d);
            const s = { messageCount: rows.length, sections: { highlights: ['gen'], participants: ['p'] } };
            if (opts.save !== false) summaries[gid + '|' + d] = s;
            return s;
        };
        const getGroupName = (g) => 'Nhóm ' + g;
        ${extract('addDaysStr')}
        ${extract('dateRangeList')}
        ${extract('ensureFreshSummary')}
        ${extract('buildDigestParts')}
        ${extract('buildDigestMessages')}
        return { buildDigestParts, buildDigestMessages };
    `)(summaries, rawHistory, generated);
}

test('range nhiều ngày: ngày ĐÃ QUA thiếu cache thì bỏ qua (KHÔNG sinh lại), chỉ ngày CUỐI (to) mới được sinh', async () => {
    const generated = [];
    const { buildDigestParts } = loadRangeDigest({
        'g1|2026-08-12': { messageCount: 3, sections: { highlights: ['a'], participants: ['p'] } },
        'g1|2026-08-14': { messageCount: 2, sections: { highlights: ['b'], participants: ['p'] } },
        // 2026-08-13, 15 KHÔNG có cache — đã qua hẳn, không được tự sinh để lấp.
        // 2026-08-16 = `to`: cũng không có cache → ĐÂY mới được sinh (P7).
    }, {}, generated);
    const r = await buildDigestParts(['g1'], { from: '2026-08-12', to: '2026-08-16' });
    assert.deepEqual(generated, ['g1|2026-08-16'], 'chỉ đúng ngày cuối được sinh, không phải 08-13/08-15');
    assert.equal(r.totalMsgs, 6, '3 (cache 08-12) + 2 (cache 08-14) + 1 (sinh mới 08-16, rawHistory mặc định 1 tin)');
    assert.deepEqual(r.missingDates, ['2026-08-13', '2026-08-15'], '08-16 không còn thiếu vì đã được sinh');
});

// Bằng chứng "cứng" hơn: dựng cache của NGÀY CUỐI khớp sẵn với nhật ký thô (không có lý do gì phải
// sinh lại), rồi KHÔNG định nghĩa generateDailySummary/callSmartRoute — nổ ReferenceError ngay nếu
// bất kỳ ngày nào trong range (kể cả ngày cuối) lỡ gọi tới, không chỉ dựa vào spy đếm 0 lần.
function loadRangeDigestNoGen(summaries, rawHistory = {}) {
    return new Function('summaries', 'rawHistory', `
        const getSummary = async (gid, d) => summaries[gid + '|' + d] || null;
        const readChatHistory = async (gid, d) => {
            const key = gid + '|' + d;
            return key in rawHistory ? rawHistory[key] : [{ fake: true }];
        };
        const getGroupName = (g) => 'Nhóm ' + g;
        ${extract('addDaysStr')}
        ${extract('dateRangeList')}
        ${extract('ensureFreshSummary')}
        ${extract('buildDigestParts')}
        ${extract('buildDigestMessages')}
        return { buildDigestParts, buildDigestMessages };
    `)(summaries, rawHistory);
}

test('range nhiều ngày: cache ngày cuối đã khớp nhật ký thô → KHÔNG sinh lại (ReferenceError nếu lỡ gọi)', async () => {
    const { buildDigestParts } = loadRangeDigestNoGen(
        {
            'g1|2026-08-12': { messageCount: 3, sections: { highlights: ['a'], participants: ['p'] } },
            // `to` = 2026-08-14, cache messageCount=1 khớp ĐÚNG rawHistory mặc định (1 tin) → không
            // có lý do gì để sinh lại.
            'g1|2026-08-14': { messageCount: 1, sections: { highlights: ['b'], participants: ['p'] } },
        },
    );
    const r = await buildDigestParts(['g1'], { from: '2026-08-12', to: '2026-08-14' });
    assert.equal(r.totalMsgs, 4);
    assert.deepEqual(r.missingDates, ['2026-08-13']);
});

test('last7 thiếu 2 ngày → dòng cảnh báo đúng số lượng và đúng ngày', async () => {
    const { buildDigestMessages } = loadRangeDigest({
        'g1|2026-08-12': { messageCount: 1, sections: {} },
        'g1|2026-08-13': { messageCount: 1, sections: {} },
        'g1|2026-08-15': { messageCount: 1, sections: {} },
        'g1|2026-08-16': { messageCount: 1, sections: {} },
        'g1|2026-08-17': { messageCount: 1, sections: {} },
        // 7 ngày 11..17, thiếu đúng 11 và 14.
    });
    const { texts, missingDates } = await buildDigestMessages(['g1'], { from: '2026-08-11', to: '2026-08-17' });
    assert.deepEqual(missingDates, ['2026-08-11', '2026-08-14']);
    assert.match(texts.join('\n'), /⚠️ 2\/7 ngày chưa có bản tổng hợp: 2026-08-11 · 2026-08-14/);
});

// ── P1b: chủ nhật không ai nhắn KHÔNG được coi là "thiếu bản tổng hợp" ────────────────────────
// Số đo thật 2026-08-16 (chủ nhật): digest ra "0 nhóm · 0 tin" với 33 nhóm raw = 0 — không thiếu gì
// cả. last7 luôn chứa 1 chủ nhật ⇒ nếu không vá thì tin nào cũng có dòng ⚠️ sai, owner lại tưởng
// bot hỏng (đúng vòng lặp đã đi hai lần 31/07 → 09/08).
test('ngày không ai nhắn (raw=0 mọi nhóm) → KHÔNG vào missingDates', async () => {
    const { buildDigestParts } = loadRangeDigest(
        { 'g1|2026-08-15': { messageCount: 2, sections: {} }, 'g1|2026-08-17': { messageCount: 1, sections: {} } },
        // 2026-08-16 (chủ nhật): không nhóm nào có summary VÀ không nhóm nào có tin thô → không thiếu.
        { 'g1|2026-08-16': [] },
    );
    const r = await buildDigestParts(['g1'], { from: '2026-08-15', to: '2026-08-17' });
    assert.deepEqual(r.missingDates, [], 'ngày chủ nhật không hoạt động không được ghi là thiếu');
});

test('ngày có tin mà thiếu summary (raw>0) → VẪN vào missingDates', async () => {
    const { buildDigestParts } = loadRangeDigest(
        { 'g1|2026-08-15': { messageCount: 2, sections: {} }, 'g1|2026-08-17': { messageCount: 1, sections: {} } },
        // 2026-08-16: có tin thô thật nhưng chưa từng sinh summary — đây là thiếu THẬT, phải cảnh báo.
        { 'g1|2026-08-16': [{ t: '10:00', text: 'có tin' }] },
    );
    const r = await buildDigestParts(['g1'], { from: '2026-08-15', to: '2026-08-17' });
    assert.deepEqual(r.missingDates, ['2026-08-16']);
});

test('range nhiều ngày, ngày ĐÃ QUA: cả hai nhóm im lặng thì không thiếu; nhóm có tin thì thiếu thật', async () => {
    // `to` (2026-08-17) có cache khớp sẵn rawHistory mặc định (1 tin) → không kích hoạt sinh lại
    // (P7) — giữ phép kiểm này tập trung đúng vào 2 NGÀY ĐÃ QUA (08-15, 08-16), không lẫn với luật
    // ngày cuối.
    const { buildDigestParts } = loadRangeDigest(
        { 'g1|2026-08-17': { messageCount: 1, sections: {} }, 'g2|2026-08-17': { messageCount: 1, sections: {} } },
        {
            'g1|2026-08-15': [], 'g2|2026-08-15': [{ t: '08:00', text: 'x' }], // một nhóm có tin → thiếu thật
            'g1|2026-08-16': [], 'g2|2026-08-16': [], // cả hai im lặng → không thiếu
        },
    );
    const r = await buildDigestParts(['g1', 'g2'], { from: '2026-08-15', to: '2026-08-17' });
    assert.deepEqual(r.missingDates, ['2026-08-15']);
});

test('gộp nhiều ngày CỘNG số tin, ưu tiên highlight ngày MỚI NHẤT trước', async () => {
    const { buildDigestParts } = loadRangeDigest({
        'g1|2026-08-10': { messageCount: 2, sections: { highlights: ['cũ'], participants: ['a'] } },
        'g1|2026-08-11': { messageCount: 3, sections: { highlights: ['mới'], participants: ['a', 'b'] } },
    });
    const r = await buildDigestParts(['g1'], { from: '2026-08-10', to: '2026-08-11' });
    assert.equal(r.totalMsgs, 5, 'cộng dồn tin cả kỳ, không lấy ngày cuối');
    assert.match(r.blocks[0], /^📋 Nhóm g1 — 5 tin · 2 người/, 'participants lấy MAX quan sát được trong kỳ');
    const bulletLines = r.blocks[0].split('\n').slice(1);
    assert.deepEqual(bulletLines, ['  • mới', '  • cũ'], 'ngày mới nhất (08-11) phải đứng trước ngày cũ hơn');
});

// ── Xem trước (dashboard) phải ra ĐÚNG range của lịch, không phải luôn "hôm nay" ──────────────
// Mô phỏng lại đúng pipeline của action `report-digest-preview` trong runDashboardAction:
// normalizeReportForFields(payload) → reportRangeFor(...) → buildDigestMessages(...). Không chạy
// được nút thật trên dashboard ở máy Mac (không có gateway/session Zalo sống ở đây), nên đây là
// bằng chứng thay thế: ghép đúng 3 hàm thật của index.js, không phải hàm giả lập lại logic.
function simulatePreview({ summaries, payload, runDate }) {
    return new Function('summaries', 'payload', 'runDate', `
        ${REPORT_FOR_CONSTS}
        const getSummary = async (gid, d) => summaries[gid + '|' + d] || null;
        const getGroupName = (g) => 'Nhóm ' + g;
        // Range 1 ngày (ví dụ 'yesterday') đi nhánh cũ của buildDigestParts — cache đã đủ (rawCount 1
        // <= cache.messageCount) nên không chạm generateDailySummary. Trả về 1 tin "có thật" (không
        // phải mảng rỗng): nhánh nhiều-ngày dùng readChatHistory để phân biệt "thiếu summary dù có
        // tin" với "chủ nhật không ai nhắn" (P1b).
        const readChatHistory = async () => [{ fake: true }];
        // P7: ngày CUỐI (= runDate) của last7/last30/thisMonth giờ ĐƯỢC sinh lại nếu thiếu/thiếu-cập-
        // nhật, kể cả khi xem trước (persist:false vẫn sinh để hiện đúng nội dung, chỉ không ghi —
        // đúng hợp đồng đã có từ nhánh 1-ngày). Bản giả tôn trọng opts.save như hàm thật.
        const generateDailySummary = async (gid, d, opts = {}) => {
            const rows = await readChatHistory(gid, d);
            const s = { messageCount: rows.length, sections: { highlights: ['gen'], participants: ['p'] } };
            if (opts.save !== false) summaries[gid + '|' + d] = s;
            return s;
        };
        ${extract('addDaysStr')}
        ${extract('dateRangeList')}
        ${extract('normalizeReportForFields')}
        ${extract('reportRangeFor')}
        ${extract('ensureFreshSummary')}
        ${extract('buildDigestParts')}
        ${extract('buildDigestMessages')}
        return (async () => {
            const forFields = normalizeReportForFields(payload);
            const range = reportRangeFor(forFields, runDate);
            const { texts, missingDates } = await buildDigestMessages(['g1'], range, { persist: false });
            return { from: range.from, to: range.to, texts, missingDates };
        })();
    `)(summaries, payload, runDate);
}

test('[d] Xem trước lịch buổi sáng (reportFor:yesterday) ra ĐÚNG hôm qua, không phải hôm nay', async () => {
    const r = await simulatePreview({
        summaries: { 'g1|2026-08-17': { messageCount: 4, sections: { highlights: ['x'], participants: ['a'] } } },
        payload: { reportFor: 'yesterday' },
        runDate: '2026-08-18',
    });
    assert.deepEqual({ from: r.from, to: r.to }, { from: '2026-08-17', to: '2026-08-17' });
    assert.match(r.texts[0], /^📊 TỔNG HỢP 2026-08-17/);
});

test('[d] Xem trước lịch last7 ra ĐÚNG 7 ngày GỘP HÔM NAY (P7), ngày cuối tự sinh nếu thiếu cache', async () => {
    const r = await simulatePreview({
        summaries: { 'g1|2026-08-17': { messageCount: 1, sections: {} } }, // 12–16 thiếu, 17 có cache, 18(=runDate) tự sinh
        payload: { reportFor: 'last7' },
        runDate: '2026-08-18',
    });
    assert.deepEqual({ from: r.from, to: r.to }, { from: '2026-08-12', to: '2026-08-18' });
    // 5 ngày thiếu (12-16) — 17 có cache sẵn, 18 (=to) được TỰ SINH (P7) nên không còn thiếu.
    assert.equal(r.missingDates.length, 5);
    assert.match(r.texts.join('\n'), /⚠️ 5\/7 ngày chưa có bản tổng hợp/);
});

test('[d] Xem trước lịch custom quá 92 ngày tự clamp — preview không âm thầm đọc cả năm', async () => {
    const r = await simulatePreview({
        summaries: {},
        payload: { reportFor: 'custom', rangeFrom: '2025-01-01', rangeTo: '2026-08-18' },
        runDate: '2026-08-18',
    });
    const dayCount = (new Date(`${r.to}T00:00:00Z`) - new Date(`${r.from}T00:00:00Z`)) / 86400000 + 1;
    assert.equal(dayCount, 92, 'phải bị clamp về 92 ngày, không đọc nguyên rangeFrom gốc');
});

test('range nhiều ngày mà không nhóm nào có tin → nói rõ trong tin, không gửi rỗng-im-lặng', async () => {
    // `to` (08-11) im lặng thật (raw=[]) → P7 vẫn sinh lại (đúng luật), nhưng ra summary 0 tin nên
    // không còn tính là "thiếu" nữa — nó có bản tổng hợp thật, chỉ là rỗng. Chỉ 08-10 (đã qua, mặc
    // định coi có hoạt động) còn thiếu.
    const { buildDigestMessages } = loadRangeDigest({}, { 'g1|2026-08-11': [] });
    const { texts } = await buildDigestMessages(['g1'], { from: '2026-08-10', to: '2026-08-11' });
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Không có nhóm nào có tin nhắn được ghi trong khoảng này/);
    assert.match(texts[0], /⚠️ 1\/2 ngày chưa có bản tổng hợp: 2026-08-10/);
});

// ── Migration chỉ chạy MỘT LẦN ────────────────────────────────────────────────────────────────
// Bug thật gặp trên production (2026-07-30): owner xoá cả 2 lịch thì chúng hiện lại ngay. Vì
// migration dùng "danh sách rỗng" làm dấu hiệu chưa-migrate — mà đó cũng đúng là trạng thái sau khi
// xoá hết, nên nó dựng lại đúng những lịch vừa xoá và nút Xoá trông như không có tác dụng.
// Phải là một CỜ riêng, độc lập với số lượng job.
test('cờ migrate là trường riêng, không suy ra từ số lượng job', () => {
    const readSrc = extract('reportJobsMigrated');
    assert.match(readSrc, /migratedLegacyAt/, 'phải đọc cờ riêng');
    assert.doesNotMatch(readSrc, /jobs\.length|existing\.length/, 'không được suy ra từ số job');
});

test('xoá hết lịch thì migration KHÔNG dựng lại', () => {
    const src = extract('ensureReportJobsMigrated');
    // Cờ phải được kiểm TRƯỚC nhánh nhìn vào existing.length.
    const flagAt = src.indexOf('reportJobsMigrated()');
    const lenAt = src.indexOf('existing.length');
    assert.ok(flagAt > -1, 'phải kiểm cờ migrate');
    assert.ok(flagAt < lenAt, 'phải kiểm cờ TRƯỚC khi nhìn vào số lượng job, không thì xoá hết là bị dựng lại');
});

test('không có gì để chuyển thì vẫn đóng cờ — khỏi quét lại mỗi phút', () => {
    const src = extract('ensureReportJobsMigrated');
    assert.match(src, /if \(!legacy\.length\) \{[\s\S]*?writeReportJobs\(\[\]\)/, 'phải ghi cờ khi không có lịch cũ');
});

test('ghi lại lịch không được làm mất cờ đã có', () => {
    const src = extract('writeReportJobs');
    assert.match(src, /raw\?\.migratedLegacyAt \|\|/, 'phải giữ mốc cũ nếu đã có');
});

// ── Đổi giờ lịch không được biến thành "gửi ngay" ─────────────────────────────────────────────
// Lỗi thật trên production (vps_asa, 2026-07-30): owner nhờ bot đổi giờ báo cáo, bot lưu đúng,
// nhưng phút kế tiếp 28 nhóm nhận luôn báo cáo thay vì chờ giờ mới — log 15:02:17 gửi "giờ 17:30"
// lúc VN đang 22:02, rồi 15:32:03 gửi "giờ 08:00" lúc VN đang 22:32. Hai nguyên nhân:
// khoá chống trùng kèm cả `time`, và không ai chốt ngày lúc lưu.

/** Chạy runDueReports() thật với clock + storage nạp vào; trả về các job đã gửi và state cuối. */
async function runScheduler({ jobs, now, today, state = {} }) {
    const sent = [];
    const reported = [];
    const warns = [];
    const files = { 'report-state.json': state };
    return new Function('deps', `
        const { jobs, now, today, files, sent, reported, warns } = deps;
        const ensureReportJobsMigrated = async () => jobs;
        const vnDateStr = () => today;
        const vnTimeStr = () => now;
        const readPluginDataJson = async (n) => files[n] || {};
        const writePluginDataJson = async (n, v) => { files[n] = v; };
        const runReportJob = async (job, range) => { sent.push(job.id); reported.push(range); return { sent: 1, groups: 28 }; };
        const logger = { info() {}, warn(m) { warns.push(String(m)); } };
        ${extract('addDaysStr')}
        ${extract('reportRangeFor')}
        ${extract('runDueReports')}
        return runDueReports().then(() => ({ sent, reported, warns, state: files['report-state.json'] }));
    `)({ jobs, now, today, files, sent, reported, warns });
}

const job = (over = {}) => ({ id: 'j1', name: 'BC', enabled: true, kind: 'digest', time: '22:30', groups: '*', deliver: {}, ...over });

test('đã gửi hôm nay rồi thì đổi giờ KHÔNG làm gửi thêm lần nữa', async () => {
    // Đây chính là hồi quy: khoá cũ là {date, time} nên time đổi → job coi như chưa gửi.
    const r = await runScheduler({
        jobs: [job({ time: '08:00' })],
        now: '22:32', today: '2026-07-30',
        state: { byJob: { j1: { date: '2026-07-30', time: '22:30' } }, byGroup: {} },
    });
    assert.deepEqual(r.sent, [], 'một job chỉ gửi tối đa một lần mỗi ngày');
});

test('sửa giờ nhiều lần trong ngày vẫn không sinh thêm báo cáo', async () => {
    let state = { byJob: {}, byGroup: {} };
    const first = await runScheduler({ jobs: [job({ time: '22:30' })], now: '22:31', today: '2026-07-30', state });
    assert.deepEqual(first.sent, ['j1'], 'lần đúng giờ đầu tiên phải gửi');
    state = first.state;
    for (const t of ['08:00', '17:30', '09:15']) {
        const again = await runScheduler({ jobs: [job({ time: t })], now: '22:40', today: '2026-07-30', state });
        assert.deepEqual(again.sent, [], `đổi giờ sang ${t} không được gửi lại`);
        state = again.state;
    }
});

test('bot sập ngang giờ hẹn, bật lại thì vẫn gửi bù đúng một lần', async () => {
    // Không ai chốt ngày trong lúc bot chết → byJob trống → quá giờ mà chưa chốt = gửi bù.
    const first = await runScheduler({ jobs: [job({ time: '08:00' })], now: '09:40', today: '2026-07-30' });
    assert.deepEqual(first.sent, ['j1'], 'phải gửi bù sau khi bật lại');
    const second = await runScheduler({ jobs: [job({ time: '08:00' })], now: '09:41', today: '2026-07-30', state: first.state });
    assert.deepEqual(second.sent, [], 'bù đúng một lần, không lặp mỗi phút');
});

test('chưa tới giờ thì không gửi; job tắt thì không gửi', async () => {
    const early = await runScheduler({ jobs: [job({ time: '22:30' })], now: '21:59', today: '2026-07-30' });
    assert.deepEqual(early.sent, []);
    const off = await runScheduler({ jobs: [job({ time: '08:00', enabled: false })], now: '22:00', today: '2026-07-30' });
    assert.deepEqual(off.sent, []);
});

test('sang ngày mới thì lịch chạy lại theo giờ mới', async () => {
    const r = await runScheduler({
        jobs: [job({ time: '08:00' })],
        now: '08:00', today: '2026-07-31',
        state: { byJob: { j1: { date: '2026-07-30', time: '22:30' } }, byGroup: {} },
    });
    assert.deepEqual(r.sent, ['j1']);
    assert.deepEqual(r.state.byJob.j1, { date: '2026-07-31', time: '08:00' });
});

/** Chạy settleReportDayOnSave() thật; trả về appliesFrom và state cuối. */
async function runSave({ job: j, now, today, state = {} }) {
    const files = { 'report-state.json': state };
    return new Function('deps', `
        const { j, now, today, files } = deps;
        const vnDateStr = () => today;
        const vnTimeStr = () => now;
        const readPluginDataJson = async (n) => files[n] || {};
        const writePluginDataJson = async (n, v) => { files[n] = v; };
        ${extract('settleReportDayOnSave')}
        return settleReportDayOnSave(j).then(appliesFrom => ({ appliesFrom, state: files['report-state.json'] }));
    `)({ j, now, today, files });
}

test('lưu giờ ĐÃ QUA hôm nay → chốt ngày, có hiệu lực từ mai', async () => {
    const r = await runSave({ job: job({ time: '08:00' }), now: '22:35', today: '2026-07-30' });
    assert.equal(r.appliesFrom, 'tomorrow');
    assert.deepEqual(r.state.byJob.j1, { date: '2026-07-30', time: '08:00' },
        'phải đóng dấu hôm nay, không thì scheduler gửi ngay phút sau');
});

test('lưu giờ còn ở TƯƠNG LAI → hôm nay vẫn gửi, không chốt ngày', async () => {
    const r = await runSave({ job: job({ time: '23:00' }), now: '22:35', today: '2026-07-30' });
    assert.equal(r.appliesFrom, 'today');
    assert.equal(r.state.byJob, undefined, 'không được chốt ngày khi giờ chưa tới');
});

test('đã gửi hôm nay rồi thì dù đặt giờ tương lai cũng là mai', async () => {
    const r = await runSave({
        job: job({ time: '23:00' }), now: '22:35', today: '2026-07-30',
        state: { byJob: { j1: { date: '2026-07-30', time: '08:00' } }, byGroup: {} },
    });
    assert.equal(r.appliesFrom, 'tomorrow', 'một báo cáo mỗi ngày — không gửi thêm lần hai');
});

test('chốt ngày không ghi đè dấu đã có (giữ nguyên giờ đã gửi thật)', async () => {
    const r = await runSave({
        job: job({ time: '07:00' }), now: '22:35', today: '2026-07-30',
        state: { byJob: { j1: { date: '2026-07-30', time: '22:30' } }, byGroup: {} },
    });
    assert.equal(r.appliesFrom, 'tomorrow');
    assert.deepEqual(r.state.byJob.j1, { date: '2026-07-30', time: '22:30' });
});

// ── reportRangeFor: bộ chọn khoảng thời gian (P1) ─────────────────────────────────────────────
// Bẫy im lặng gốc (2026-07-31): owner muốn báo cáo 08:00, nhưng digest chỉ tóm tắt NGÀY HIỆN TẠI —
// nên 08:00 sẽ tóm tắt ~8 tiếng đầu ngày (preview ra "0 nhóm · 0 tin"), còn trọn ngày hôm trước
// không bao giờ được báo. Lịch vẫn chạy, vẫn gửi → owner tưởng bot hỏng. `reportRangeFor` generalize
// hoá đúng bài học đó cho 6 giá trị `reportFor`, thay `reportDateFor` (đã bỏ, không còn ai gọi).
const reportRangeFor = new Function(`${extract('addDaysStr')}\n${extract('reportRangeFor')}\nreturn reportRangeFor;`)();

test('today/yesterday: giữ ĐÚNG hành vi cũ, kể cả vắt qua tháng/năm/năm nhuận', () => {
    assert.deepEqual(reportRangeFor({}, '2026-07-31'), { from: '2026-07-31', to: '2026-07-31' }, 'mặc định vẫn hôm nay');
    assert.deepEqual(reportRangeFor({ reportFor: 'today' }, '2026-07-31'), { from: '2026-07-31', to: '2026-07-31' });
    assert.deepEqual(reportRangeFor({ reportFor: 'rác' }, '2026-07-31'), { from: '2026-07-31', to: '2026-07-31' }, 'giá trị lạ → today');
    assert.deepEqual(reportRangeFor({ reportFor: 'yesterday' }, '2026-07-31'), { from: '2026-07-30', to: '2026-07-30' });
    assert.deepEqual(reportRangeFor({ reportFor: 'yesterday' }, '2026-08-01'), { from: '2026-07-31', to: '2026-07-31' }, 'vắt qua tháng');
    assert.deepEqual(reportRangeFor({ reportFor: 'yesterday' }, '2026-01-01'), { from: '2025-12-31', to: '2025-12-31' }, 'vắt qua năm');
    assert.deepEqual(reportRangeFor({ reportFor: 'yesterday' }, '2028-03-01'), { from: '2028-02-29', to: '2028-02-29' }, 'năm nhuận');
});

// P7 (Kent chốt 18/08): ĐỔI HÀNH VI có chủ ý — last7/last30/thisMonth giờ GỘP CẢ HÔM NAY. Định nghĩa
// cũ (loại hôm nay) buộc owner phải tạo thêm một lịch `today` riêng mới thấy đủ; "N ngày qua" theo
// cách hiểu thường ngày CÓ hôm nay. `today`/`yesterday` không đổi (test ở trên vẫn giữ nguyên).
test('last7/last30: 7/30 ngày GỘP CẢ HÔM NAY (P7 — đổi hành vi có chủ ý)', () => {
    assert.deepEqual(reportRangeFor({ reportFor: 'last7' }, '2026-08-18'), { from: '2026-08-12', to: '2026-08-18' });
    assert.deepEqual(reportRangeFor({ reportFor: 'last30' }, '2026-08-18'), { from: '2026-07-20', to: '2026-08-18' });
});

test('thisMonth: từ ngày 1 tháng này tới HÔM NAY (P7); chạy đúng ngày 1 thì range đúng 1 ngày, không âm', () => {
    assert.deepEqual(reportRangeFor({ reportFor: 'thisMonth' }, '2026-08-18'), { from: '2026-08-01', to: '2026-08-18' });
    assert.deepEqual(reportRangeFor({ reportFor: 'thisMonth' }, '2026-08-01'), { from: '2026-08-01', to: '2026-08-01' },
        'chạy đúng ngày 1 đầu tháng: from === to === runDate, không lùi sang tháng trước như định nghĩa cũ');
});

test('custom: nhận đúng rangeFrom/rangeTo khi hợp lệ và from<=to', () => {
    assert.deepEqual(reportRangeFor({ reportFor: 'custom', rangeFrom: '2026-08-01', rangeTo: '2026-08-10' }, '2026-08-18'),
        { from: '2026-08-01', to: '2026-08-10' });
});

test('custom: thiếu/lệch thứ tự → coi như một ngày runDate, không crash', () => {
    assert.deepEqual(reportRangeFor({ reportFor: 'custom' }, '2026-08-18'), { from: '2026-08-18', to: '2026-08-18' }, 'thiếu cả hai');
    assert.deepEqual(
        reportRangeFor({ reportFor: 'custom', rangeFrom: '2026-08-10', rangeTo: '2026-08-01' }, '2026-08-18'),
        { from: '2026-08-18', to: '2026-08-18' }, 'from > to là dữ liệu hỏng');
});

test('custom: quá 92 ngày thì tự CLAMP về 92 ngày gần "đến ngày" nhất, có cờ `clamped`', () => {
    const r = reportRangeFor({ reportFor: 'custom', rangeFrom: '2026-01-01', rangeTo: '2026-08-18' }, '2026-08-18');
    assert.equal(r.to, '2026-08-18');
    assert.equal(r.clamped, true);
    const dayCount = (new Date(`${r.to}T00:00:00Z`) - new Date(`${r.from}T00:00:00Z`)) / 86400000 + 1;
    assert.equal(dayCount, 92, 'đúng 92 ngày kể cả hai đầu');
});

test('custom: đúng 92 ngày thì KHÔNG clamp', () => {
    // 92 ngày kể cả hai đầu: from = to - 91 ngày.
    const r = reportRangeFor({ reportFor: 'custom', rangeFrom: '2026-05-19', rangeTo: '2026-08-18' }, '2026-08-18');
    assert.equal(r.clamped, undefined);
    assert.deepEqual(r, { from: '2026-05-19', to: '2026-08-18' });
});

test('normalizeReportJob nhận đủ 6 giá trị reportFor + rangeFrom/rangeTo hợp lệ', () => {
    for (const v of ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'custom']) {
        assert.equal(normalizeReportJob({ reportFor: v }).reportFor, v, `phải nhận '${v}'`);
    }
    assert.equal(normalizeReportJob({}).reportFor, 'today', 'thiếu → today, giữ hành vi cũ');
    assert.equal(normalizeReportJob({ reportFor: 'YESTERDAY' }).reportFor, 'today', 'không nhận hoa/thường lẫn');
    assert.equal(normalizeReportJob({ reportFor: 'custom', rangeFrom: '2026-08-01', rangeTo: '2026-08-10' }).rangeFrom, '2026-08-01');
    assert.equal(normalizeReportJob({ reportFor: 'custom', rangeFrom: '2026-08-01', rangeTo: '2026-08-10' }).rangeTo, '2026-08-10');
    assert.equal(normalizeReportJob({ rangeFrom: '18/08/2026' }).rangeFrom, '', 'dạng sai (không phải YYYY-MM-DD) → rỗng');
    assert.equal(normalizeReportJob({}).rangeFrom, '', 'thiếu → rỗng, không phải undefined (giữ JSON gọn)');
});

test('chốt-ngày theo NGÀY CHẠY, không theo ngày được báo cáo', async () => {
    // Trộn hai cái này là lịch 'yesterday' tự chốt vào hôm qua rồi chạy lại mỗi phút.
    const r = await runScheduler({
        jobs: [job({ time: '08:00', reportFor: 'yesterday' })],
        now: '08:01', today: '2026-07-31',
    });
    assert.deepEqual(r.sent, ['j1']);
    assert.equal(r.state.byJob.j1.date, '2026-07-31', 'dấu phải là ngày CHẠY');

    const again = await runScheduler({
        jobs: [job({ time: '08:00', reportFor: 'yesterday' })],
        now: '08:02', today: '2026-07-31', state: r.state,
    });
    assert.deepEqual(again.sent, [], 'đã chốt hôm nay thì không chạy lại');
});

test('lịch sáng lấy nội dung NGÀY HÔM QUA, lịch cuối ngày lấy hôm nay', async () => {
    const sang = await runScheduler({
        jobs: [job({ time: '08:00', reportFor: 'yesterday' })], now: '08:00', today: '2026-07-31',
    });
    assert.deepEqual(sang.reported, [{ from: '2026-07-30', to: '2026-07-30' }], 'runReportJob phải nhận range = hôm qua');

    const cuoiNgay = await runScheduler({
        jobs: [job({ time: '22:30' })], now: '22:30', today: '2026-07-31',
    });
    assert.deepEqual(cuoiNgay.reported, [{ from: '2026-07-31', to: '2026-07-31' }], 'lịch cuối ngày vẫn là hôm nay');
});

test('scheduler không ném lỗi ngầm — warns rỗng ở đường chạy bình thường', async () => {
    const r = await runScheduler({
        jobs: [job({ time: '08:00', reportFor: 'yesterday' })], now: '08:00', today: '2026-07-31',
    });
    assert.deepEqual(r.warns, [], 'có warn tức là runReportJob ném lỗi và bị try/catch nuốt');
});

// ── Lưu bản đã gửi ────────────────────────────────────────────────────────────────────────────
// Owner hỏi "sáng nay bot gửi gì" và không có chỗ nào xem: gateway chat không hiện tin do plugin
// gửi, digest thì tính lúc chạy rồi thả đi. Phải lưu ĐÚNG chuỗi đã gửi, không phải dựng lại —
// dựng lại sau khi đổi danh sách nhóm sẽ ra kết quả khác bản thật.
const reportDeliveryTargets = new Function('groupNames', 'ownerId', 'getBotConfig', `
    ${extract('reportDeliveryTargets')}
    return reportDeliveryTargets;
`)({ g1: { name: 'Nhóm Một' }, g4: { name: 'ASACHINA ZALO' } }, 'owner-1', () => ({}));

test('đích gửi ghi lại tên nhóm thật, không bắt owner suy từ groupId', () => {
    const t = reportDeliveryTargets({ deliver: { ownerDm: false, eachGroup: false, groups: ['g4'] } });
    assert.deepEqual(t, [{ type: 'group', id: 'g4', name: 'ASACHINA ZALO' }]);
});

test('đích gửi gồm cả DM owner và chính nhóm, đúng thứ tự đã gửi', () => {
    const t = reportDeliveryTargets(
        { deliver: { ownerDm: true, eachGroup: true, groups: ['g4'] } }, 'g1');
    assert.deepEqual(t.map(x => x.type), ['group', 'dm', 'group']);
    assert.equal(t[0].name, 'Nhóm Một', 'eachGroup phải là chính nhóm đang báo cáo');
    assert.equal(t[2].name, 'ASACHINA ZALO');
});

test('groupId lạ thì vẫn ghi lại được, lấy id làm tên thay vì rỗng', () => {
    const t = reportDeliveryTargets({ deliver: { ownerDm: false, eachGroup: false, groups: ['g-la'] } });
    assert.equal(t[0].name, 'g-la');
});

// ── Digest không được tin cache summary cũ ────────────────────────────────────────────────────
// Lỗi thật 2026-08-01: digest gửi "0 nhóm · 0 tin" cho 24 nhóm trong khi nhật ký thô có tin. Cache
// summary bị sinh lúc 01:56 hôm trước (do thao tác XEM TRƯỚC) khi ngày mới bắt đầu và chưa có tin
// nào → ghi `messageCount: 0` rồi không bao giờ tự làm mới.
function loadDigestParts({ summaries, history, generated = [] }) {
    return new Function('summaries', 'history', 'generated', `
        const getSummary = async (gid, d) => summaries[gid + '|' + d] || null;
        const readChatHistory = async (gid, d) => history[gid + '|' + d] || [];
        const generateDailySummary = async (gid, d, opts = {}) => {
            generated.push(gid);
            const rows = history[gid + '|' + d] || [];
            const s = { messageCount: rows.length, sections: { highlights: ['h'], participants: ['p'] } };
            // Giả lập đúng hợp đồng thật: save === false thì trả kết quả mà KHÔNG ghi.
            if (opts.save !== false) summaries[gid + '|' + d] = s;
            return s;
        };
        const getGroupName = (g) => 'Nhóm ' + g;
        ${extract('ensureFreshSummary')}
        ${extract('buildDigestParts')}
        return buildDigestParts;
    `)(summaries, history, generated);
}

test('cache ghi 0 tin nhưng nhật ký có tin → phải sinh lại, không báo cáo rỗng', async () => {
    const generated = [];
    const build = loadDigestParts({
        summaries: { 'g1|2026-07-31': { messageCount: 0, sections: {} } },
        history: { 'g1|2026-07-31': [1, 2, 3, 4, 5] },
        generated,
    });
    const r = await build(['g1'], { from: '2026-07-31', to: '2026-07-31' });
    assert.deepEqual(generated, ['g1'], 'phải sinh lại vì nhật ký nhiều tin hơn cache');
    assert.equal(r.groupCount, 1);
    assert.equal(r.totalMsgs, 5);
});

test('cache đã khớp nhật ký thì KHÔNG sinh lại — không đốt token vô ích', async () => {
    const generated = [];
    const build = loadDigestParts({
        summaries: { 'g1|2026-07-31': { messageCount: 5, sections: { highlights: ['x'] } } },
        history: { 'g1|2026-07-31': [1, 2, 3, 4, 5] },
        generated,
    });
    const r = await build(['g1'], { from: '2026-07-31', to: '2026-07-31' });
    assert.deepEqual(generated, [], 'cache còn đúng thì dùng lại');
    assert.equal(r.totalMsgs, 5);
});

test('chưa có cache thì sinh mới như cũ', async () => {
    const generated = [];
    const build = loadDigestParts({ summaries: {}, history: { 'g1|2026-07-31': [1, 2] }, generated });
    const r = await build(['g1'], { from: '2026-07-31', to: '2026-07-31' });
    assert.deepEqual(generated, ['g1']);
    assert.equal(r.totalMsgs, 2);
});

test('nhóm thật sự không có tin thì bỏ qua, không sinh lại vô ích', async () => {
    const generated = [];
    const build = loadDigestParts({
        summaries: { 'g1|2026-07-31': { messageCount: 0, sections: {} } },
        history: { 'g1|2026-07-31': [] },
        generated,
    });
    const r = await build(['g1'], { from: '2026-07-31', to: '2026-07-31' });
    assert.deepEqual(generated, [], 'nhật ký rỗng = cache đúng, không cần sinh');
    assert.equal(r.groupCount, 0);
});

// Xem trước phải VỪA thật VỪA không đụng cache. Bản đầu tôi làm nó bỏ luôn việc sinh → mọi ngày
// chưa có cache đều hiện rỗng, nút "Xem trước" thành vô dụng. Đổi một lỗi lấy một lỗi khác.
test('persist:false (Xem trước) VẪN sinh để hiện nội dung thật, nhưng KHÔNG ghi cache', async () => {
    const generated = [];
    const summaries = { 'g1|2026-07-31': { messageCount: 0, sections: {} } };
    const build = loadDigestParts({ summaries, history: { 'g1|2026-07-31': [1, 2, 3] }, generated, saveOnly: true });
    const r = await build(['g1'], { from: '2026-07-31', to: '2026-07-31' }, { persist: false });
    assert.deepEqual(generated, ['g1'], 'vẫn phải sinh, không thì xem trước luôn rỗng');
    assert.equal(r.totalMsgs, 3, 'và phải hiện đúng số tin thật');
    assert.equal(summaries['g1|2026-07-31'].messageCount, 0, 'nhưng cache trên đĩa phải giữ nguyên');
});

// ── P3: lịch kind:'backlog' — buildBacklogText là TRUY VẤN, không LLM ───────────────────────────
// `rows` mô phỏng đúng shape trả về bởi `CrmStore.listBacklog` (đã sắp sẵn quá-hạn-trước-rồi-treo-
// lâu-nhất — buildBacklogText chỉ gộp theo nhóm, không tự sắp lại).
function loadBacklog() {
    return new Function(`
        // CỐ Ý không định nghĩa generateDailySummary/callSmartRoute/readChatHistory: đây là truy vấn
        // kanban tất định, nếu code lỡ đụng LLM thì test phải nổ ReferenceError ngay.
        const DIGEST_SAFE_CHARS = 3500;
        const STALE_DAYS = 3;
        const MAX_ITEMS_PER_BLOCK = 5;
        ${extract('vnDateStr')}
        ${extract('daysBetween')}
        ${extract('buildBacklogText')}
        return buildBacklogText;
    `)();
}
const groupNameOf = (gid) => `Nhóm ${gid}`;

test('backlog: gộp theo nhóm, đếm đúng số nhóm/việc ở đầu tin', () => {
    const buildBacklogText = loadBacklog();
    // last_seen_date GẦN `to` để không rơi vào nhóm ⏳ TREO LÂU (P10) — test này chỉ kiểm gộp nhóm.
    const rows = [
        { group_id: 'g1', title: 'Việc A', first_seen_date: '2026-08-12', last_seen_date: '2026-08-18', due_at: null },
        { group_id: 'g1', title: 'Việc B', first_seen_date: '2026-08-14', last_seen_date: '2026-08-18', due_at: null },
        { group_id: 'g2', title: 'Việc C', first_seen_date: '2026-08-15', last_seen_date: '2026-08-18', due_at: null },
    ];
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    // P6: nhãn chỉ ghi mốc chạy ("tính đến"), KHÔNG ghi một khoảng lọc không tồn tại — listBacklog
    // không lọc theo ngày, in kiểu "12/08–18/08" là bịa một phạm vi lọc giả.
    assert.match(texts[0], /^📌 VIỆC CÒN TREO tính đến 2026-08-18 · 2 nhóm · 3 việc/);
    assert.doesNotMatch(texts[0], /2026-08-12–2026-08-18/, 'không được in dạng khoảng from–to nữa');
    assert.match(texts.join('\n'), /📋 Nhóm g1 \(2\)/);
    assert.match(texts.join('\n'), /📋 Nhóm g2 \(1\)/);
});

test('backlog: có due_at → "đến hạn", không có → "treo từ"', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        { group_id: 'g1', title: 'Chốt phí hợp quy', first_seen_date: '2026-08-10', due_at: Date.UTC(2026, 7, 19) - 7 * 3600 * 1000 },
        // last_seen_date GẦN `to` để không rơi vào ⏳ TREO LÂU (P10) — test này chỉ kiểm 2 dạng nhãn.
        { group_id: 'g1', title: 'Gửi bổ sung giấy tờ', first_seen_date: '2026-08-12', last_seen_date: '2026-08-18', due_at: null },
    ];
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    assert.match(texts.join('\n'), /⚪ Cần làm · Chốt phí hợp quy — hạn 2026-08-19/);
    assert.match(texts.join('\n'), /⚪ Cần làm · Gửi bổ sung giấy tờ — treo từ 2026-08-12/);
});

// P9 (Kent chốt, phương án a): bản trước ẨN hẳn việc pending khỏi danh sách — nhưng 121 việc backfill
// đều pending nên tin gửi ra thành "0 nhóm · 0 việc", đúng kiểu "0 nhóm · 0 tin" đã 2 lần mất niềm
// tin. Giờ việc pending hiện NGANG HÀNG, chỉ kèm nhãn 🤖 để phân biệt bằng mắt.
test('backlog: việc pending HIỆN trong danh sách theo nhóm kèm nhãn 🤖, tiêu đề đếm CẢ HAI loại', () => {
    const buildBacklogText = loadBacklog();
    // last_seen_date GẦN `to` để không rơi vào ⏳ TREO LÂU (P10) — test này chỉ kiểm hiển thị pending.
    const rows = [
        { group_id: 'g1', title: 'Việc đã duyệt', first_seen_date: '2026-08-12', last_seen_date: '2026-08-18', due_at: null, review_state: null },
        { group_id: 'g1', title: 'Việc AI đề xuất', first_seen_date: '2026-08-16', last_seen_date: '2026-08-18', due_at: null, review_state: 'pending' },
        { group_id: 'g2', title: 'Việc AI đề xuất 2', first_seen_date: '2026-08-17', last_seen_date: '2026-08-18', due_at: null, review_state: 'pending' },
    ];
    const { texts, pendingCount } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    const joined = texts.join('\n');
    assert.equal(pendingCount, 2);
    // Tiêu đề đếm CẢ 3 việc (1 đã duyệt + 2 pending), không chỉ việc đã duyệt.
    assert.match(joined, /VIỆC CÒN TREO tính đến 2026-08-18 · 2 nhóm · 3 việc/);
    assert.match(joined, /📋 Nhóm g1 \(2\)\n {2}• ⚪ Cần làm · Việc đã duyệt.*\n {2}• 🤖 Việc AI đề xuất\b/);
    assert.match(joined, /📋 Nhóm g2 \(1\)\n {2}• 🤖 Việc AI đề xuất 2\b/);
    // Việc ĐÃ DUYỆT không bị gắn nhầm nhãn 🤖.
    assert.doesNotMatch(joined, /🤖 Việc đã duyệt/);
    assert.match(joined, /🤖 2 việc do AI đề xuất đang chờ xác nhận → duyệt ở dashboard/);
});

// P16: "Quá hạn" là tín hiệu ƯU TIÊN hơn nhãn 🤖 chờ duyệt TRÊN MỖI DÒNG — việc pending quá hạn vẫn
// đứng nguyên trong khối ⏰ QUÁ HẠN (không bị che khỏi khối, đúng tinh thần P9), nhưng nhãn dòng đổi
// sang "Quá hạn N ngày" vì đó là điều khẩn hơn với chủ Asa. Tín hiệu "còn N việc chờ duyệt" không mất
// — vẫn được đếm trong pendingCount/footer — chỉ không lặp lại 🤖 trên từng dòng quá hạn nữa.
test('backlog: việc pending QUÁ HẠN vẫn đứng trong khối ⏰ QUÁ HẠN, nhãn dòng ưu tiên "Quá hạn N ngày"', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        { group_id: 'g1', title: 'Việc trễ hạn của AI', first_seen_date: '2026-08-01', review_state: 'pending', overdue: true, due_at: Date.UTC(2026, 7, 10) - 7 * 3600 * 1000 },
        { group_id: 'g1', title: 'Việc bình thường', first_seen_date: '2026-08-12', due_at: null, overdue: false, review_state: null },
    ];
    const { texts, pendingCount } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    const joined = texts.join('\n');
    assert.match(joined, /⏰ QUÁ HẠN \(1\)\n {2}• ⏰ Quá hạn 8 ngày · Việc trễ hạn của AI/);
    assert.equal(pendingCount, 1, 'vẫn đếm đúng — việc pending không mất khỏi thống kê dù nhãn dòng đổi');
});

// P16 (điều kiện dừng): "đừng ghi chung chung là còn treo" — đủ 5 trạng thái ra đúng icon + nhãn,
// và icon PHẢI khớp đúng ngôn ngữ 4 cột kanban (Chờ xác nhận/Cần làm/Đang làm) + "Đang vướng"
// (status='blocked' — kanban gộp hiển thị vào cột "Đang làm" nhưng báo cáo tách riêng, vì owner cần
// biết việc nào đang VƯỚNG chứ không chỉ đang chạy bình thường — không phải phát minh nhãn thứ hai
// cho cùng một trạng thái, `blocked` vốn đã là giá trị `status` riêng biệt trong DB từ P2).
test('backlog (P16): đủ 5 trạng thái ra đúng icon + nhãn — Chờ xác nhận/Cần làm/Đang làm/Đang vướng/Quá hạn', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        { group_id: 'g1', title: 'Việc chờ xác nhận', first_seen_date: '2026-08-17', last_seen_date: '2026-08-18', due_at: null, review_state: 'pending', status: 'todo' },
        { group_id: 'g1', title: 'Việc cần làm', first_seen_date: '2026-08-17', last_seen_date: '2026-08-18', due_at: null, review_state: null, status: 'todo' },
        { group_id: 'g1', title: 'Việc đang làm', first_seen_date: '2026-08-17', last_seen_date: '2026-08-18', due_at: null, review_state: null, status: 'doing' },
        { group_id: 'g1', title: 'Việc đang vướng', first_seen_date: '2026-08-17', last_seen_date: '2026-08-18', due_at: null, review_state: null, status: 'blocked' },
        { group_id: 'g1', title: 'Việc quá hạn', first_seen_date: '2026-08-01', review_state: null, status: 'todo', overdue: true, due_at: Date.UTC(2026, 7, 16) - 7 * 3600 * 1000 },
    ];
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    const joined = texts.join('\n');
    // Leader sửa 19/08: nhãn chỉ-icon KHÔNG có ` · ` — "🤖 · Thanh toán…" đọc như thiếu chữ.
    // Nhãn có chữ ("🔵 Đang làm") thì vẫn giữ dấu tách. Đây là đổi format có chủ ý.
    assert.match(joined, /🤖 Việc chờ xác nhận/);
    assert.ok(!joined.includes('🤖 · '), 'nhãn chỉ-icon không được kèm dấu ·');
    assert.doesNotMatch(joined, /Chờ xác nhận/, 'P17 (2): bỏ chữ trùng nghĩa với icon 🤖');
    assert.match(joined, /⚪ Cần làm · Việc cần làm/);
    assert.match(joined, /🔵 Đang làm · Việc đang làm/);
    assert.match(joined, /🚧 Đang vướng · Việc đang vướng/);
    assert.match(joined, /⏰ Quá hạn 2 ngày · Việc quá hạn/);
});

// P17 (1): AI rút hạn dạng CHỮ vào `note` (`reconcileOpenItems`: `note: 'Hạn: ' + raw.due`) — đo thật
// 46/138 việc có hạn kiểu này (`Hạn: Ngày mai` · `Hạn: 05:00, 13/08/2026` · `Hạn: Trong năm 2026`),
// kanban đã hiện (chip) nhưng tin báo cáo thì KHÔNG — chủ Asa đọc tin vẫn không thấy deadline nào.
// GIỮ NGUYÊN nguyên văn AI rút được — "Ngày mai" → "20/8" là SUY DIỄN, không phải chuẩn hoá.
test('backlog (P17): note dạng "Hạn: …" được in ra nguyên văn ở cuối dòng, không chuẩn hoá thành ngày', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        { group_id: 'g1', title: 'Ký hoá đơn lô túi giữ nhiệt', first_seen_date: '2026-08-16', last_seen_date: '2026-08-18', due_at: null, note: 'Hạn: Ngày mai', status: 'todo', review_state: null },
        { group_id: 'g1', title: 'Việc không có hạn', first_seen_date: '2026-08-16', last_seen_date: '2026-08-18', due_at: null, note: '', status: 'todo', review_state: null },
    ];
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    const joined = texts.join('\n');
    assert.match(joined, /⚪ Cần làm · Ký hoá đơn lô túi giữ nhiệt — hạn Ngày mai/);
    assert.doesNotMatch(joined, /20\/8|2026-08-\d\d — hạn/, 'không được tự suy ra ngày cụ thể từ chữ "Ngày mai"');
    // Việc không có note "Hạn: …" thì KHÔNG được tự thêm gì — vẫn giữ hành vi cũ (treo từ/…).
    assert.match(joined, /⚪ Cần làm · Việc không có hạn — treo từ 2026-08-16/);
    assert.doesNotMatch(joined, /Việc không có hạn — hạn/);
});

test('backlog (P17): note "Hạn: …" giữ nguyên văn dù là giờ/ngày cụ thể do AI rút — không parse lại', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        { group_id: 'g1', title: 'Nộp báo cáo thuế', first_seen_date: '2026-08-10', last_seen_date: '2026-08-11', due_at: null, note: 'Hạn: 05:00, 13/08/2026', status: 'todo', review_state: null },
    ];
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    // Việc này im lặng 7 ngày (>= STALE_DAYS) — hạn vẫn phải THẮNG staleness, không bị thay bằng
    // "chưa ai nhắc lại N ngày".
    assert.match(texts.join('\n'), /⏳ TREO LÂU \(1\)\n {2}• ⚪ Cần làm · Nộp báo cáo thuế — hạn 05:00, 13\/08\/2026/);
    assert.doesNotMatch(texts.join('\n'), /chưa ai nhắc lại/);
});

test('backlog (P17): due_at THẬT (nếu có) vẫn thắng note "Hạn: …" — không hiện cả hai, không mâu thuẫn', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        { group_id: 'g1', title: 'Việc có cả hai', first_seen_date: '2026-08-16', last_seen_date: '2026-08-18', due_at: Date.UTC(2026, 7, 20) - 7 * 3600 * 1000, note: 'Hạn: tuần sau', status: 'todo', review_state: null, overdue: false },
    ];
    const joined = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' }).texts.join('\n');
    assert.match(joined, /Việc có cả hai — hạn 2026-08-20/);
    assert.doesNotMatch(joined, /tuần sau/);
});

// P17 (3): trong mỗi nhóm Zalo, việc CÓ hạn (due_at thật hoặc "Hạn: …") xếp TRƯỚC việc không hạn.
test('backlog (P17): trong mỗi nhóm, việc CÓ hạn xếp trước việc không hạn', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        // Mọi last_seen_date cách `to` (2026-08-18) DƯỚI 3 ngày để cả 4 việc cùng vào một khối theo
        // nhóm (không rơi vào ⏳ TREO LÂU) — test này chỉ kiểm thứ tự trong khối "📋 <nhóm>".
        { group_id: 'g1', title: 'Không hạn, mới nhất', first_seen_date: '2026-08-17', last_seen_date: '2026-08-18', due_at: null, note: '', status: 'todo' },
        { group_id: 'g1', title: 'Có hạn chữ', first_seen_date: '2026-08-16', last_seen_date: '2026-08-17', due_at: null, note: 'Hạn: Ngày mai', status: 'todo' },
        { group_id: 'g1', title: 'Không hạn, cũ hơn', first_seen_date: '2026-08-15', last_seen_date: '2026-08-16', due_at: null, note: '', status: 'todo' },
        { group_id: 'g1', title: 'Có hạn thật', first_seen_date: '2026-08-15', last_seen_date: '2026-08-16', due_at: Date.UTC(2026, 7, 25) - 7 * 3600 * 1000, note: '', status: 'todo' },
    ];
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    const joined = texts.join('\n');
    const order = ['Có hạn chữ', 'Có hạn thật', 'Không hạn, mới nhất', 'Không hạn, cũ hơn']
        .map((title) => joined.indexOf(title));
    assert.ok(order[0] < order[2] && order[0] < order[3], '"Có hạn chữ" phải đứng trước cả hai việc không hạn');
    assert.ok(order[1] < order[2] && order[1] < order[3], '"Có hạn thật" phải đứng trước cả hai việc không hạn');
    assert.ok(order[2] < order[3], 'trong nhóm không hạn, mới nhất vẫn đứng trước như luật cũ');
});

// P6 (2): chủ Asa quan tâm SÓT DEADLINE hơn — việc quá hạn phải nổi lên đầu tin thành nhóm riêng,
// không trộn lẫn trong khối theo nhóm Zalo (dễ bị lướt qua).
test('backlog: việc quá hạn (overdue) được TÁCH lên đầu thành nhóm "⏰ QUÁ HẠN", đứng trước mọi nhóm Zalo', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        // last_seen_date GẦN `to` (< STALE_DAYS) để không lẫn sang nhóm ⏳ TREO LÂU mới (P10) — test
        // này chỉ tập trung vào việc TÁCH QUÁ HẠN, staleness có test riêng.
        { group_id: 'g1', title: 'Việc bình thường', first_seen_date: '2026-08-12', last_seen_date: '2026-08-17', due_at: null, overdue: false },
        { group_id: 'g1', title: 'Việc trễ hạn', first_seen_date: '2026-08-01', due_at: Date.UTC(2026, 7, 10) - 7 * 3600 * 1000, overdue: true },
        { group_id: 'g2', title: 'Việc trễ hạn 2', first_seen_date: '2026-08-02', due_at: Date.UTC(2026, 7, 11) - 7 * 3600 * 1000, overdue: true },
    ];
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    const joined = texts.join('\n');
    assert.match(joined, /⏰ QUÁ HẠN \(2\)/);
    assert.match(joined, /⏰ Quá hạn 8 ngày · Việc trễ hạn$/m);
    assert.match(joined, /⏰ Quá hạn 7 ngày · Việc trễ hạn 2$/m);
    // Đứng TRƯỚC mọi khối "📋 <nhóm>" — vị trí trong chuỗi phải nhỏ hơn.
    assert.ok(joined.indexOf('⏰ QUÁ HẠN') < joined.indexOf('📋 Nhóm g1'), 'quá hạn phải đứng trước nhóm g1');
    // Việc quá hạn KHÔNG được lặp lại trong khối theo nhóm — chỉ xuất hiện đúng một lần.
    assert.equal((joined.match(/⏰ Quá hạn 8 ngày · Việc trễ hạn$/gm) || []).length, 1);
    // Việc không quá hạn vẫn gộp theo nhóm Zalo như cũ.
    assert.match(joined, /📋 Nhóm g1 \(1\)\n  • ⚪ Cần làm · Việc bình thường/);
    // Tính "N nhóm" ở đầu tin vẫn đếm đủ cả 2 nhóm, dù g2 chỉ có việc quá hạn (không có khối riêng).
    assert.match(texts[0], /2 nhóm · 3 việc/);
});

test('backlog: không có việc nào (tất cả done hoặc rỗng) → nói rõ, không có dòng ⚠️ nếu không có pending', () => {
    const buildBacklogText = loadBacklog();
    const { texts, pendingCount } = buildBacklogText([], groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    assert.equal(pendingCount, 0);
    assert.match(texts[0], /0 nhóm · 0 việc/);
    assert.match(texts[0], /Không có việc nào còn treo/);
    assert.doesNotMatch(texts[0], /chờ xác nhận/);
});

// P9: bản trước tin ra "0 nhóm · 0 việc" khi TẤT CẢ việc còn treo đều pending (đúng kịch bản thật:
// 121 việc backfill toàn bộ pending) — vô dụng hệt "0 nhóm · 0 tin". Giờ phải hiện đủ, chỉ kèm 🤖.
test('backlog: chỉ toàn việc pending (chưa ai duyệt gì) → VẪN hiện đủ trong danh sách, không còn "0 việc"', () => {
    const buildBacklogText = loadBacklog();
    const rows = [{ group_id: 'g1', title: 'X', first_seen_date: '2026-08-17', due_at: null, review_state: 'pending' }];
    const { texts, pendingCount } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    assert.equal(pendingCount, 1);
    assert.match(texts[0], /1 nhóm · 1 việc/);
    assert.match(texts.join('\n'), /📋 Nhóm g1 \(1\)\n {2}• 🤖 X — treo từ 2026-08-17/);
    assert.doesNotMatch(texts.join('\n'), /Không có việc nào còn treo/);
    assert.match(texts.join('\n'), /🤖 1 việc do AI đề xuất đang chờ xác nhận → duyệt ở dashboard/);
});

// ── P10 (1): thiếu `due` thật → tín hiệu ĐO ĐƯỢC thay thế: im lặng ≥ STALE_DAYS ────────────────
// Chạy thật 137 việc/17 nhóm: `due` AI rút được gần như luôn rỗng → nhóm ⏰ QUÁ HẠN gần như luôn
// rỗng, không trả lời được câu chủ Asa hỏi ("có sót deadline/task chưa xong"). KHÔNG bắt AI đoán
// deadline (bịa ngày là sai nghiêm trọng hơn không có) — dùng `last_seen_date` làm tín hiệu thay thế.
test('backlog: việc KHÔNG due, im lặng ≥3 ngày → vào ⏳ TREO LÂU kèm số ngày; < 3 ngày → vẫn "treo từ"', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        { group_id: 'g1', title: 'Im lặng lâu', first_seen_date: '2026-08-01', last_seen_date: '2026-08-15', due_at: null },
        { group_id: 'g1', title: 'Mới nhắc gần đây', first_seen_date: '2026-08-16', last_seen_date: '2026-08-17', due_at: null },
    ];
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    const joined = texts.join('\n');
    assert.match(joined, /⏳ TREO LÂU \(1\)\n {2}• ⚪ Cần làm · Im lặng lâu — chưa ai nhắc lại 3 ngày/);
    assert.match(joined, /📋 Nhóm g1 \(1\)\n {2}• ⚪ Cần làm · Mới nhắc gần đây — treo từ 2026-08-16/);
    assert.doesNotMatch(joined, /Mới nhắc gần đây.*chưa ai nhắc lại/);
});

test('backlog: việc CÓ due thật vẫn vào ⏰ QUÁ HẠN như cũ, không bị gộp vào ⏳ TREO LÂU', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        { group_id: 'g1', title: 'Trễ hạn thật', first_seen_date: '2026-08-01', last_seen_date: '2026-08-01', overdue: true, due_at: Date.UTC(2026, 7, 10) - 7 * 3600 * 1000 },
    ];
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    const joined = texts.join('\n');
    assert.match(joined, /⏰ QUÁ HẠN \(1\)/);
    assert.doesNotMatch(joined, /⏳ TREO LÂU/);
});

test('backlog: việc gõ tay không có first_seen_date/last_seen_date vẫn đo được độ im lặng qua created_at', () => {
    const buildBacklogText = loadBacklog();
    const rows = [
        { group_id: 'g1', title: 'Việc gõ tay cũ', due_at: null, created_at: Date.UTC(2026, 7, 1) - 7 * 3600 * 1000, source: 'manual' },
    ];
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    assert.match(texts.join('\n'), /⏳ TREO LÂU \(1\)\n {2}• ⚪ Cần làm · Việc gõ tay cũ — chưa ai nhắc lại 17 ngày/);
});

// ── P10 (2): tin dài owner sẽ không đọc — mỗi khối tối đa MAX_ITEMS_PER_BLOCK việc ───────────────
test('backlog: khối quá 5 việc thì cắt còn 5, thêm dòng "… và N việc khác"', () => {
    const buildBacklogText = loadBacklog();
    const rows = Array.from({ length: 8 }, (_, i) => ({
        group_id: 'g1', title: `Việc ${i}`, first_seen_date: '2026-08-17', last_seen_date: '2026-08-17', due_at: null,
    }));
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    const joined = texts.join('\n');
    assert.match(joined, /📋 Nhóm g1 \(8\)/, 'tiêu đề khối vẫn ghi ĐỦ số việc thật, chỉ cắt phần liệt kê');
    assert.equal((joined.match(/  • ⚪ Cần làm · Việc \d/g) || []).length, 5, 'chỉ hiện đúng 5 dòng việc');
    assert.match(joined, /  … và 3 việc khác/);
});

test('backlog: khối đúng 5 việc trở xuống thì KHÔNG có dòng "và N việc khác"', () => {
    const buildBacklogText = loadBacklog();
    const rows = Array.from({ length: 5 }, (_, i) => ({
        group_id: 'g1', title: `Việc ${i}`, first_seen_date: '2026-08-17', last_seen_date: '2026-08-17', due_at: null,
    }));
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    assert.doesNotMatch(texts.join('\n'), /và \d+ việc khác/);
});

test('backlog: giới hạn 5 việc/khối áp dụng CẢ cho ⏰ QUÁ HẠN và ⏳ TREO LÂU, không chỉ khối theo nhóm', () => {
    const buildBacklogText = loadBacklog();
    const overdueRows = Array.from({ length: 7 }, (_, i) => ({
        group_id: 'g1', title: `Trễ hạn ${i}`, overdue: true, due_at: Date.UTC(2026, 7, 10 + i) - 7 * 3600 * 1000,
    }));
    const { texts } = buildBacklogText(overdueRows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    const joined = texts.join('\n');
    assert.match(joined, /⏰ QUÁ HẠN \(7\)/);
    assert.equal((joined.match(/  • ⏰ Quá hạn \d+ ngày · Trễ hạn \d/g) || []).length, 5);
    assert.match(joined, /  … và 2 việc khác/);
});

// Dữ liệu thật đo được 18/08: 137 việc, 17 nhóm → 4 tin, 9.766 ký tự. Sau P10 phải rút xuống 1-2 tin.
test('backlog: mô phỏng dữ liệu thật (137 việc, 17 nhóm) ra ĐÚNG 1–2 tin', () => {
    const buildBacklogText = loadBacklog();
    const rows = [];
    for (let g = 0; g < 17; g++) {
        const n = g === 0 ? 31 : Math.ceil((137 - 31) / 16); // mô phỏng nhóm ồn ào [39] chiếm phần lớn
        for (let i = 0; i < n && rows.length < 137; i++) {
            rows.push({
                group_id: `g${g}`, title: `Việc ${g}-${i}`, due_at: null,
                first_seen_date: '2026-08-15', last_seen_date: '2026-08-17',
            });
        }
    }
    const { texts } = buildBacklogText(rows, groupNameOf, { from: '2026-08-12', to: '2026-08-18' });
    assert.ok(texts.length >= 1 && texts.length <= 2, `phải ra 1-2 tin, thực tế ${texts.length}`);
});

// ── P9 (1): kind:'backlog' phải làm TƯƠI ngày hôm nay TRƯỚC khi đọc kanban ───────────────────────
// Trước đây `runReportJob` chỉ `listBacklog` (đọc DB) — việc phát sinh trong ngày chưa kịp vào kanban
// (chỉ `generateDailySummary` mới ghi qua `reconcileGroupOpenItems`), buộc owner phải có thêm một
// lịch digest chạy trước = nhận 2 tin. `ensureFreshSummary` phải tự giới hạn: CHỈ nhóm có nhật ký
// thô MỚI HƠN cache mới tốn 1 lượt AI — không sinh vô điều kiện cho cả scope, không đụng ngày khác.
function loadBacklogJob({ summaries = {}, rawHistory = {}, listBacklogRows = [] }) {
    const generated = [];
    return {
        generated,
        run: new Function('summaries', 'rawHistory', 'generated', 'listBacklogRows', `
            const resolveJobGroups = (job) => job.groups;
            const getSummary = async (gid, d) => summaries[gid + '|' + d] || null;
            const readChatHistory = async (gid, d) => {
                const key = gid + '|' + d;
                return key in rawHistory ? rawHistory[key] : [];
            };
            // CỐ Ý không định nghĩa callSmartRoute: generateDailySummary ở đây là BẢN GIẢ, sinh lại
            // dựa thẳng trên nhật ký thô mô phỏng, không đụng AI thật.
            const generateDailySummary = async (gid, d, opts = {}) => {
                generated.push(gid + '|' + d);
                const rows = await readChatHistory(gid, d);
                const s = { messageCount: rows.length, sections: {} };
                if (opts.save !== false) summaries[gid + '|' + d] = s;
                return s;
            };
            ${extract('ensureFreshSummary')}
            const zEngine = { crm: { listBacklog: () => listBacklogRows } };
            const groupNames = {};
            // Mọi nhóm mặc định BẬT backlogInclude (owner chưa đặt tay) — test riêng cho P10 (3) mô
            // phỏng store thật để kiểm cờ này, ở đây chỉ cần không chặn các test P9 khác.
            const store = { getSetting: () => true }; // P9 tests: không kiểm backlogInclude, mọi nhóm luôn được tính
            ${extract('defaultBacklogInclude')}
            const DIGEST_SAFE_CHARS = 3500;
            ${extract('vnDateStr')}
            const buildBacklogText = (rows) => ({ texts: ['ok'], pendingCount: 0 });
            const deliverReportTexts = async () => {};
            const recordReportSent = async () => {};
            const reportDeliveryTargets = () => [];
            ${extract('runReportJob')}
            return runReportJob(
                { id: 'j1', name: 'BC', kind: 'backlog', reportFor: 'today', time: '17:00', groups: ['g1', 'g2'] },
                { from: '2026-08-18', to: '2026-08-18' },
            );
        `)(summaries, rawHistory, generated, listBacklogRows),
    };
}

// ── P10 (3): cờ backlogInclude theo nhóm — mặc định theo quy ước tên, owner đổi tay luôn thắng ──
// Đo thật: nhóm rèn luyện `[39] RÈN CÙNG NHAU` chiếm 31/137 việc, toàn cam kết cá nhân, không phải
// task team. Owner cần tự chọn nhóm nào vào báo cáo — KHÔNG hardcode tên nhóm cụ thể trong code.
function runBacklogWithGroupFilter({ groupNames = {}, settings = {}, rawHistory = {} }) {
    const generated = [];
    const listBacklogCalls = [];
    const run = new Function('groupNames', 'settings', 'rawHistory', 'generated', 'listBacklogCalls', `
        const resolveJobGroups = (job) => job.groups;
        const getSummary = async () => null;
        const readChatHistory = async (gid, d) => {
            const key = gid + '|' + d;
            return key in rawHistory ? rawHistory[key] : [];
        };
        const generateDailySummary = async (gid, d, opts = {}) => {
            generated.push(gid + '|' + d);
            const rows = await readChatHistory(gid, d);
            return { messageCount: rows.length, sections: {} };
        };
        ${extract('ensureFreshSummary')}
        const zEngine = { crm: { listBacklog: (gids) => { listBacklogCalls.push(gids); return []; } } };
        const store = { getSetting: (gid, key, def) => (settings[gid] && key in settings[gid] ? settings[gid][key] : def) };
        ${extract('defaultBacklogInclude')}
        const DIGEST_SAFE_CHARS = 3500;
        ${extract('vnDateStr')}
        const buildBacklogText = () => ({ texts: ['ok'], pendingCount: 0 });
        const deliverReportTexts = async () => {};
        const recordReportSent = async () => {};
        const reportDeliveryTargets = () => [];
        ${extract('runReportJob')}
        return runReportJob(
            { id: 'j1', name: 'BC', kind: 'backlog', reportFor: 'today', time: '17:00', groups: Object.keys(groupNames) },
            { from: '2026-08-18', to: '2026-08-18' },
        );
    `)(groupNames, settings, rawHistory, generated, listBacklogCalls);
    return { generated, listBacklogCalls, run };
}

// P11: đo trên 37 nhóm THẬT của khách — quy định "tiền tố ASA" (^\s*asa) khớp đúng 23/37, nhưng có
// 30/37 nhóm chứa "asa" ở ĐÂU ĐÓ trong tên (không nhất thiết đứng đầu). Đòi đúng tiền tố loại OAN 7
// nhóm khách thật, trong đó `HNI 073 ASA - Vipo` có 6 việc thật đã thấy ở tin thử lần 1 rồi biến mất
// ở lần 2 vì bị lọc nhầm. Sửa: khớp "asa" ở bất kỳ vị trí nào trong tên.
test('defaultBacklogInclude: khớp "asa" ở BẤT KỲ ĐÂU trong tên (P11 — vá lỗ loại oan 7 nhóm khách)', () => {
    const defaultBacklogInclude = new Function(`${extract('defaultBacklogInclude')}\nreturn defaultBacklogInclude;`)();

    // 7 nhóm khách thật bị regex CŨ (^\s*asa) loại oan — P11 phải sửa để cả 7 đều ra true.
    const wronglyExcludedBefore = [
        'KG ASA 7844 - Đan Nhi',
        '237. Vnlogs - Asa',
        '237.KẾ TOÁN ASA-VNLOGS',
        'HNI073-DLUQASA',
        'HNI 073 ASA - Vipo', // quan trọng nhất: có 6 việc thật, đã biến mất khỏi tin thử lần 2
        'Nhà xe Hà Sơn Hải Vân - ASA',
        'CO Yuzhan - ASA',
    ];
    for (const name of wronglyExcludedBefore) {
        assert.equal(defaultBacklogInclude(name), true, `"${name}" phải BẬT mặc định (chứa "asa")`);
    }
    // Nhấn mạnh riêng nhóm quan trọng nhất — có việc thật, mất là chủ Asa mất dữ liệu thấy được.
    assert.equal(defaultBacklogInclude('HNI 073 ASA - Vipo'), true);

    // 7 nhóm THẬT SỰ không chứa "asa" — vẫn TẮT mặc định (owner tự bật nếu muốn, đó là lý do có cờ).
    const correctlyExcluded = [
        '[39] RÈN CÙNG NHAU',
        'X3 Diamond',
        'Test bot A. Sa',
        'Order Taobao',
        'C Trang lc - Sa',
        'Lucas AI - Nhóm Vip',
        '[Toma Nhưỡng] Xây Dựng Đội Nhóm…',
    ];
    for (const name of correctlyExcluded) {
        assert.equal(defaultBacklogInclude(name), false, `"${name}" không chứa "asa" nên phải giữ TẮT mặc định`);
    }

    // Giữ nguyên các ca gốc.
    assert.equal(defaultBacklogInclude('ASA 7881 - [ORDER TQ] ME ME'), true);
    assert.equal(defaultBacklogInclude('asachina zalo'), true);
    assert.equal(defaultBacklogInclude(''), false);
    assert.equal(defaultBacklogInclude(undefined), false);
});

test('backlog: nhóm KHÔNG có tiền tố ASA và CHƯA đặt tay → mặc định loại khỏi báo cáo', async () => {
    const { generated, listBacklogCalls, run } = runBacklogWithGroupFilter({
        groupNames: { g1: { name: 'ASA 7881' }, g2: { name: '[39] RÈN CÙNG NHAU' } },
        rawHistory: { 'g1|2026-08-18': [{ t: '09:00' }], 'g2|2026-08-18': [{ t: '09:00' }] },
    });
    await run;
    assert.deepEqual(generated, ['g1|2026-08-18'], 'chỉ nhóm ASA được làm tươi, nhóm rèn luyện bị loại trước khi chạm tới');
    assert.deepEqual(listBacklogCalls[0], ['g1'], 'listBacklog chỉ nhận đúng nhóm còn lại sau khi lọc');
});

test('backlog: owner đặt tay backlogInclude=true cho nhóm rèn luyện → THẮNG default, vẫn vào báo cáo', async () => {
    const { generated, listBacklogCalls, run } = runBacklogWithGroupFilter({
        groupNames: { g1: { name: 'ASA 7881' }, g2: { name: '[39] RÈN CÙNG NHAU' } },
        settings: { g2: { backlogInclude: true } },
        rawHistory: { 'g1|2026-08-18': [{ t: '09:00' }], 'g2|2026-08-18': [{ t: '09:00' }] },
    });
    await run;
    assert.deepEqual(generated.sort(), ['g1|2026-08-18', 'g2|2026-08-18']);
    assert.deepEqual(listBacklogCalls[0].sort(), ['g1', 'g2']);
});

test('backlog: owner đặt tay backlogInclude=false cho nhóm ASA → THẮNG default, bị loại', async () => {
    const { generated, listBacklogCalls, run } = runBacklogWithGroupFilter({
        groupNames: { g1: { name: 'ASA 7881' } },
        settings: { g1: { backlogInclude: false } },
        rawHistory: { 'g1|2026-08-18': [{ t: '09:00' }] },
    });
    await run;
    assert.deepEqual(generated, [], 'nhóm ASA bị owner tắt tay thì không được làm tươi/đọc kanban');
    assert.deepEqual(listBacklogCalls[0], []);
});

test('backlog: CHỈ nhóm có nhật ký mới hơn cache mới gọi generateDailySummary (nhóm khớp sẵn → 0 lượt)', async () => {
    const { generated, run } = loadBacklogJob({
        summaries: {
            'g1|2026-08-18': { messageCount: 2, sections: {} }, // khớp sẵn — không cần sinh
            // g2 không có cache — phải sinh
        },
        rawHistory: {
            'g1|2026-08-18': [{ t: '09:00' }, { t: '10:00' }], // == cache (2) → 0 lượt
            'g2|2026-08-18': [{ t: '11:00' }], // > cache (0/null) → 1 lượt
        },
    });
    await run;
    assert.deepEqual(generated, ['g2|2026-08-18'], 'chỉ g2 được sinh, g1 giữ nguyên cache vì đã khớp');
});

test('backlog: cache mọi nhóm đều khớp raw → 0 lượt sinh nào cả', async () => {
    const { generated, run } = loadBacklogJob({
        summaries: {
            'g1|2026-08-18': { messageCount: 1, sections: {} },
            'g2|2026-08-18': { messageCount: 0, sections: {} },
        },
        rawHistory: { 'g1|2026-08-18': [{ t: '09:00' }], 'g2|2026-08-18': [] },
    });
    await run;
    assert.deepEqual(generated, [], 'không nhóm nào cần sinh thì 0 lượt gọi AI');
});

// Bằng chứng "cứng" hơn spy: KHÔNG định nghĩa generateDailySummary/callSmartRoute — nếu logic lỡ
// sinh cho bất kỳ nhóm nào (kể cả khi cache đã khớp raw), test nổ ReferenceError ngay lập tức.
function runBacklogJobNoGen({ summaries = {}, rawHistory = {}, listBacklogRows = [] }) {
    return new Function('summaries', 'rawHistory', 'listBacklogRows', `
        const resolveJobGroups = (job) => job.groups;
        const getSummary = async (gid, d) => summaries[gid + '|' + d] || null;
        const readChatHistory = async (gid, d) => {
            const key = gid + '|' + d;
            return key in rawHistory ? rawHistory[key] : [];
        };
        ${extract('ensureFreshSummary')}
        const zEngine = { crm: { listBacklog: () => listBacklogRows } };
        const groupNames = {};
        const store = { getSetting: () => true }; // P9 tests: không kiểm backlogInclude, mọi nhóm luôn được tính
        ${extract('defaultBacklogInclude')}
        const DIGEST_SAFE_CHARS = 3500;
        ${extract('vnDateStr')}
        const buildBacklogText = (rows) => ({ texts: ['ok'], pendingCount: 0 });
        const deliverReportTexts = async () => {};
        const recordReportSent = async () => {};
        const reportDeliveryTargets = () => [];
        ${extract('runReportJob')}
        return runReportJob(
            { id: 'j1', name: 'BC', kind: 'backlog', reportFor: 'today', time: '17:00', groups: ['g1', 'g2'] },
            { from: '2026-08-18', to: '2026-08-18' },
        );
    `)(summaries, rawHistory, listBacklogRows);
}

test('backlog: cache khớp raw ở CẢ HAI nhóm — không ReferenceError dù generateDailySummary không tồn tại', async () => {
    await runBacklogJobNoGen({
        summaries: {
            'g1|2026-08-18': { messageCount: 1, sections: {} },
            'g2|2026-08-18': { messageCount: 0, sections: {} },
        },
        rawHistory: { 'g1|2026-08-18': [{ t: '09:00' }], 'g2|2026-08-18': [] },
    });
    // Không assert gì thêm — bản thân việc chạy xong không ném lỗi ĐÃ LÀ bằng chứng.
});

test('backlog: chỉ đụng đúng ngày `to` — không có lượt sinh nào cho ngày khác', async () => {
    const { generated, run } = loadBacklogJob({
        summaries: {},
        rawHistory: { 'g1|2026-08-18': [{ t: '09:00' }], 'g2|2026-08-18': [{ t: '09:00' }] },
    });
    await run;
    assert.ok(generated.every((k) => k.endsWith('|2026-08-18')), 'mọi lượt sinh (nếu có) phải đúng ngày to, không phải ngày khác');
});
