import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releasePreviousEngine } from '../src/integration/zalo-mod-engine.js';

// vps_thuy-le 03/11/2026: OpenClaw 2026.9.8 nạp zalo-mod thành hai module trong cùng tiến trình. Lần
// đăng ký thứ hai đóng DB của engine thứ nhất, nên tool chat-messages của agent đầu báo
// "statement has been finalized". Import cùng tệp với query khác cho ra một module mới, đúng như vậy.
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

async function loadEngineModule(tag) {
    return import(`../src/integration/zalo-mod-engine.js?module=${tag}`);
}

test('hai module song song: engine của module đầu vẫn đọc được DB sau khi module sau đăng ký', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zalo-mod-two-'));
    const modA = await loadEngineModule('a');
    const modB = await loadEngineModule('b');

    const first = modA.createZaloModEngine({ dataDir: dir, logger: quiet });
    first.storage.listConversations();
    const second = modB.createZaloModEngine({ dataDir: dir, logger: quiet });
    assert.notEqual(first, second);
    assert.notEqual(first.codeId, second.codeId);

    assert.equal(modB.releasePreviousEngine(first, second), 'retired');
    // recentMessages dùng câu lệnh chuẩn bị sẵn: DB bị đóng thì đây chính là chỗ nổ
    // "statement has been finalized" như trên máy khách.
    assert.doesNotThrow(() => first.storage.recentMessages('default|group:1', 200));
    assert.doesNotThrow(() => first.storage.listConversations());
    assert.doesNotThrow(() => second.storage.recentMessages('default|group:1', 200));

    first.shutdown();
    second.shutdown();
    rmSync(dir, { recursive: true, force: true });
});

test('cùng một engine thì không làm gì', () => {
    let calls = 0;
    const engine = { codeId: Symbol('x'), retire: () => { calls += 1; }, shutdown: () => { calls += 1; } };
    assert.equal(releasePreviousEngine(engine, engine), 'same');
    assert.equal(releasePreviousEngine(undefined, engine), 'same');
    assert.equal(calls, 0);
});

test('engine khác cùng bản mã (khác thư mục dữ liệu) vẫn bị tắt hẳn như trước', () => {
    const code = Symbol('cung-ban-ma');
    let shut = 0;
    let retired = 0;
    const prev = { codeId: code, retire: () => { retired += 1; }, shutdown: () => { shut += 1; } };
    const next = { codeId: code };
    assert.equal(releasePreviousEngine(prev, next), 'shutdown');
    assert.equal(shut, 1);
    assert.equal(retired, 0);
});

test('engine đời cũ không có codeId cũng không bị đóng DB', () => {
    let shut = 0;
    const ancient = { shutdown: () => { shut += 1; } };
    assert.equal(releasePreviousEngine(ancient, { codeId: Symbol('moi') }), 'retired');
    assert.equal(shut, 0);
});

test('index.js dùng releasePreviousEngine, không còn gọi thẳng shutdown() engine trước', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(src, /releasePreviousEngine\(globalThis\.__zaloModEngine, zEngine\)/);
    assert.doesNotMatch(src, /globalThis\.__zaloModEngine\.shutdown/);
});
