import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const source = readFileSync(new URL('index.js', root), 'utf8');

// Bối cảnh (30/08/2026, bot "Em Mơ"): thành viên tag bot trong nhóm mà bot chỉ thả tim, không trả
// lời. Đo thật trên hook `before_dispatch` — tin NHÓM đến dưới dạng:
//     conversationId = "'zalo-connect':<GROUP_ID>"   (KHÔNG có tiền tố `group:`)
//     event.isGroup  = false                          (openclaw báo SAI)
// Đúng y hình dạng của DM (`'zalo-connect':<USER_ID>`) ⇒ KHÔNG thể phân biệt bằng hình dạng chuỗi.
// Đoán sai thì mọi tin nhóm rơi vào nhánh DM: `permissions.dm.mode="owner"` khoá luôn cả nhóm,
// ngoài owner ra không ai nói được với bot ở BẤT KỲ đâu, và tin bị `handled:true` nuốt mất nên
// zalo-connect không ghi lại dấu vết nào — cực khó chẩn.
//
// Nguồn tin cậy duy nhất là SỔ NHÓM của chính plugin (`groupNames`, tra qua `plainGroupId`).

function readExpr(name) {
    const m = source.match(new RegExp(`const ${name} = ([^;]+);`));
    assert.ok(m, `không tìm thấy khai báo ${name} trong index.js`);
    return m[1];
}

