import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * P18 — BUG MẤT LICENSE: restart là license Pro/Lifetime bị trial GHI ĐÈ.
 *
 * Nguyên nhân gốc: `ensureTrialIfFirstInstall()` từng bị gọi lúc khởi động plugin mà KHÔNG
 * `await ensureStore()` trước → `store.getSetting('global','license')` trả `{}` dù `license.json`
 * trên đĩa đã có `key`/`orderId` → điều kiện chặn không ăn → xin trial mới → GHI ĐÈ license đã mua.
 *
 * Test theo đúng lối `report-jobs.test.js`: trích hàm THẬT từ index.js, chạy với dependency giả —
 * kiểm HÀNH VI, không kiểm chuỗi văn bản. Không định nghĩa những thứ không nên bị gọi (kiểu
 * "bằng chứng mạnh hơn spy") ở nơi hợp lý.
 */
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function extract(signature) {
    const re = new RegExp(`(?:async )?function ${signature}\\([\\s\\S]*?\\n        \\}`);
    const match = source.match(re);
    assert.ok(match, `không tìm thấy hàm ${signature}() trong index.js`);
    return match[0];
}

/**
 * `setSetting` là một METHOD trong object literal trả về bởi `createStore` (cú pháp rút gọn
 * `name(...) { ... }`, không có từ khoá `function`), và đóng bằng `\n        },` (có dấu phẩy, vì là
 * một property) — khác hẳn khuôn của `extract()` ở trên. Bỏ dấu phẩy cuối rồi thêm `function ` để có
 * một function declaration hợp lệ, dán nguyên văn vào sandbox — không viết lại logic để test.
 */
function extractMethod(name) {
    const re = new RegExp(`${name}\\([^)]*\\) \\{[\\s\\S]*?\\n        \\},`);
    const match = source.match(re);
    assert.ok(match, `không tìm thấy method ${name}() trong createStore`);
    return match[0].replace(/,$/, '');
}

// ── Layer 3: setSetting('global','license', …) — chốt chặn cuối, không phụ thuộc caller nhớ kiểm ──

function makeRealSetSetting(initialLicense, warnLog = []) {
    const body = extractMethod('setSetting');
    const factory = new Function('initialLicense', 'logger', `
        let license = initialLicense;
        let settings = {};
        function ${body}
        return { setSetting, getLicense: () => license };
    `);
    return factory(initialLicense, { warn: (m) => warnLog.push(m), info: () => {} });
}

test('setSetting (layer 3): license ĐÃ MUA (có key) → trial mới KHÔNG được ghi đè, cảnh báo rõ ràng', () => {
    const warnLog = [];
    const paid = { valid: true, plan: 'lifetime', key: 'ZALOMKT-LIFETIME-20990101-abc', orderId: '', isTrial: false };
    const { setSetting, getLicense } = makeRealSetSetting(paid, warnLog);
    setSetting('global', 'license', { valid: true, plan: 'personal', deviceId: 'X', isTrial: true, orderId: '', entitlement: 'fake' });
    assert.deepEqual(getLicense(), paid, 'license cũ phải giữ NGUYÊN VẸN, không đổi field nào');
    assert.equal(warnLog.length, 1, 'phải có đúng 1 dòng cảnh báo khi chặn');
    assert.match(warnLog[0], /BLOCKED/);
});

test('setSetting (layer 3): license ĐÃ MUA qua orderId (không có key) → trial mới cũng bị chặn y hệt', () => {
    const paid = { valid: true, plan: 'personal', orderId: 'ORD-123', isTrial: false };
    const { setSetting, getLicense } = makeRealSetSetting(paid);
    setSetting('global', 'license', { valid: true, isTrial: true, orderId: '' });
    assert.deepEqual(getLicense(), paid);
});

test('setSetting (layer 3): license đang là TRIAL (chưa mua) → trial mới vẫn ghi được bình thường (refresh/renew trial)', () => {
    const currentTrial = { valid: true, plan: 'personal', orderId: 'trial-sub-xyz', isTrial: true };
    const nextTrial = { valid: true, plan: 'personal', orderId: 'trial-sub-xyz', isTrial: true, entitlementExp: 999 };
    const { setSetting, getLicense } = makeRealSetSetting(currentTrial);
    setSetting('global', 'license', nextTrial);
    assert.deepEqual(getLicense(), nextTrial, 'trial gặp lại trial không phải bug P18 — vẫn phải ghi được');
});

