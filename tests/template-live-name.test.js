import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const source = readFileSync(new URL('index.js', root), 'utf8');

// Bối cảnh (31/08/2026, bot "Em Mơ" → tài khoản đổi tên thành "Em Mơ Trợ Lí"):
// 1. Welcome vẫn in "@Em Mơ" — botName lấy từ config tĩnh, không theo tên Zalo thật.
// 2. Welcome dạy "/bot-menu" trong nhóm CHƯA tick Quyền Group (welcome là toggle theo nhóm, độc
//    lập allowList) → thành viên gõ theo thì GROUP ACCESS GATE nuốt im lặng, như bot hỏng.

function extractFn(name) {
    const m = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(m, `không tìm thấy function ${name}`);
    return new Function(`${m[0]}; return ${name};`)();
}

test('liveBotName: ưu tiên tên Zalo thật, fallback cấu hình, chịu được profile dạng "a,b"', () => {
    const liveBotName = extractFn('liveBotName');
    const bak = globalThis.__zaloModLiveBotNames;
    try {
        globalThis.__zaloModLiveBotNames = { default: 'Em Mơ Trợ Lí' };
        assert.equal(liveBotName('default', 'Em Mơ'), 'Em Mơ Trợ Lí');
        assert.equal(liveBotName('', 'Em Mơ'), 'Em Mơ Trợ Lí', 'profile rỗng quy về default');
        assert.equal(liveBotName('default,phu', 'Em Mơ'), 'Em Mơ Trợ Lí', 'profile gộp "a,b" lấy phần đầu');
        assert.equal(liveBotName('khac', 'Em Mơ'), 'Em Mơ', 'profile chưa có tên live thì fallback');
        globalThis.__zaloModLiveBotNames = {};
        assert.equal(liveBotName('default', 'Em Mơ'), 'Em Mơ', 'bridge chưa trả tên thì fallback');
    } finally {
        globalThis.__zaloModLiveBotNames = bak;
    }
});

test('tên live phải được BẮT ở cả hai đường bridge trả displayName', () => {
    // replayNameTriggers (mỗi lần boot) và set-name-triggers (mỗi lần bấm Lưu ở dashboard).
    // Thiếu một đường là tên live chỉ đúng cho tới lần restart/Lưu kế tiếp.
    const writes = source.match(/\(globalThis\.__zaloModLiveBotNames \|\|= \{\}\)\[accountId\] = dn;/g) || [];
    assert.equal(writes.length, 2, 'phải ghi tên live ở đúng 2 chỗ: replayNameTriggers + set-name-triggers');
});

test('handleZaloDispatch dùng tên live cho mọi chỗ hiển thị', () => {
    assert.match(
        source,
        /const \{ profile, botName: cfgBotName, botNames, cmdPrefix, ownerId: activeOwnerId \} = botCfg;\s*\n[\s\S]{0,400}?const botName = liveBotName\(profile, cfgBotName\);/,
        'botName trong dispatch phải là liveBotName(profile, cfgBotName)',
    );
});

test('welcome watcher dùng tên live', () => {
    assert.match(
        source,
        /renderTemplate\(welcomeTpl, \{ memberName, groupName: getGroupName\(groupId\), botName: liveBotName\(botCfg\.profile, botCfg\.botName\), cmdPrefix: botCfg\.cmdPrefix \}\)/,
    );
});

test('GROUP ACCESS GATE mở ngoại lệ cho lệnh template tĩnh, chặn mọi thứ khác', () => {
    const m = source.match(/GROUP ACCESS GATE[\s\S]*?\n {12}\}/);
    assert.ok(m, 'không tìm thấy khối GROUP ACCESS GATE');
    const gate = m[0];
    assert.match(gate, /'\/noi-quy', '\/menu', '\/huong-dan'/, 'ba lệnh template mặc định phải qua được');
    assert.match(gate, /resolveTemplateKeyByCommand\(_cmd, pluginCfg\)/, 'lệnh gắn template tuỳ chỉnh cũng qua được');
    assert.match(gate, /if \(!_isStaticTpl\) return \{ handled: true \};/, 'không phải template thì vẫn chặn như cũ');
});

test('bảng chân trị trích lệnh trong gate: prefix đúng mới tính', () => {
    // Chạy đúng 4 dòng suy ra _cmd từ source, không chép lại.
    const m = source.match(/const _m = String\(content \|\| ''\)[\s\S]*?const _cmd = [^;]+;/);
    assert.ok(m, 'không tìm thấy đoạn trích lệnh trong gate');
    const derive = new Function('content', 'cmdPrefix', `${m[0]}; return _cmd;`);
    assert.equal(derive('/bot-menu', '/bot-'), '/menu');
    assert.equal(derive('  /bot-noi-quy xem đi', '/bot-'), '/noi-quy');
    assert.equal(derive('/menu', '/bot-'), '', 'thiếu prefix thì không tính');
    assert.equal(derive('cho hỏi giá vàng', '/bot-'), '', 'không có lệnh nào');
});
