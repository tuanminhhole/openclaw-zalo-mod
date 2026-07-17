import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createZaloModEngine } from '../src/integration/zalo-mod-engine.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function makeEngine(config = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'zalo-mod-test-'));
    const engine = createZaloModEngine({ dataDir: dir, logger: quiet, config });
    return {
        engine,
        dir,
        cleanup: () => { engine.shutdown(); rmSync(dir, { recursive: true, force: true }); },
    };
}

test('capture → openTurn → injectContext: prompt nhận đúng UNTRUSTED block', (t) => {
    const { engine, cleanup } = makeEngine();
    t.after(cleanup);
    const base = { accountId: 'acc1', conversationId: 'group:1', groupId: '1' };
    engine.captureInbound({ ...base, messageId: 'm1', senderId: 'uid-A', senderName: 'A', text: 'abc' });
    engine.captureInbound({ ...base, messageId: 'm2', senderId: 'uid-A', senderName: 'A', text: 'xyz' });
    engine.captureInbound({ ...base, messageId: 'm3', senderId: 'uid-B', senderName: 'B', text: 'use option 2' });
    engine.captureInbound({ ...base, messageId: 'm4', senderId: 'uid-A', senderName: 'A', text: '@Bot what should we do?' });
    engine.openTurn({ ...base, messageId: 'm4', senderId: 'uid-A', senderName: 'A' });

    const event = { prompt: 'câu hỏi gốc' };
    const turn = engine.injectContext(event, { accountId: 'acc1', conversationId: 'group:1', sessionKey: 's1' });
    assert.equal(turn.senderId, 'uid-A');
    assert.ok(event.prompt.includes('[UNTRUSTED RECENT GROUP CONTEXT]'));
    assert.ok(event.prompt.includes('abc'));
    assert.ok(event.prompt.includes('use option 2'));
    assert.ok(event.prompt.endsWith('câu hỏi gốc'));
    // không inject 2 lần
    const before = event.prompt;
    engine.openTurn({ ...base, messageId: 'm5', senderId: 'uid-A', senderName: 'A' });
    engine.injectContext(event, { accountId: 'acc1', conversationId: 'group:1' });
    assert.equal((event.prompt.match(/\[UNTRUSTED RECENT GROUP CONTEXT\]/g) || []).length,
        (before.match(/\[UNTRUSTED RECENT GROUP CONTEXT\]/g) || []).length);
});

test('FIFO correlation: A rồi B mention — turn consume đúng thứ tự, không cross', (t) => {
    const { engine, cleanup } = makeEngine();
    t.after(cleanup);
    const base = { accountId: 'acc1', conversationId: 'group:1', groupId: '1' };
    engine.captureInbound({ ...base, messageId: 'a1', senderId: 'uid-A', senderName: 'A', text: '@Bot câu của A' });
    engine.openTurn({ ...base, messageId: 'a1', senderId: 'uid-A', senderName: 'A' });
    engine.captureInbound({ ...base, messageId: 'b1', senderId: 'uid-B', senderName: 'B', text: '@Bot câu của B' });
    engine.openTurn({ ...base, messageId: 'b1', senderId: 'uid-B', senderName: 'B' });

    const ev1 = { prompt: 'p1' };
    const t1 = engine.injectContext(ev1, { accountId: 'acc1', conversationId: 'group:1', sessionKey: 'sess-1' });
    const ev2 = { prompt: 'p2' };
    const t2 = engine.injectContext(ev2, { accountId: 'acc1', conversationId: 'group:1', sessionKey: 'sess-2' });
    assert.equal(t1.senderId, 'uid-A', 'turn 1 phải là A (FIFO)');
    assert.equal(t2.senderId, 'uid-B', 'turn 2 phải là B');

    const done1 = engine.completeTurn({ accountId: 'acc1', conversationId: 'group:1', sessionKey: 'sess-1', replyText: 'trả lời A' });
    assert.equal(done1.senderId, 'uid-A');
    const done2 = engine.completeTurn({ accountId: 'acc1', conversationId: 'group:1', sessionKey: 'sess-2' });
    assert.equal(done2.senderId, 'uid-B');
});

test('fallback không có turn (before_dispatch không fire): inject theo ctx.senderId', (t) => {
    const { engine, cleanup } = makeEngine();
    t.after(cleanup);
    const base = { accountId: 'acc1', conversationId: 'group:9', groupId: '9' };
    engine.captureInbound({ ...base, messageId: 'h1', senderId: 'uid-A', senderName: 'A', text: 'ngữ cảnh cũ' });
    const event = { prompt: 'hỏi' };
    engine.injectContext(event, { accountId: 'acc1', conversationId: 'group:9', senderId: 'uid-A' });
    assert.ok(event.prompt.includes('ngữ cảnh cũ'));
});