test('setSetting (layer 3): license đã mua, bản ghi mới KHÔNG đánh dấu isTrial (activate/refresh thật) → vẫn ghi bình thường', () => {
    const paid = { valid: true, key: 'ZALOMKT-OLD', isTrial: false };
    const refreshed = { valid: true, key: 'ZALOMKT-OLD', plan: 'lifetime', entitlementExp: 123456 };
    const { setSetting, getLicense } = makeRealSetSetting(paid);
    setSetting('global', 'license', refreshed);
    assert.deepEqual(getLicense(), refreshed, 'chỉ chặn khi value.isTrial === true, không chặn refresh/activate thật');
});

test('setSetting: nhóm/key khác "global"/"license" không đụng license, vẫn ghi vào settings như cũ', () => {
    const { setSetting, getLicense } = makeRealSetSetting({ key: 'ZALOMKT-X' });
    setSetting('g1', 'muted', true);
    assert.deepEqual(getLicense(), { key: 'ZALOMKT-X' }, 'license không bị đụng khi ghi setting của nhóm khác');
});

// ── Layer 1 + 2 + 4: ensureTrialIfFirstInstall ────────────────────────────────────────────────────

function makeTrialSandbox({ onDiskLicense = {}, payload = {}, licenseServerFetchImpl } = {}) {
    const infoLog = [];
    const warnLog = [];
    const setSettingCalls = [];
    let loadCalls = 0;
    let inMemoryLicense = {}; // TRỐNG cho tới khi load() chạy — đúng hệt điều kiện gây bug thật
    const store = {
        async load() { loadCalls++; inMemoryLicense = { ...onDiskLicense }; },
        getSetting(scope, key) {
            if (scope === 'global' && key === 'license') return inMemoryLicense;
            return undefined;
        },
        setSetting(scope, key, value) {
            setSettingCalls.push({ scope, key, value });
            if (scope === 'global' && key === 'license') inMemoryLicense = value;
        },
        async saveSettings() {},
    };
    const licenseServerFetch = licenseServerFetchImpl
        ? (pathname, opts) => licenseServerFetchImpl(store, pathname, opts)
        : async () => ({ entitlement: 'fake-signed-proof' });
    const factory = new Function(
        'store', 'fs', 'logger', 'getDeviceId', 'getDeviceFingerprint', 'licenseServerFetch',
        'verifySignedEntitlement', 'MKT_PUBLIC_KEY',
        `
        let storeLoaded = false;
        let _settingsMtime = 0;
        const _settingsFile = 'fake-settings-file-for-test.json';
        ${extract('ensureStore')}
        let trialRequest = null;
        ${extract('ensureTrialIfFirstInstall')}
        return { ensureTrialIfFirstInstall, ensureStore, isLoaded: () => storeLoaded };
        `,
    );
    const fakeFs = { stat: async () => { throw new Error('ENOENT (test — không có file thật)'); } };
    const fakeVerify = () => ({ valid: true, payload });
    const sandbox = factory(
        store, fakeFs, { info: (m) => infoLog.push(m), warn: (m) => warnLog.push(m) },
        () => 'DEVICE-TEST-1',
        () => ({}),
        licenseServerFetch,
        fakeVerify,
        'FAKE_PUBLIC_KEY',
    );
    return {
        ...sandbox, infoLog, warnLog, setSettingCalls,
        getLicense: () => inMemoryLicense,
        getLoadCalls: () => loadCalls,
    };
}

// Tái hiện ĐÚNG bug P18: store chưa nạp lúc gọi (đúng hệt caller cũ ở dòng khởi động plugin), license
// trên đĩa đã có orderId (đã mua) — trước khi vá, `existing` đọc ra `{}` nên xin trial rồi ghi đè.
test('ensureTrialIfFirstInstall (layer 1 — tái hiện đúng bug P18): store CHƯA nạp, license trên đĩa đã có orderId → KHÔNG xin trial, KHÔNG ghi đè', async () => {
    const onDisk = { valid: true, plan: 'lifetime', orderId: 'ORD-999', key: '', isTrial: false };
    const sandbox = makeTrialSandbox({ onDiskLicense: onDisk });
    const result = await sandbox.ensureTrialIfFirstInstall();
    assert.equal(result, false, 'không được xin trial');
    assert.equal(sandbox.setSettingCalls.length, 0, 'KHÔNG được gọi setSetting một lần nào — đây chính là hành vi ghi đè của bug gốc');
    assert.deepEqual(sandbox.getLicense(), onDisk, 'license trên đĩa phải giữ nguyên vẹn');
    assert.ok(sandbox.isLoaded(), 'ensureTrialIfFirstInstall phải TỰ nạp store trước khi đọc license (layer 1)');
    assert.equal(sandbox.getLoadCalls(), 1, 'store.load() phải được gọi đúng một lần');
});

