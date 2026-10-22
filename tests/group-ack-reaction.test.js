import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createZaloConnectBridge } from '../src/integration/zalo-connect-bridge.js';
import { MockZaloConnectAdapter } from './helpers/mock-zalo-connect.js';
import { TOGGLE_KEYS, TOGGLE_LABELS, TOGGLE_ALIASES, RULES_PANEL_SECTIONS } from '../src/agent/commands.js';

// Bối cảnh (vps_asa 22/10/2026): owner muốn bật/tắt việc bot tự thả cảm xúc theo TỪNG nhóm, trong khi
// OpenClaw chỉ có một khoá chung messages.ackReaction. zalo-mod lưu lựa chọn theo nhóm và đẩy xuống
// zalo-connect (bridge v7) qua setGroupAckReaction.

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../dashboard.js', import.meta.url), 'utf8');
const toolSurface = readFileSync(new URL('../src/agent/tool-surface.js', import.meta.url), 'utf8');

test('reaction là toggle chung của slash, dashboard và agent tool', () => {
    assert.ok(TOGGLE_KEYS.includes('reaction'));
    assert.match(TOGGLE_LABELS.reaction, /Thả tim/);
    assert.equal(TOGGLE_ALIASES['tha tim'], 'reaction');
    assert.equal(TOGGLE_ALIASES.reaction, 'reaction');
    assert.ok(RULES_PANEL_SECTIONS.some((s) => s.key === 'reaction'), 'panel /rules có mục thả tim');
    assert.match(toolSurface, /enum: \[[^\]]*'reaction'\]/, 'zalo_mod_settings nhận key reaction');
});

test('bridge chuyển setGroupAckReaction xuống adapter', async () => {
    const adapter = new MockZaloConnectAdapter();
    const calls = [];
    adapter.setGroupAckReaction = async (accountId, groupId, enabled) => { calls.push([accountId, groupId, enabled]); return enabled; };
    const bridge = createZaloConnectBridge(adapter);
    assert.equal(await bridge.setGroupAckReaction('default', 123, false), false);
    assert.deepEqual(calls, [['default', '123', false]]);
});

test('zalo-connect cũ chưa có hàm thì báo lỗi rõ, không im lặng', async () => {
    const bridge = createZaloConnectBridge(new MockZaloConnectAdapter());
    await assert.rejects(() => bridge.setGroupAckReaction('default', '1', true), /bridge v7/);
});

test('đồng bộ runtime: chỉ đẩy khi owner đã đặt riêng, và áp khi đổi toggle reaction', () => {
    assert.match(source, /const reaction = store\.getSetting\(groupId, 'reaction', undefined\);\s*\n\s*if \(typeof reaction === 'boolean'\)/,
        'nhóm chưa đặt riêng thì để zalo-connect theo cài đặt chung');
    assert.match(source, /if \(typeof bridge\.setGroupAckReaction === 'function'\)/, 'zalo-connect cũ không có hàm thì bỏ qua êm');
    assert.match(source, /cleanKey === 'muted' \|\| cleanKey === 'silent' \|\| cleanKey === 'reaction'\)\s*\n\s*\? await syncZaloConnectRuntimePolicies/,
        'bật/tắt reaction đẩy ngay xuống zalo-connect');
    // Phát lại khi gateway khởi động đi qua cùng hàm sync (live group policy replayed).
    assert.match(source, /async function syncZaloConnectRuntimePolicies[\s\S]{0,1600}setGroupAckReaction\(accountId, groupId, reaction\)/);
});

test('lệnh /rules reaction có list, all và theo groupId', () => {
    assert.match(source, /if \(sub === 'reaction-list'\)/);
    assert.match(source, /if \(sub === 'reaction' && args\[1\]\)/);
    assert.match(source, /applyToggleSetting\(\{ groupIds: ids, key: 'reaction', value: val \}\)/);
});

test('cài đặt chung: chỉ coi là bật trong nhóm khi có emoji và scope phủ nhóm', () => {
    const m = source.match(/\nfunction isGlobalGroupAckReactionOn\(\) \{[\s\S]*?\n\}\n/);
    assert.ok(m, 'có hàm isGlobalGroupAckReactionOn');
    const run = (cfg) => new Function('readFileSync', 'getOpenclawJsonPath', `${m[0]}; return isGlobalGroupAckReactionOn();`)(
        () => JSON.stringify(cfg), () => '/x/openclaw.json');
    assert.equal(run({ messages: { ackReaction: '/-heart' } }), true, 'mặc định scope group-mentions là có thả trong nhóm');
    assert.equal(run({ messages: { ackReaction: '/-heart', ackReactionScope: 'all' } }), true);
    assert.equal(run({ messages: { ackReaction: '/-heart', ackReactionScope: 'dm-only' } }), false);
    assert.equal(run({ messages: { ackReaction: '/-heart', ackReactionScope: 'off' } }), false);
    assert.equal(run({ messages: {} }), false, 'đã xoá ackReaction (như vps_asa) thì là tắt');
    assert.equal(run({}), false);
    assert.match(source, /ackReactionGlobal: isGlobalGroupAckReactionOn\(\),/, 'trả cho dashboard trong /api/state');
});

test('dashboard: nút Thả tim hiện theo cài đặt chung khi nhóm chưa đặt riêng', () => {
    const m = dashboard.match(/\nfunction toggleOn\(settings, key\) \{[\s\S]*?\n\}\n/);
    assert.ok(m, 'có hàm toggleOn');
    const on = (settings, key, globalOn) => new Function('state', `${m[0]}; return toggleOn;`)({ ackReactionGlobal: globalOn })(settings, key);
    assert.equal(on({}, 'reaction', true), true);
    assert.equal(on({}, 'reaction', false), false);
    assert.equal(on({ reaction: false }, 'reaction', true), false, 'tắt riêng thắng cài đặt chung');
    assert.equal(on({ reaction: true }, 'reaction', false), true, 'bật riêng thắng cài đặt chung');
    assert.equal(on({}, 'welcome', true), false, 'toggle khác giữ nguyên mặc định tắt');
    assert.equal((dashboard.match(/\['reaction', uiText\('Thả tim', 'Reaction'\)\]/g) || []).length, 2, 'có ở bật hàng loạt và chi tiết nhóm');
    assert.match(dashboard, /featureToggle\(group, 'reaction', uiText\('Thả tim', 'Reaction'\)\)/, 'có ở danh sách nhóm');
});

test('state gửi dashboard phải mang reaction đã đặt riêng (vps_asa 22/10: nút hiện tắt trong khi bot vẫn thả)', () => {
    const blocks = source.match(/autoSummary: settings\.autoSummary === true,\s*\n\s*\/\/[^\n]*\n\s*\.\.\.\(typeof settings\.reaction === 'boolean' \? \{ reaction: settings\.reaction \} : \{\}\),/g) || [];
    assert.equal(blocks.length, 2, 'cả danh sách nhóm lẫn chi tiết nhóm');
    assert.match(source, /reaction: \(\(\) => \{ const r = store\.getSetting\(plain, 'reaction', undefined\); return typeof r === 'boolean' \? r : isGlobalGroupAckReactionOn\(\); \}\)\(\),/,
        'trạng thái nhóm cho bot là giá trị hiệu lực');
});
