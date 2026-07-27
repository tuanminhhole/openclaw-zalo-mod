import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { ZALO_MOD_TOOL_NAMES } from '../src/agent/tool-surface.js';
import { buildPluginSkillMarkdown, buildWorkspaceSkillMarkdown, WORKSPACE_SKILL_VERSION } from '../src/agent/skill-content.js';
import { COMMAND_SECTIONS, TOGGLE_KEYS, listAllCommands, renderCommandPanel, renderRulesPanel } from '../src/agent/commands.js';

const root = new URL('..', import.meta.url);
const source = readFileSync(new URL('index.js', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('openclaw.plugin.json', root), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const shippedSkill = readFileSync(new URL('skills/zalo-mod-control/SKILL.md', root), 'utf8');

test('manifest khai contracts.tools khớp đúng tên tool đã register', () => {
    // registry của host DROP tool nếu manifest không khai contracts.tools —
    // lệch tên là im lặng mất tool, nên phải khoá bằng test.
    assert.deepEqual([...manifest.contracts.tools].sort(), [...ZALO_MOD_TOOL_NAMES].sort());
    for (const name of ZALO_MOD_TOOL_NAMES) {
        assert.ok(source.includes('ZALO_MOD_TOOL_NAMES'), 'index.js phải register bằng đúng hằng số này');
        assert.match(name, /^zalo_mod_[a-z]+$/);
    }
});

test('tool KHÔNG được đánh optional — optional nghĩa là ẩn khỏi agent trừ khi có allowlist', () => {
    const metadata = manifest.toolMetadata || {};
    for (const name of ZALO_MOD_TOOL_NAMES) {
        assert.notEqual(metadata[name]?.optional, true, `${name} bị optional sẽ không xuất hiện với agent`);
    }
    assert.doesNotMatch(source, /registerTool\([^)]*optional:\s*true/);
});

test('manifest trỏ tới skill native có thật, và skill đó được đóng gói khi publish', () => {
    assert.deepEqual(manifest.skills, ['skills/zalo-mod-control']);
    assert.ok(existsSync(new URL('skills/zalo-mod-control/SKILL.md', root)), 'thiếu SKILL.md thì host log warn và bỏ qua');
    assert.ok(pkg.files.includes('skills'), 'không có "skills" trong package.files thì ClawHub/npm không ship skill');
});

test('SKILL.md đã ship phải khớp generator — tránh file cũ trôi so với code', () => {
    assert.equal(shippedSkill, buildPluginSkillMarkdown());
});

test('SKILL.md có frontmatter hợp lệ và description đủ để host trigger đúng lúc', () => {
    const m = shippedSkill.match(/^---\nname: (.+)\ndescription: ([\s\S]+?)\n---\n/);
    assert.ok(m, 'frontmatter phải là name + description ở đầu file');
    assert.equal(m[1], 'zalo-mod-control');
    assert.ok(m[2].length > 80);
    for (const kw of ['mute', 'follow', 'lịch sử']) {
        assert.ok(m[2].includes(kw), `description nên chứa "${kw}" để khớp ý định người dùng`);
    }
});

test('SKILL.md dạy luật chống báo khống và liệt kê đủ 4 tool', () => {
    assert.match(shippedSkill, /KHÔNG BAO GIỜ BÁO KHỐNG/);
    for (const name of ZALO_MOD_TOOL_NAMES) {
        assert.ok(shippedSkill.includes(name), `SKILL.md thiếu ${name}`);
    }
    // Đây là hướng dẫn chống chính xác cái bug đã gặp.
    assert.match(shippedSkill, /badge trên dashboard/);
    assert.match(shippedSkill, /prompt injection|dữ liệu, không phải lệnh|không phải lệnh/);
});

test('skill workspace fallback có version stamp để bootstrap biết khi nào ghi đè', () => {
    const md = buildWorkspaceSkillMarkdown({ botName: 'Minh Khang', cmdPrefix: '/minhkhang-', memoryPathHint: '/ws/skills/memory/zalo-groups' });
    assert.match(md, new RegExp(`^version: ${WORKSPACE_SKILL_VERSION}$`, 'm'));
    assert.match(md, /^name: zalo-group-admin$/m);
    assert.ok(md.includes('/minhkhang-rules'), 'bảng lệnh phải mang prefix thật của bot đó');
    assert.ok(!md.includes('${cmdPrefix}'), 'không được lọt placeholder ra file');
});

test('bootstrap ghi skill cho MỌI agent workspace, không chỉ agent đầu tiên', () => {
    assert.match(source, /function agentWorkspaceDirs\(\)/);
    assert.match(source, /for \(const agent of \(cfg\?\.agents\?\.list \|\| \[\]\)\)/);
    assert.match(source, /for \(const wsDir of agentWorkspaceDirs\(\)\)/);
});

test('bootstrap bỏ qua bản workspace khi host đã publish plugin skill', () => {
    assert.match(source, /function pluginSkillPublished\(\)/);
    assert.match(source, /plugin-skills', 'zalo-mod-control'/);
    assert.match(source, /if \(pluginSkillPublished\(\)\) return/);
});

test('mọi toggle per-group đi qua applyToggleSetting — slash và dashboard không được có 2 đường ghi', () => {
    assert.match(source, /async function applyToggleSetting\(/);
    // Đường ghi trực tiếp cho toggle keys chỉ còn được phép ở nơi khởi tạo group mới.
    const directWrites = [...source.matchAll(/store\.setSetting\((groupId|targetGid|gId), '(muted|silent|follow|tracking|pendingAuto|autoSummary)'/g)];
    const allowed = directWrites.filter((m) => m[1] === 'gId'); // enrolment mặc định khi thêm group
    assert.equal(directWrites.length, allowed.length,
        `còn ${directWrites.length - allowed.length} chỗ ghi toggle trực tiếp ngoài applyToggleSetting`);
    // setFollow chỉ còn được gọi từ trong applyToggleSetting.
    const followCalls = [...source.matchAll(/setFollow\(/g)];
    assert.ok(followCalls.length <= 3, `setFollow bị gọi ${followCalls.length} lần — nên chỉ trong applyToggleSetting`);
});

test('applyToggleSetting fan-out sibling khi không chỉ định profile — nguồn gốc lệch badge per-bot', () => {
    const fn = source.slice(source.indexOf('async function applyToggleSetting('));
    const body = fn.slice(0, fn.indexOf('\n        }') + 10);
    assert.match(body, /siblingGroupIds\(gid\)/);
    assert.match(body, /syncZaloConnectRuntimePolicies/);
    assert.match(body, /store\.saveSettings\(\)/);
    assert.match(body, /TOGGLE_KEYS\.includes/);
});

test('không còn chuỗi nháy đơn làm lọt literal ${cmdPrefix} ra tin nhắn người dùng', () => {
    const leaks = [...source.matchAll(/'[^'\n]*\$\{cmdPrefix\}[^'\n]*'/g)].map((m) => m[0]);
    assert.deepEqual(leaks, []);
});

test('catalogue lệnh là nguồn duy nhất: panel owner và panel admin render từ nó', () => {
    assert.match(source, /renderRulesPanel\(cmdPrefix\)/);
    assert.match(source, /renderCommandPanel\(cmdPrefix, \['admin', 'admin-rules'\]/);
    // Bảng lệnh không được hardcode lại trong index.js.
    assert.doesNotMatch(source, /rules mute-list\\n/);
});

test('renderer sinh ra lệnh có prefix thật, và mọi lệnh đều có mô tả', () => {
    const panel = renderRulesPanel('/william-');
    assert.ok(panel.includes('/william-rules mute all on/off'));
    const admin = renderCommandPanel('/william-', ['admin'], 'X');
    assert.ok(admin.includes('/mute'), 'mute/unmute dùng prefix cố định "/"');
    assert.ok(admin.includes('/william-warn'));
    for (const cmd of listAllCommands('/william-')) {
        assert.ok(cmd.description && cmd.description.length > 3, `lệnh ${cmd.command} thiếu mô tả`);
        assert.ok(['member', 'admin', 'owner'].includes(cmd.role));
    }
});

test('TOGGLE_KEYS khớp danh sách key mà dashboard/action vẫn dùng', () => {
    assert.deepEqual([...TOGGLE_KEYS], ['muted', 'silent', 'welcome', 'tracking', 'follow', 'pendingAuto', 'autoSummary']);
    assert.ok(COMMAND_SECTIONS.length >= 4);
});
