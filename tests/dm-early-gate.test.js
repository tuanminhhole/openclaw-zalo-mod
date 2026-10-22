import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { decideEarlyDmBlock, isOwnerClaimText } from '../src/integration/dm-gate.js';

// Bối cảnh (vps_trang-alisa 21/10/2026): Phân quyền chỉ cho vài người DM, nhưng người ngoài danh
// sách nhắn vào vẫn được bot thả tim. zalo-connect thả reaction tự động TRƯỚC dispatch, còn cổng DM
// của zalo-mod nằm ở before_dispatch nên tới lúc chặn thì tim đã thả. Cổng sớm ở onInbound của bridge
// chạy trước bước thả reaction.

const OWNER = '7632363896866988157';
const ALLOWED = '3432520541844795188';
const STRANGER = '810620679965300393';

function listGate(allowList = [ALLOWED], allowNames = []) {
    return (id, name) => allowList.includes(String(id))
        || (!!name && allowNames.map((n) => n.toLowerCase()).includes(String(name).toLowerCase()));
}

test('người ngoài danh sách DM bị chặn sớm', async () => {
    const r = await decideEarlyDmBlock({ senderId: STRANGER, text: 'Ok Trang', ownerId: OWNER, mode: 'list', isDmAllowed: listGate() });
    assert.equal(r.block, true);
});

test('người trong danh sách DM đi tiếp, vẫn được thả reaction', async () => {
    const r = await decideEarlyDmBlock({ senderId: ALLOWED, text: 'chào', ownerId: OWNER, mode: 'list', isDmAllowed: listGate() });
    assert.equal(r.block, false);
});

test('owner luôn đi tiếp kể cả khi DM chỉ dành cho owner', async () => {
    const r = await decideEarlyDmBlock({ senderId: OWNER, text: 'xin chào', ownerId: OWNER, mode: 'owner', isDmAllowed: () => false });
    assert.equal(r.block, false);
});

test('chế độ "owner" và "none" chặn mọi người khác', async () => {
    for (const mode of ['owner', 'none']) {
        const r = await decideEarlyDmBlock({ senderId: ALLOWED, text: 'hi', ownerId: OWNER, mode, isDmAllowed: () => false });
        assert.equal(r.block, true, mode);
    }
});

test('chế độ "all" không chặn ai', async () => {
    const r = await decideEarlyDmBlock({ senderId: STRANGER, text: 'hi', ownerId: OWNER, mode: 'all', isDmAllowed: () => true });
    assert.equal(r.block, false);
});

test('lệnh nhận chủ phải lọt để before_dispatch còn trả lời được', async () => {
    for (const text of ["i'm owner 7D2317B13D732A7D", 'im owner', 'I am admin', '/bot-ownerid']) {
        const r = await decideEarlyDmBlock({ senderId: STRANGER, text, ownerId: OWNER, cmdPrefix: '/bot-', mode: 'owner', isDmAllowed: () => false });
        assert.equal(r.block, false, text);
    }
});

test('câu thường có chữ "owner" ở giữa vẫn bị chặn', async () => {
    const r = await decideEarlyDmBlock({ senderId: STRANGER, text: 'ai là owner của bot vậy', ownerId: OWNER, cmdPrefix: '/bot-', mode: 'owner', isDmAllowed: () => false });
    assert.equal(r.block, true);
});

test('khớp theo TÊN thật sau khi tra API (id khác nhau theo từng bot)', async () => {
    let asked = 0;
    const r = await decideEarlyDmBlock({
        senderId: STRANGER, text: 'hi', ownerId: OWNER, mode: 'list',
        isDmAllowed: listGate([], ['Thai Ha']),
        resolveName: async () => { asked += 1; return 'Thai Ha'; },
    });
    assert.equal(r.block, false);
    assert.equal(r.name, 'Thai Ha');
    assert.equal(asked, 1);
});

test('chỉ tra tên khi chế độ cần danh sách', async () => {
    let asked = 0;
    const r = await decideEarlyDmBlock({
        senderId: STRANGER, text: 'hi', ownerId: OWNER, mode: 'owner',
        isDmAllowed: () => false,
        resolveName: async () => { asked += 1; return 'Thai Ha'; },
    });
    assert.equal(r.block, true);
    assert.equal(asked, 0);
});

test('không có senderId thì không chặn (không đoán)', async () => {
    const r = await decideEarlyDmBlock({ senderId: '', text: 'hi', mode: 'none', isDmAllowed: () => false });
    assert.equal(r.block, false);
});

test('mẫu lệnh nhận chủ khớp đúng nhánh claim trong handleZaloDispatch', () => {
    assert.equal(isOwnerClaimText("i’m owner ABC", '/bot-'), true);
    assert.equal(isOwnerClaimText('/bot-owner', '/bot-'), true);
    assert.equal(isOwnerClaimText('/bot-ownerid 123', '/bot-'), true);
    assert.equal(isOwnerClaimText('owner', '/bot-'), false);
    assert.equal(isOwnerClaimText('im owner nhé bạn ơi', '/bot-'), false);
});

test('index.js nối cổng sớm vào nhánh DM của onInbound và trả handled khi chặn', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(source, /import \{ decideEarlyDmBlock \} from '\.\/src\/integration\/dm-gate\.js';/);
    const start = source.indexOf('zEngine.bridge.onInbound(async (event) => {');
    assert.ok(start > -1, 'không tìm thấy onInbound');
    // Nhánh DM: từ `if (!event.isGroup) {` tới dấu đóng ngoặc cùng mức thụt lề.
    const branchStart = source.indexOf('if (!event.isGroup) {', start);
    const block = source.slice(branchStart, source.indexOf('\n            }\n', branchStart));
    assert.match(block, /decideEarlyDmBlock\(/, 'nhánh DM phải gọi cổng sớm');
    assert.match(block, /if \(gate\.block\) \{[\s\S]*?return \{ handled: true \};/, 'bị chặn thì phải trả handled để zalo-connect bỏ reaction');
    assert.ok(block.indexOf('captureInbound(') < block.indexOf('decideEarlyDmBlock('), 'vẫn phải ghi tin vào khung chat trước khi chặn');
});