test('không có gì để inject → prompt giữ nguyên', (t) => {
    const { engine, cleanup } = makeEngine();
    t.after(cleanup);
    const event = { prompt: 'nguyên bản' };
    engine.injectContext(event, { accountId: 'a', conversationId: 'group:2', senderId: 'u' });
    assert.equal(event.prompt, 'nguyên bản');
});

test('owner-claim code: đúng code mới claim được, one-time, sai code fail', (t) => {
    const { engine, cleanup } = makeEngine();
    t.after(cleanup);
    const { code, expiresAt } = engine.getOwnerClaimCode();
    assert.match(code, /^[0-9A-F]{8}$/);
    assert.ok(expiresAt > Date.now());
    // lấy lại → cùng code (chưa hết hạn)
    assert.equal(engine.getOwnerClaimCode().code, code);
    assert.equal(engine.verifyOwnerClaimCode('SAI-CODE'), false);
    assert.equal(engine.verifyOwnerClaimCode(code.toLowerCase()), true, 'case-insensitive');
    // one-time: dùng rồi là hết
    assert.equal(engine.verifyOwnerClaimCode(code), false);
    // code mới phải khác
    assert.notEqual(engine.getOwnerClaimCode().code, code);
});

test('captureBotReply cắt context tại reply của bot', (t) => {
    const { engine, cleanup } = makeEngine();
    t.after(cleanup);
    const base = { accountId: 'a', conversationId: 'group:3', groupId: '3' };
    engine.captureInbound({ ...base, messageId: 'm1', senderId: 'u1', senderName: 'U', text: 'chuyện cũ' });
    engine.captureBotReply('a', 'group:3', 'bot đã chốt');
    engine.captureInbound({ ...base, messageId: 'm2', senderId: 'u1', senderName: 'U', text: 'chuyện mới' });
    const event = { prompt: 'x' };
    engine.injectContext(event, { accountId: 'a', conversationId: 'group:3', senderId: 'u1' });
    assert.ok(event.prompt.includes('chuyện mới'));
    assert.ok(!event.prompt.includes('chuyện cũ'), 'tin trước bot reply phải bị cắt');
});

test('turn bị bỏ rơi (TTL sweep) không gán nhầm trigger-sender cho lượt sau', (t) => {
    const { engine, cleanup } = makeEngine();
    t.after(cleanup);
    const base = { accountId: 'acc1', conversationId: 'group:7', groupId: '7' };
    engine.captureInbound({ ...base, messageId: 'ha', senderId: 'uid-A', senderName: 'A', text: 'tin của A' });
    const abandoned = engine.openTurn({ ...base, messageId: 'ha', senderId: 'uid-A', senderName: 'A' });
    // Giả lập LLM lỗi: turn không bao giờ complete, bị sweep khỏi store.
    engine.turnStore.complete(abandoned.turnId);
    engine.turnStore.sweep(Date.now() + 60 * 60 * 1000);

    // B mention sau đó — correlation phải ra B, không dính entry chết của A.
    engine.captureInbound({ ...base, messageId: 'hb', senderId: 'uid-B', senderName: 'B', text: '@Bot câu của B' });
    engine.openTurn({ ...base, messageId: 'hb', senderId: 'uid-B', senderName: 'B' });
    const event = { prompt: 'x' };
    const turn = engine.injectContext(event, { accountId: 'acc1', conversationId: 'group:7' });
    assert.equal(turn.senderId, 'uid-B');
});

test('health() trả snapshot', (t) => {
    const { engine, cleanup } = makeEngine();
    t.after(cleanup);
    const h = engine.health();
    assert.equal(h.storage, 'sqlite');
    assert.equal(typeof h.bufferConversations, 'number');
});

test('persist SQLite: message ghi xuống DB thật trong dataDir', (t) => {
    const { engine, dir, cleanup } = makeEngine();
    t.after(cleanup);
    engine.captureInbound({
        accountId: 'a', conversationId: 'group:5', groupId: '5',
        messageId: 'm1', senderId: 'u', senderName: 'U', text: 'persisted',
    });
    const rows = engine.storage.recentMessages('a|group:5', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, 'persisted');
});
