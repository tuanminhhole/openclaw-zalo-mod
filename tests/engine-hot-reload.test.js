import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createZaloModEngine } from '../src/integration/zalo-mod-engine.js';

// vps_asa 16/10/2026: thay nóng zalo-mod 2.29.0 -> 2.32.3, log báo "dùng lại engine sẵn có" và bản mới
// chạy nguyên engine của bản cũ (adapter chưa biết bám bridge). Khung chat câm từ 14/10.
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const KEY = '__openclawZaloModEngines';

test('đăng ký lại trong CÙNG bản mã thì dùng lại engine (không mở thêm SQLite)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zalo-mod-hot-'));
    const a = createZaloModEngine({ dataDir: dir, logger: quiet });
    const b = createZaloModEngine({ dataDir: dir, logger: quiet });
    assert.equal(a, b);
    a.shutdown();
    rmSync(dir, { recursive: true, force: true });
});

test('engine của bản mã cũ nằm trong cache thì bị thay, và được cho nghỉ việc nền', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zalo-mod-hot-'));
    let retired = 0;
    const oldEngine = { codeId: Symbol('ban-cu'), retire: () => { retired += 1; } };
    const cache = globalThis[KEY] || (globalThis[KEY] = new Map());
    cache.set(dir, oldEngine);

    const fresh = createZaloModEngine({ dataDir: dir, logger: quiet });
    assert.notEqual(fresh, oldEngine);
    assert.equal(retired, 1);
    assert.equal(cache.get(dir), fresh);
    assert.equal(createZaloModEngine({ dataDir: dir, logger: quiet }), fresh);
    fresh.shutdown();
    rmSync(dir, { recursive: true, force: true });
});

test('engine đời rất cũ (không có codeId, không có retire) cũng bị thay mà không nổ', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zalo-mod-hot-'));
    const ancient = { health: () => ({}) };
    (globalThis[KEY] || (globalThis[KEY] = new Map())).set(dir, ancient);
    const fresh = createZaloModEngine({ dataDir: dir, logger: quiet });
    assert.notEqual(fresh, ancient);
    assert.equal(typeof fresh.captureInbound, 'function');
    fresh.shutdown();
    rmSync(dir, { recursive: true, force: true });
});
