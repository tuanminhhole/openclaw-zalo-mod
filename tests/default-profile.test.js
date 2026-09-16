import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const source = readFileSync(new URL('index.js', root), 'utf8');

// Bối cảnh (16/09/2026, bot "Bs Tuấn A" trên mac_dr-tuan): tài khoản zalo-connect `default` mất phiên,
// chủ bot chuyển sang `bstuana`, openclaw đã ghi `channels.zalo-connect.defaultAccount = "bstuana"`.
// Owner nhờ bot kết bạn với thành viên nhóm → bot gọi `get-friends` KHÔNG kèm profile → zalo-mod rơi về
// chuỗi cứng 'default' → "đăng nhập thất bại", dù bstuana đang kết nối ngay bên cạnh.
// Luật mới: bot mặc định của zalo-mod đọc từ openclaw.json; 'default' chỉ còn là fallback cuối.

/** Trích NGUYÊN VĂN hàm top-level từ index.js rồi dựng lại với phụ thuộc giả - test bám bản thật. */
function buildResolveDefaultProfile(openclawJsonPath) {
    const m = source.match(/let _defaultProfileCache = [^;]+;\s*function resolveDefaultProfile\(\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'không tìm thấy resolveDefaultProfile trong index.js');
    const factory = new Function('readFileSync', 'getOpenclawJsonPath', `${m[0]}\nreturn resolveDefaultProfile;`);
    return factory(readFileSync, () => openclawJsonPath);
}

function writeCfg(cfg) {
    const dir = mkdtempSync(join(tmpdir(), 'zm-default-profile-'));
    const p = join(dir, 'openclaw.json');
    writeFileSync(p, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
    return p;
}

test('resolveDefaultProfile: lấy channels.zalo-connect.defaultAccount của openclaw', () => {
    const fn = buildResolveDefaultProfile(writeCfg({ channels: { 'zalo-connect': { defaultAccount: 'bstuana' } } }));
    assert.equal(fn(), 'bstuana');
});

test('resolveDefaultProfile: không khai / rỗng / file hỏng → "default" như hành vi cũ', () => {
    assert.equal(buildResolveDefaultProfile(writeCfg({ channels: { 'zalo-connect': {} } }))(), 'default');
    assert.equal(buildResolveDefaultProfile(writeCfg({ channels: { 'zalo-connect': { defaultAccount: '  ' } } }))(), 'default');
    assert.equal(buildResolveDefaultProfile(writeCfg('{ hỏng'))(), 'default');
    assert.equal(buildResolveDefaultProfile('/khong/ton/tai/openclaw.json')(), 'default');
});

test('đường nóng của action không còn chuỗi cứng "default": runDashboardZcaAction + primaryProfile', () => {
    // Điểm rơi của mọi action lẻ không kèm profile.
    assert.match(source, /let targetProfile = resolveDefaultProfile\(\);/,
        'runDashboardZcaAction phải khởi tạo targetProfile từ resolveDefaultProfile(), không phải \'default\'');
    assert.doesNotMatch(source, /let targetProfile = 'default';/);

    // primaryProfile(undefined) trước đây ra 'default' vì parseProfiles đổi undefined→'default' TRƯỚC khi
    // tới fallback. Nay phải chặn rỗng ngay đầu hàm.
    const m = source.match(/function primaryProfile\(profileStr\) \{[\s\S]*?\n {8}\}/);
    assert.ok(m, 'không tìm thấy primaryProfile');
    assert.match(m[0], /if \(!raw\) return resolveDefaultProfile\(\);/);
    assert.doesNotMatch(m[0], /\|\| 'default'/, 'primaryProfile không được rơi về chuỗi cứng');

    // Chạy thật primaryProfile với parseProfiles nguyên bản của index.js.
    const pp = source.match(/function parseProfiles\(profileStr\) \{[\s\S]*?\n {8}\}/);
    assert.ok(pp);
    const run = new Function('resolveDefaultProfile', `${pp[0]}\n${m[0]}\nreturn primaryProfile;`);
    const primaryProfile = run(() => 'bstuana');
    assert.equal(primaryProfile(undefined), 'bstuana', 'nhóm chưa ghi profile → bot mặc định của openclaw');
    assert.equal(primaryProfile(''), 'bstuana');
    assert.equal(primaryProfile('default,bstuana'), 'default', 'nhóm đã ghi profile thì giữ đúng profile đầu');
    assert.equal(primaryProfile('tro-ly-bstuan-bot'), 'tro-ly-bstuan-bot');
});
