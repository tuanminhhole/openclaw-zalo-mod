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

// ── Digest nhiều ngày (P1) — chỉ đọc cache, cấm sinh lại, gộp theo NHÓM ───────────────────────
// Range >1 ngày không được đụng LLM: 30 nhóm × 7 ngày sinh lại là 210 lượt gọi model cho một tin.
function loadRangeDigest(summaries) {
    return new Function('summaries', `
        // CỐ Ý không định nghĩa generateDailySummary/readChatHistory/callSmartRoute: nếu nhánh
        // nhiều-ngày lỡ gọi tới, test phải nổ ReferenceError ngay — bằng chứng mạnh hơn spy đếm 0 lần.
        const getSummary = async (gid, d) => summaries[gid + '|' + d] || null;
        const getGroupName = (g) => 'Nhóm ' + g;
        ${extract('addDaysStr')}
        ${extract('dateRangeList')}
        ${extract('buildDigestParts')}
        ${extract('buildDigestMessages')}
        return { buildDigestParts, buildDigestMessages };
    `)(summaries);
}

test('range nhiều ngày: KHÔNG gọi generateDailySummary dù thiếu cache (chỉ đọc, không sinh lại)', async () => {
    const { buildDigestParts } = loadRangeDigest({
        'g1|2026-08-12': { messageCount: 3, sections: { highlights: ['a'], participants: ['p'] } },
        'g1|2026-08-14': { messageCount: 2, sections: { highlights: ['b'], participants: ['p'] } },
        // 2026-08-13, 15, 16 KHÔNG có cache — nhánh nhiều-ngày không được tự sinh để lấp.
    });
    const r = await buildDigestParts(['g1'], { from: '2026-08-12', to: '2026-08-16' });
    assert.equal(r.totalMsgs, 5, 'chỉ cộng đúng những ngày có cache');
    assert.deepEqual(r.missingDates, ['2026-08-13', '2026-08-15', '2026-08-16'], '3/5 ngày thiếu');
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
        // Range 1 ngày (ví dụ 'yesterday') đi nhánh cũ của buildDigestParts, cần đủ hai phụ thuộc
        // này — cache đã đủ (rawCount 0 <= cache.messageCount) nên không chạm generateDailySummary.
        const readChatHistory = async () => [];
        const generateDailySummary = async () => { throw new Error('KHÔNG được sinh lại trong xem trước'); };
        ${extract('addDaysStr')}
        ${extract('dateRangeList')}
        ${extract('normalizeReportForFields')}
        ${extract('reportRangeFor')}
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

test('[d] Xem trước lịch last7 ra ĐÚNG 7 ngày kết thúc hôm qua, kèm cảnh báo ngày thiếu', async () => {
    const r = await simulatePreview({
        summaries: { 'g1|2026-08-17': { messageCount: 1, sections: {} } }, // 6/7 ngày thiếu
        payload: { reportFor: 'last7' },
        runDate: '2026-08-18',
    });
    assert.deepEqual({ from: r.from, to: r.to }, { from: '2026-08-11', to: '2026-08-17' });
    assert.equal(r.missingDates.length, 6);
    assert.match(r.texts.join('\n'), /⚠️ 6\/7 ngày chưa có bản tổng hợp/);
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
    const { buildDigestMessages } = loadRangeDigest({});
    const { texts } = await buildDigestMessages(['g1'], { from: '2026-08-10', to: '2026-08-11' });
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Không có nhóm nào có tin nhắn được ghi trong khoảng này/);
    assert.match(texts[0], /⚠️ 2\/2 ngày chưa có bản tổng hợp/);
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

test('last7/last30: 7/30 ngày kết thúc HÔM QUA, không tính hôm nay dở dang', () => {
    assert.deepEqual(reportRangeFor({ reportFor: 'last7' }, '2026-08-18'), { from: '2026-08-11', to: '2026-08-17' });
    assert.deepEqual(reportRangeFor({ reportFor: 'last30' }, '2026-08-18'), { from: '2026-07-19', to: '2026-08-17' });
});

test('thisMonth: từ ngày 1 tháng này tới hôm qua; chạy đúng ngày 1 thì coi là một ngày (hôm qua)', () => {
    assert.deepEqual(reportRangeFor({ reportFor: 'thisMonth' }, '2026-08-18'), { from: '2026-08-01', to: '2026-08-17' });
    assert.deepEqual(reportRangeFor({ reportFor: 'thisMonth' }, '2026-08-01'), { from: '2026-07-31', to: '2026-07-31' },
        'ngày 1 đầu tháng: "hôm qua" thuộc tháng trước → không để from > to');
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
