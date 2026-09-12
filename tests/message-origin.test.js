/**
 * "Câu này bot nhắn hay chính chủ tự gõ?"
 *
 * Bot Zalo cá nhân gửi bằng chính tài khoản của khách, nên trong khung chat hai loại tin đó giống
 * hệt nhau: cùng sender_id, cùng from_self=1. Ngày 12/09/2026 phải SSH vào máy khách, đối chiếu
 * context.db với log `[model-fetch]` của gateway mới trả lời được đúng một câu hỏi như vậy.
 * Bộ test này khoá lại cơ chế thay thế: vân tay payload lúc gửi + nhãn `origin` lúc ghi.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SelfOriginTracker, fingerprint } from '../src/messaging/self-origin-tracker.js';
import { openStore } from '../src/storage/database.js';

test('tracker: tin khớp payload vừa gửi là bot, tin lạ là người gõ', () => {
    const t = new SelfOriginTracker();
    t.remember('Dạ em hiểu rồi chị. Em chỉ hỏi anh Jani thôi.');
    assert.equal(t.claim('Dạ em hiểu rồi chị. Em chỉ hỏi anh Jani thôi.'), 'bot');
    // Câu chủ máy tự gõ không có dấu nào chờ sẵn.
    assert.equal(t.claim('Em ráng giúp đi, anh trả gấp đôi.'), 'human');
});

test('tracker: dấu bị TIÊU sau khi dùng, gõ lại y hệt không bị nhận nhầm là bot', () => {
    const t = new SelfOriginTracker();
    t.remember('ok em');
    assert.equal(t.claim('ok em'), 'bot');
    assert.equal(t.claim('ok em'), 'human', 'lần hai là người gõ lại, không còn dấu');
    // Gửi hai lần thì phải nhận được hai lần.
    t.remember('ok em'); t.remember('ok em');
    assert.equal(t.claim('ok em'), 'bot');
    assert.equal(t.claim('ok em'), 'bot');
    assert.equal(t.claim('ok em'), 'human');
});

test('tracker: mention native bị zalo-connect viết lại vẫn khớp', () => {
    const t = new SelfOriginTracker();
    t.remember('@[Nhung Vn] dạ chị, em ghi nhận rồi ạ');
    // Tin quay về mang mention đã render kèm khoảng trắng kép - fingerprint cắt phần đó đi.
    assert.equal(t.claim('@Nhung Vn  dạ chị, em ghi nhận rồi ạ'), 'bot');
});

test('tracker: khác hoa thường và khoảng trắng thừa vẫn khớp, khác nội dung thì không', () => {
    const t = new SelfOriginTracker();
    t.remember('Chào chị ạ');
    assert.equal(t.claim('  chào   chị ạ  '), 'bot');
    t.remember('Chào chị ạ');
    assert.equal(t.claim('Chào anh ạ'), 'human');
});

test('tracker: dấu quá hạn thì bỏ, không gán nhãn bot cho tin nhiều giờ sau', () => {
    let now = 1_000_000;
    const t = new SelfOriginTracker({ ttlMs: 60_000, now: () => now });
    t.remember('tin cũ');
    now += 61_000;
    assert.equal(t.claim('tin cũ'), 'human');
    assert.equal(t.size, 0, 'dấu hết hạn được dọn');
});

test('fingerprint: chuỗi rỗng không bao giờ khớp (tin ảnh, sticker không có chữ)', () => {
    const t = new SelfOriginTracker();
    assert.equal(fingerprint('   '), '');
    assert.equal(t.remember(''), false);
    assert.equal(t.claim(''), 'human');
});

test('storage: origin chỉ ghi cho tin ĐI RA, và chỉ nhận bot/human', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zalo-mod-origin-'));
    try {
        const store = openStore(path.join(dir, 'context.db'), { logger: { info() { }, warn() { } } });
        if (store.kind !== 'sqlite') return;   // Node < 22.5: không có DatabaseSync, bỏ qua
        store.upsertConversation({ id: 'acc|dm1', accountId: 'acc', type: 'dm', lastMessageAt: 10 });
        const rows = [
            { id: 'm1', conversationId: 'acc|dm1', senderId: 'me', text: 'bot viết', sentAt: 1, fromSelf: true, origin: 'bot' },
            { id: 'm2', conversationId: 'acc|dm1', senderId: 'me', text: 'tôi gõ', sentAt: 2, fromSelf: true, origin: 'human' },
            // Tin của người khác: không có nhãn, kể cả khi caller lỡ truyền vào.
            { id: 'm3', conversationId: 'acc|dm1', senderId: 'them', text: 'họ nhắn', sentAt: 3, fromSelf: false, origin: 'bot' },
            // Giá trị lạ bị loại, không để rác lọt xuống giao diện.
            { id: 'm4', conversationId: 'acc|dm1', senderId: 'me', text: 'nhãn lạ', sentAt: 4, fromSelf: true, origin: 'ai-biet' },
        ];
        store.insertMessages(rows);
        const got = Object.fromEntries(store.recentMessages('acc|dm1', 10).map(m => [m.id, m.origin]));
        assert.equal(got.m1, 'bot');
        assert.equal(got.m2, 'human');
        assert.equal(got.m3, null, 'tin của người khác không mang nhãn nguồn');
        assert.equal(got.m4, null, 'giá trị ngoài bot/human bị loại');
        store.db?.close?.();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('adapter: tin do chính zalo-mod gửi cũng được ghi dấu, không bị gán "Tự gõ"', async () => {
    const { createOpenclawAdapter } = await import('../src/integration/openclaw-adapter.js');
    const tracker = new SelfOriginTracker();
    const sentTexts = [];
    const adapter = createOpenclawAdapter({
        logger: { info() { }, warn() { } },
        getZaloConnectService: () => ({
            executeAction: (_acc, a) => { sentTexts.push(a.message); return { ok: true }; },
        }),
        onSelfSend: (t) => tracker.remember(t),
    });
    await adapter.executeAction('default', { action: 'send-message', threadId: '1', message: 'Báo cáo cuối ngày ạ' });
    assert.deepEqual(sentTexts, ['Báo cáo cuối ngày ạ']);
    assert.equal(tracker.claim('Báo cáo cuối ngày ạ'), 'bot', 'tin plugin tự gửi phải mang nhãn bot');
});

test('adapter: action KHÔNG phải gửi tin thì không ghi dấu bừa', async () => {
    const { createOpenclawAdapter } = await import('../src/integration/openclaw-adapter.js');
    const tracker = new SelfOriginTracker();
    const adapter = createOpenclawAdapter({
        logger: { info() { }, warn() { } },
        getZaloConnectService: () => ({ executeAction: () => ({ ok: true }) }),
        onSelfSend: (t) => tracker.remember(t),
    });
    await adapter.executeAction('default', { action: 'sync-groups', message: 'sync-groups' });
    assert.equal(tracker.size, 0);
});

test('ca thật 13/09: zalo-connect gắn "@Kent " (MỘT khoảng trắng) khi gửi, vẫn phải ra Bot', () => {
    const t = new SelfOriginTracker();
    // Payload OpenClaw đưa xuống - chưa có mention.
    t.remember('Dạ anh Kent, thao tác tạo bình chọn trong nhóm cần chị Tracy yêu cầu trực tiếp giúp em ạ.');
    // Bản quay về từ Zalo - mention native, một khoảng trắng.
    assert.equal(
        t.claim('@Kent Dạ anh Kent, thao tác tạo bình chọn trong nhóm cần chị Tracy yêu cầu trực tiếp giúp em ạ.'),
        'bot',
        'bản đầu gán nhầm "human" ở đúng ca này',
    );
});

test('ca thật 13/09: tên mention nhiều chữ cũng khớp', () => {
    const t = new SelfOriginTracker();
    t.remember('Dạ chị Tracy, em đã đồng bộ lại danh sách nhóm rồi ạ.');
    assert.equal(t.claim('@Tracy Kaulo Dạ chị Tracy, em đã đồng bộ lại danh sách nhóm rồi ạ.'), 'bot');
});

test('ghi dấu hai bản của cùng một câu chỉ tốn MỘT dấu', () => {
    const t = new SelfOriginTracker();
    t.remember('Dạ vâng ạ', '@Kent Dạ vâng ạ');
    assert.equal(t.size, 1, 'hai cách viết, một dấu');
    assert.equal(t.claim('@Kent Dạ vâng ạ'), 'bot');
    assert.equal(t.size, 0, 'khớp một bản là tiêu cả dấu, không để lại dấu thừa');
    assert.equal(t.claim('Dạ vâng ạ'), 'human', 'người gõ lại y hệt sau đó vẫn là Tự gõ');
});

test('không gán nhãn bot cho câu chỉ TRÙNG PHẦN ĐẦU', () => {
    const t = new SelfOriginTracker();
    t.remember('Dạ em đã đồng bộ xong rồi ạ');
    assert.equal(t.claim('Dạ em đã đồng bộ'), 'human');
});
