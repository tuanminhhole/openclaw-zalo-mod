import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const source = readFileSync(new URL('index.js', root), 'utf8');

// Bối cảnh (02/09/2026, vps_c-thu chạy openclaw 2026.8.1): schema mới CẤM agents.list trong
// file — doctor dời hết sang agents.entries (object theo id). Plugin chỗ nào còn đọc .list
// là trên 2026.8 tưởng project không có agent: workspace resolve sai, binding không tự gắn.

function extract(name) {
    const m = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(m, `không tìm thấy function ${name}`);
    return new Function(`${m[0]}; return ${name};`)();
}
const agentListFromConfig = extract('agentListFromConfig');

test('agentListFromConfig đọc được cả hai dạng list và entries', () => {
    // Dạng cũ (≤2026.7): list là nguồn.
    assert.deepEqual(
        agentListFromConfig({ agents: { list: [{ id: 'a', workspace: 'w' }] } }),
        [{ id: 'a', workspace: 'w' }],
    );
    // Dạng mới (2026.8): entries keyed theo id — đúng hình dạng đo trên vps_c-thu.
    const out = agentListFromConfig({ agents: { entries: { 'tro-ly': { name: 'Trợ Lý', workspace: 'ws' } } } });
    assert.deepEqual(out, [{ id: 'tro-ly', name: 'Trợ Lý', workspace: 'ws' }]);
    // list rỗng + entries có → entries thắng (doctor để lại list [] trước khi xoá hẳn).
    assert.equal(agentListFromConfig({ agents: { list: [], entries: { x: {} } } })[0].id, 'x');
    // Không có gì → mảng rỗng, không nổ.
    assert.deepEqual(agentListFromConfig({}), []);
    assert.deepEqual(agentListFromConfig(null), []);
});

test('KHÔNG còn chỗ nào đọc agents.list trực tiếp ngoài helper', () => {
    const code = source.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    const direct = code.match(/agents\??\.list/g) || [];
    // Cho phép đúng các lần xuất hiện bên trong agentListFromConfig (ag.list không match
    // pattern này) — mọi reader phải đi qua helper.
    assert.equal(direct.length, 0, `còn ${direct.length} chỗ đọc agents.list trực tiếp: phải dùng agentListFromConfig`);
});

test('bootstrap hướng dẫn tool vào TOOLS.md: có marker idempotent và chạy lúc init', () => {
    // Model yếu chối "em không có công cụ" dù tool luôn đăng ký — guidance phải nằm trong
    // TOOLS.md của MỌI workspace, ghi một lần theo marker.
    assert.match(source, /const TOOLS_GUIDE_MARKER = /, 'thiếu marker');
    assert.match(source, /cur\.includes\(TOOLS_GUIDE_MARKER\)\) continue;/, 'thiếu chốt idempotent — mỗi boot sẽ append thêm một bản');
    assert.match(source, /bootstrapToolsGuide\(\)\.catch\(/, 'bootstrap phải chạy lúc init và không được chặn boot khi lỗi');
    assert.match(source, /zalo_mod_action[\s\S]{0,200}sync-groups/, 'guidance phải dạy đúng lệnh sync-groups');
});
