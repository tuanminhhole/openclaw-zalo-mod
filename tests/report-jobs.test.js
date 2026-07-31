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
        const runReportJob = async (job, date) => { sent.push(job.id); reported.push(date); return { sent: 1, groups: 28 }; };
        const logger = { info() {}, warn(m) { warns.push(String(m)); } };
        ${extract('reportDateFor')}
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

// ── reportFor: lịch buổi sáng phải báo cáo NGÀY HÔM QUA ───────────────────────────────────────
// Bẫy im lặng phát hiện trước khi kịp gây hại (2026-07-31): owner muốn báo cáo 08:00, nhưng digest
// chỉ tóm tắt NGÀY HIỆN TẠI — nên 08:00 sẽ tóm tắt ~8 tiếng đầu ngày (preview ra "0 nhóm · 0 tin"),
// còn trọn ngày hôm trước không bao giờ được báo. Lịch vẫn chạy, vẫn gửi → owner tưởng bot hỏng.
const reportDateFor = new Function(`${extract('reportDateFor')}\nreturn reportDateFor;`)();

test('reportFor "yesterday" trừ đúng một ngày, kể cả khi vắt qua tháng và năm', () => {
    assert.equal(reportDateFor({ reportFor: 'yesterday' }, '2026-07-31'), '2026-07-30');
    assert.equal(reportDateFor({ reportFor: 'yesterday' }, '2026-08-01'), '2026-07-31', 'vắt qua tháng');
    assert.equal(reportDateFor({ reportFor: 'yesterday' }, '2026-01-01'), '2025-12-31', 'vắt qua năm');
    assert.equal(reportDateFor({ reportFor: 'yesterday' }, '2028-03-01'), '2028-02-29', 'năm nhuận');
});

test('mặc định vẫn là hôm nay — lịch cuối ngày đang chạy không được đổi hành vi', () => {
    assert.equal(reportDateFor({}, '2026-07-31'), '2026-07-31');
    assert.equal(reportDateFor({ reportFor: 'today' }, '2026-07-31'), '2026-07-31');
    assert.equal(reportDateFor({ reportFor: 'rác' }, '2026-07-31'), '2026-07-31', 'giá trị lạ → today');
});

test('normalizeReportJob chỉ nhận đúng hai giá trị cho reportFor', () => {
    assert.equal(normalizeReportJob({ reportFor: 'yesterday' }).reportFor, 'yesterday');
    assert.equal(normalizeReportJob({ reportFor: 'today' }).reportFor, 'today');
    assert.equal(normalizeReportJob({}).reportFor, 'today', 'thiếu → today, giữ hành vi cũ');
    assert.equal(normalizeReportJob({ reportFor: 'YESTERDAY' }).reportFor, 'today', 'không nhận hoa/thường lẫn');
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
    assert.deepEqual(sang.reported, ['2026-07-30'], 'runReportJob phải nhận ngày hôm qua');

    const cuoiNgay = await runScheduler({
        jobs: [job({ time: '22:30' })], now: '22:30', today: '2026-07-31',
    });
    assert.deepEqual(cuoiNgay.reported, ['2026-07-31'], 'lịch cuối ngày vẫn là hôm nay');
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