test('ensureTrialIfFirstInstall (layer 1): license trên đĩa có `key` (mua bằng key) → cũng KHÔNG bị đè', async () => {
    const onDisk = { valid: true, key: 'ZALOMKT-PERSONAL-20990101-xyz' };
    const sandbox = makeTrialSandbox({ onDiskLicense: onDisk });
    const result = await sandbox.ensureTrialIfFirstInstall();
    assert.equal(result, false);
    assert.equal(sandbox.setSettingCalls.length, 0);
});

// Máy mới THẬT (license.json rỗng thật sự) vẫn phải xin trial bình thường — vá bug không được phá
// luôn cả đường trial hợp lệ.
test('ensureTrialIfFirstInstall: máy mới thật (license rỗng) vẫn tự nạp store rồi xin trial bình thường, log nêu lý do (layer 4)', async () => {
    const sandbox = makeTrialSandbox({ onDiskLicense: {}, payload: { plan: 'personal', licenseExpiry: '2026-09-18', exp: 9999999999 } });
    const result = await sandbox.ensureTrialIfFirstInstall();
    assert.equal(result, true);
    assert.equal(sandbox.setSettingCalls.length, 1);
    assert.equal(sandbox.getLicense().isTrial, true);
    assert.equal(sandbox.warnLog.length, 0);
    assert.equal(sandbox.infoLog.length, 1);
    assert.match(sandbox.infoLog[0], /activated 30-day Pro trial/);
    assert.match(sandbox.infoLog[0], /lý do/, 'layer 4: log lúc cấp trial phải nêu lý do coi là máy mới');
});

// Layer 2: giữa lúc `await licenseServerFetch` (mạng), một tiến trình khác (owner activate license
// thật qua dashboard) ghi license thật vào — phải kiểm LẠI và huỷ, không ghi đè dù đã đi tới bước cuối.
test('ensureTrialIfFirstInstall (layer 2 — race điều kiện mạng): license được ghi bởi tiến trình khác NGAY TRONG lúc chờ server → huỷ, không ghi đè', async () => {
    let raceInjected = false;
    const sandbox = makeTrialSandbox({
        onDiskLicense: {},
        payload: { plan: 'personal' },
        licenseServerFetchImpl: async (store) => {
            // Mô phỏng: trong lúc đang chờ mạng, dashboard activate xong license thật.
            store.setSetting('global', 'license', { valid: true, key: 'ZALOMKT-REAL', orderId: 'ORD-RACE' });
            raceInjected = true;
            return { entitlement: 'fake-signed-proof' };
        },
    });
    const result = await sandbox.ensureTrialIfFirstInstall();
    assert.ok(raceInjected, 'test phải thật sự mô phỏng được race (nếu không thì test này vô nghĩa)');
    assert.equal(result, false, 'phải huỷ, không tính là đã cấp trial thành công');
    assert.equal(sandbox.getLicense().orderId, 'ORD-RACE', 'license thật (ghi trong lúc chờ mạng) không được ghi đè');
    assert.equal(sandbox.getLicense().key, 'ZALOMKT-REAL');
    assert.ok(sandbox.warnLog.some((m) => /race điều kiện|NGAY TRƯỚC khi ghi/.test(m)), 'phải log rõ lý do huỷ (layer 4)');
});

// Trùng lặp lượt gọi: hai lượt gọi gần nhau khi đang có một request đang chạy phải dùng CHUNG một
// promise (coalescing sẵn có, không phải P18 nhưng phải không bị vá hỏng).
test('ensureTrialIfFirstInstall: hai lượt gọi chồng nhau chỉ gửi MỘT request lên server (coalescing không bị vá hỏng)', async () => {
    let fetchCalls = 0;
    const sandbox = makeTrialSandbox({
        onDiskLicense: {},
        payload: { plan: 'personal' },
        licenseServerFetchImpl: async () => {
            fetchCalls++;
            await new Promise((r) => setTimeout(r, 5));
            return { entitlement: 'fake-signed-proof' };
        },
    });
    const [a, b] = await Promise.all([sandbox.ensureTrialIfFirstInstall(), sandbox.ensureTrialIfFirstInstall()]);
    assert.equal(a, true);
    assert.equal(b, true);
    assert.equal(fetchCalls, 1, 'hai lượt gọi chồng nhau chỉ được gửi đúng 1 request');
});