test('nhận biết nhóm phải tra SỔ NHÓM, không chỉ dựa vào hình dạng chuỗi', () => {
    const expr = readExpr('isGroupMsg');
    assert.match(expr, /knownGroupId/, 'phải tra sổ nhóm (plainGroupId) — cờ và tiền tố đều không đáng tin');
    assert.match(readExpr('knownGroupId'), /plainGroupId\(/, 'knownGroupId phải lấy từ plainGroupId');
    assert.ok(
        !/^\s*rawConvId\.startsWith\('group:'\)\s*$/.test(expr),
        'không được suy DM/nhóm CHỈ từ tiền tố `group:`',
    );
});

test('đuôi id phải cắt sau dấu ":" cuối — tiền tố là tên kênh có nháy đơn', () => {
    const expr = readExpr('convTailId');
    assert.match(expr, /replace\(\/\^\.\*:\/, ''\)/, "phải cắt tới dấu ':' cuối, không chỉ bóc `group:`");
    // "'zalo-connect':123" → "123"; nếu chỉ bóc `group:` thì ra nguyên chuỗi rác.
    const tail = new Function('rawConvId', `return ${expr};`);
    assert.equal(tail("'zalo-connect':1388856161660695956"), '1388856161660695956');
    assert.equal(tail('group:1388856161660695956'), '1388856161660695956');
    assert.equal(tail('1388856161660695956'), '1388856161660695956');
});

test('groupId dùng cho GROUP ACCESS GATE phải là id sạch, không phải chuỗi rác', () => {
    // Trong file có nhiều khai báo `groupId`; chỉ lấy đúng cái ngay trước GROUP ACCESS GATE.
    const m = source.match(/const groupId = ([^;]+);\s*\n\s*\n\s*\/\/ ── GROUP ACCESS GATE/);
    assert.ok(m, 'không tìm thấy khai báo groupId ngay trước GROUP ACCESS GATE');
    const expr = m[1];
    assert.match(expr, /knownGroupId/, 'thiếu cái này thì isGroupAllowed() luôn trượt với conv có nháy đơn');
    const gid = new Function('knownGroupId', 'rawConvId', `return ${expr};`);
    assert.equal(gid('1388856161660695956', "'zalo-connect':1388856161660695956"), '1388856161660695956');
    assert.equal(gid('', 'group:660480738714903026'), '660480738714903026', 'vẫn chạy cho đường có tiền tố');
});

test('nhánh DM chỉ chạy khi KHÔNG phải nhóm', () => {
    // Luật nghiệp vụ Kent chốt: "DM chỉ owner" áp cho tin nhắn riêng, nhóm không tính.
    assert.match(source, /if \(!isGroupMsg\) \{/, 'nhánh DM phải nằm sau `if (!isGroupMsg)`');
    const gateIdx = source.indexOf('if (!isGroupMsg) {');
    const dmBlockIdx = source.indexOf('chặn theo permissions.dm');
    assert.ok(gateIdx > -1 && dmBlockIdx > gateIdx, 'log chặn DM phải nằm trong nhánh !isGroupMsg');
});

test('bảng chân trị trên đúng biểu thức đang dùng trong index.js', () => {
    const decide = new Function('event', 'rawConvId', 'knownGroupId', `return ${readExpr('isGroupMsg')};`);
    // Ca thật đã đo được: nhóm, không cờ, không tiền tố, nhưng id nằm trong sổ nhóm.
    assert.equal(decide({ isGroup: false }, "'zalo-connect':1388856161660695956", '1388856161660695956'), true);
    // DM thật: id người gửi KHÔNG có trong sổ nhóm ⇒ plainGroupId trả ''.
    assert.equal(decide({ isGroup: false }, "'zalo-connect':2217625920592607252", ''), false);
    // Hai dự phòng vẫn còn tác dụng.
    assert.equal(decide({ isGroup: true }, "'zalo-connect':999", ''), true, 'cờ đúng thì tin cờ');
    assert.equal(decide({}, 'group:1388856161660695956', ''), true, 'đường publishBridgeInbound có tiền tố');
});

test('captureInbound phải ghi theo dạng chuẩn `group:<id>`, không ghi chuỗi thô', () => {
    // Ghi thô "'zalo-connect':<id>" thì cùng một nhóm nằm ở nhiều hàng hội thoại khác nhau và
    // Khung chat hiện thành nhiều dòng ma với số đếm rời rạc (đo 30/08: 3 khoá cho 1 nhóm).
    // Có 3 lời gọi captureInbound; chỉ lấy cái trong handleZaloDispatch (sau mốc Z2).
    const m = source.match(/Z2: Passive capture[\s\S]*?zEngine\.captureInbound\(\{[\s\S]*?\n {12}\}\)/);
    assert.ok(m, 'không tìm thấy lời gọi captureInbound trong handleZaloDispatch');
    assert.match(
        m[0],
        /conversationId: groupId \? `group:\$\{groupId\}` : rawConvId/,
        'phải chuẩn hoá về `group:<id>` — cùng dạng với đường sync trong zalo-mod-engine.js',
    );
});

test('không ghi bản sinh đôi khi bridge đã ghi rồi', () => {
    // Bridge onInbound ghi mọi tin với msgId THẬT + text THÔ. Nếu handleZaloDispatch ghi thêm thì
    // engine phải bịa id `derived:…` và text là bản đã bọc prompt ⇒ Khung chat hiện mỗi tin 2 dòng.
    const m = source.match(/Z2: Passive capture[\s\S]*?zEngine\.captureInbound\(\{/);
    assert.ok(m, 'không tìm thấy lời gọi captureInbound trong handleZaloDispatch');
    assert.match(
        m[0],
        /if \(!globalThis\.__zaloConnectBridgeService\) zEngine\.captureInbound\(\{/,
        'phải bỏ qua khi bridge đang chạy — nếu không sẽ ghi trùng mỗi tin',
    );
});

test('chuyển sang trang Nhóm/Tổng quan/Thành viên phải refetch state ở nền', () => {
    // Dữ liệu có thể đổi phía server mà không qua tab này (agent sync-groups qua chat). Không
    // refetch thì tab mở sẵn vẽ mãi danh sách cũ — đo 30/08: server 15 nhóm, UI 9 nhóm.
    const dash = readFileSync(new URL('dashboard.js', root), 'utf8');
    assert.match(dash, /if \(id === 'groups' \|\| id === 'overview' \|\| id === 'members'\) refreshStateQuiet\(\);/);
    assert.match(dash, /function refreshStateQuiet\(\)/);
    assert.match(dash, /_stateRefreshQuietInFlight/, 'phải có cờ in-flight chống dồn request');
});
