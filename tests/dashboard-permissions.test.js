import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// dashboard.js là script browser (không phải ES module) nên không import trực tiếp.
// Trích đúng hàm cần kiểm rồi chạy thật với biến ngoài được nạp vào — kiểm HÀNH VI,
// không phải kiểm chuỗi văn bản.
const source = readFileSync(new URL('../dashboard.js', import.meta.url), 'utf8');

function loadPermProfile() {
    const match = source.match(/function permProfile\(\) \{[\s\S]*?\n\}/);
    assert.ok(match, 'không tìm thấy hàm permProfile() trong dashboard.js');
    return (selectedBotFilter, state) => new Function(
        'selectedBotFilter', 'state', `${match[0]}\nreturn permProfile();`,
    )(selectedBotFilter, state);
}

const permProfile = loadPermProfile();

test('1 bot: tự suy ra bot đó dù thanh chọn bot chưa từng được render', () => {
    // Thanh chọn bot ở topbar CHỈ render khi state.bots.length > 1, nên máy 1 bot thì
    // selectedBotFilter mãi là 'all'. Trước đây trang phân quyền chỉ hiện câu
    // "chọn 1 bot ở thanh chọn bot phía trên" — trong khi thanh đó không tồn tại.
    const state = { bots: [{ profile: 'default', name: 'Minh Khang' }] };
    assert.equal(permProfile('all', state), 'default');
});

test('1 bot có profile không phải "default" vẫn suy ra đúng', () => {
    const state = { bots: [{ profile: 'mkt', name: 'Mkt' }] };
    assert.equal(permProfile('all', state), 'mkt');
});

test('nhiều bot + đang chọn "tất cả bot": KHÔNG tự đoán, để user chọn', () => {
    const state = { bots: [{ profile: 'default' }, { profile: 'mkt' }] };
    assert.equal(permProfile('all', state), '', 'gộp group của nhiều bot sẽ hiện nhóm dùng chung 2 lần');
});

test('nhiều bot + đã chọn 1 bot cụ thể: tôn trọng lựa chọn của user', () => {
    const state = { bots: [{ profile: 'default' }, { profile: 'mkt' }] };
    assert.equal(permProfile('mkt', state), 'mkt');
});

test('chưa có bot nào / state chưa load: không trả về profile bừa', () => {
    assert.equal(permProfile('all', { bots: [] }), '');
    assert.equal(permProfile('all', {}), '');
    assert.equal(permProfile('all', null), '');
});

test('renderPermissions dùng permProfile() và gửi đúng profile đó lên API', () => {
    const fn = source.slice(source.indexOf('async function renderPermissions()'));
    const body = fn.slice(0, fn.indexOf('\nfunction rebuildPermCards'));
    assert.match(body, /const profile = permProfile\(\);/);
    assert.match(body, /journalApi\('get-permissions', \{ profile \}\)/);
    // Không được quay lại gate cũ chỉ dựa vào selectedBotFilter.
    assert.doesNotMatch(body, /if \(selectedBotFilter === 'all'\)/);
});

test('trạng thái rỗng phân biệt "chưa có bot" với "nhiều bot chưa chọn"', () => {
    const fn = source.slice(source.indexOf('async function renderPermissions()'));
    const body = fn.slice(0, fn.indexOf('\nfunction rebuildPermCards'));
    assert.match(body, /botCount === 0/);
    assert.match(body, /Sync Account/, 'chưa có bot thì phải chỉ tới Sync Account, không chỉ tới thanh chọn bot rỗng');
    assert.match(body, /thanh chọn bot phía trên/, 'nhiều bot thì vẫn giữ hướng dẫn chọn bot');
});

test('mở tab trước khi state về: hiện "Đang tải" rồi tự nạp lại khi state có', () => {
    const fn = source.slice(source.indexOf('async function renderPermissions()'));
    const body = fn.slice(0, fn.indexOf('\nfunction rebuildPermCards'));
    assert.match(body, /if \(!state\) \{/, 'không có state thì đừng báo "chưa có bot"');
    // renderState phải gọi lại renderPermissions, nếu không trang đứng ở "Đang tải...".
    const rs = source.slice(source.indexOf('function renderState()'));
    const rsBody = rs.slice(0, rs.indexOf('\nfunction countPendingHint'));
    assert.match(rsBody, /permissions'\)\?\.classList\.contains\('active'\) && !permState\.data\) renderPermissions\(\)/);
});
