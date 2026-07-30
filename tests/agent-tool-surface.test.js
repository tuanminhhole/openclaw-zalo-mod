import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AGENT_DESTRUCTIVE_ACTIONS,
    AGENT_FORBIDDEN_ACTIONS,
    ZALO_MOD_TOOL_NAMES,
    classifyAction,
    collectOwnerIds,
    createZaloModAgentTools,
    foldGroupName,
    isOwnerRequester,
    resolveGroupTargets,
} from '../src/agent/tool-surface.js';

const OWNER = '111';
const MEMBER = '222';

const GROUPS = [
    // Cùng một nhóm vật lý "Kinh Doanh" nhưng 2 groupId — mỗi bot một id per-account.
    { groupId: 'g-kd-a', name: 'Kinh Doanh', profile: 'default', muted: false, silent: true, follow: true },
    { groupId: 'g-kd-b', name: 'Kinh Doanh', profile: 'bot2', muted: false, silent: true, follow: true },
    { groupId: 'g-kt', name: 'Kỹ Thuật', profile: 'default', muted: false, silent: true, follow: false },
    { groupId: 'g-hc', name: 'Hành Chính', profile: 'default', muted: true, silent: true, follow: true },
];

function makeHost(overrides = {}) {
    const state = new Map(GROUPS.map((g) => [g.groupId, { ...g }]));
    const calls = [];
    const host = {
        listGroups: async () => [...state.values()],
        getGroupState: (id) => ({ ...(state.get(id) || { groupId: id, name: id }) }),
        runAction: async (action, payload) => {
            calls.push({ action, payload });
            if (action === 'toggle-setting' || action === 'bulk-toggle-setting') {
                // Giả lập fan-out sibling của host: cùng tên nhóm = cùng nhóm vật lý.
                const seeds = payload.groupIds || [payload.groupId];
                const names = new Set(seeds.map((id) => (state.get(id) || {}).name));
                const targets = [...state.values()].filter((g) => names.has(g.name)).map((g) => g.groupId);
                for (const id of targets) state.get(id)[payload.key] = !!payload.value;
                return { key: payload.key, value: !!payload.value, count: targets.length };
            }
            return { echoed: payload };
        },
        readHistory: async (id) => (id === 'g-kd-a'
            ? [{ t: '09:00', name: 'An', text: 'chốt đơn 5 thùng', links: [] }]
            : []),
        listHistoryDates: async () => ['2026-07-27'],
        getNotes: async () => [],
        getGroupMemories: async () => [],
        getSummary: async () => null,
        generateSummary: async () => ({ sections: { overview: 'ok' } }),
        vnDateStr: () => '2026-07-27',
        getOwnerIds: () => new Set([OWNER]),
        isDestructiveAllowed: () => false,
        audit: async () => {},
        listCommands: () => [{ command: '/bot-menu', description: 'Menu' }],
        logger: { warn() {}, info() {} },
        ...overrides,
    };
    return { host, calls, state };
}

function parse(result) {
    return JSON.parse(result.content[0].text);
}

test('collectOwnerIds gom ownerId gốc + ownerId từng bot profile', () => {
    const ids = collectOwnerIds({ ownerId: 'a', bots: { default: { ownerId: 'a' }, bot2: { ownerId: 'b' }, bot3: {} } });
    assert.deepEqual([...ids].sort(), ['a', 'b']);
});

test('isOwnerRequester từ chối sender rỗng (lượt cron/heartbeat không có người gửi)', () => {
    assert.equal(isOwnerRequester(OWNER, new Set([OWNER])), true);
    assert.equal(isOwnerRequester(MEMBER, new Set([OWNER])), false);
    assert.equal(isOwnerRequester('', new Set([OWNER])), false);
    assert.equal(isOwnerRequester(undefined, new Set([OWNER])), false);
});

test('member thường không thấy tool nào — tool biến mất khỏi prompt', () => {
    const { host } = makeHost();
    const factory = createZaloModAgentTools(host);
    assert.deepEqual(factory({ requesterSenderId: MEMBER }), []);
    assert.deepEqual(factory({}), []);
    assert.deepEqual(factory({ requesterSenderId: OWNER }).map((t) => t.name), [...ZALO_MOD_TOOL_NAMES]);
});

test('execute kiểm tra owner LẦN 2 với danh sách đọc live — owner bị gỡ thì tool ngừng ghi', async () => {
    let owners = new Set([OWNER]);
    const { host, calls } = makeHost({ getOwnerIds: () => owners });
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const settings = tools.find((t) => t.name === 'zalo_mod_settings');

    owners = new Set(['someone-else']); // owner đổi sau khi tool đã dựng
    const res = parse(await settings.execute('c1', { groups: ['Kinh Doanh'], key: 'muted', value: true }));
    assert.equal(res.ok, false);
    assert.match(res.error, /Chỉ owner/);
    assert.equal(calls.length, 0, 'không được ghi gì khi guard chặn');
});

test('foldGroupName bỏ dấu để owner gõ tên nhóm kiểu nào cũng khớp', () => {
    assert.equal(foldGroupName('Kỹ Thuật'), 'ky thuat');
    assert.equal(foldGroupName('  KINH-DOANH  '), 'kinh doanh');
    assert.equal(foldGroupName(null), '');
});

test('resolveGroupTargets: tên có dấu, không dấu, groupId, và "all"', () => {
    assert.deepEqual(resolveGroupTargets(['ky thuat'], GROUPS).matched, ['g-kt']);
    assert.deepEqual(resolveGroupTargets(['Kỹ Thuật'], GROUPS).matched, ['g-kt']);
    assert.deepEqual(resolveGroupTargets(['g-hc'], GROUPS).matched, ['g-hc']);
    assert.deepEqual(resolveGroupTargets(['group:g-hc'], GROUPS).matched, ['g-hc']);
    assert.equal(resolveGroupTargets(['all'], GROUPS).matched.length, GROUPS.length);
});

test('resolveGroupTargets: cùng tên trên nhiều bot → gom hết id, KHÔNG coi là nhập nhằng', () => {
    const res = resolveGroupTargets(['Kinh Doanh'], GROUPS);
    assert.deepEqual(res.matched.sort(), ['g-kd-a', 'g-kd-b']);
    assert.deepEqual(res.ambiguous, []);
});

test('resolveGroupTargets: khớp nhiều TÊN khác nhau → ambiguous để bot hỏi lại, không đoán', () => {
    const res = resolveGroupTargets(['h'], [
        { groupId: '1', name: 'Hành Chính' },
        { groupId: '2', name: 'Hậu Cần' },
    ]);
    assert.deepEqual(res.matched, []);
    assert.equal(res.ambiguous.length, 1);
    assert.deepEqual(res.ambiguous[0].candidates.sort(), ['Hành Chính', 'Hậu Cần']);
});

test('resolveGroupTargets: không khớp gì → unresolved', () => {
    const res = resolveGroupTargets(['Nhóm Không Tồn Tại'], GROUPS);
    assert.deepEqual(res.matched, []);
    assert.deepEqual(res.unresolved, ['Nhóm Không Tồn Tại']);
});

test('zalo_mod_settings: nhiều nhóm → bulk-toggle-setting, trả state ĐỌC LẠI', async () => {
    const { host, calls, state } = makeHost();
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const settings = tools.find((t) => t.name === 'zalo_mod_settings');

    const res = parse(await settings.execute('c1', { groups: ['Kinh Doanh', 'Kỹ Thuật'], key: 'muted', value: true }));
    assert.equal(res.ok, true);
    assert.equal(calls[0].action, 'bulk-toggle-setting');
    assert.deepEqual(calls[0].payload.groupIds.sort(), ['g-kd-a', 'g-kd-b', 'g-kt']);
    assert.equal(calls[0].payload.profile, undefined, 'không truyền profile = áp cho mọi bot trong nhóm');
    // Giá trị báo về phải là state thật sau khi ghi, không phải ý định.
    assert.ok(res.groups.every((g) => g.muted === true));
    assert.equal(state.get('g-kd-b').muted, true, 'bot thứ 2 cùng nhóm cũng phải đổi — nếu không badge UI sẽ lệch');
});

test('zalo_mod_settings: MỘT nhóm → toggle-setting (bulk-* luôn đòi PRO dù chỉ 1 nhóm)', async () => {
    const { host, calls } = makeHost();
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const settings = tools.find((t) => t.name === 'zalo_mod_settings');

    const res = parse(await settings.execute('c1', { groups: ['Kỹ Thuật'], key: 'muted', value: true }));
    assert.equal(res.ok, true);
    assert.equal(calls[0].action, 'toggle-setting', 'gói FREE bấm badge được thì nhờ bot cũng phải được');
    assert.equal(calls[0].payload.groupId, 'g-kt');
    assert.equal(calls[0].payload.groupIds, undefined);
});

test('zalo_mod_settings: một nhóm nhưng nhiều groupId (đa bot) vẫn là MỘT nhóm → toggle-setting', async () => {
    const { host, calls } = makeHost();
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const res = parse(await tools.find((t) => t.name === 'zalo_mod_settings').execute('c1', { groups: ['Kinh Doanh'], key: 'follow', value: true }));
    assert.equal(res.ok, true);
    assert.equal(calls[0].action, 'toggle-setting');
    // Không truyền profile → host tự fan-out sang mọi sibling id.
    assert.ok(['g-kd-a', 'g-kd-b'].includes(calls[0].payload.groupId));
    assert.equal(calls[0].payload.profile, undefined);
});

test('zalo_mod_settings: nhập nhằng thì KHÔNG ghi gì, trả về để bot hỏi lại', async () => {
    const ambiguousGroups = [{ groupId: '1', name: 'Hành Chính' }, { groupId: '2', name: 'Hậu Cần' }];
    const { host, calls } = makeHost({
        listGroups: async () => ambiguousGroups,
        getGroupState: (id) => ambiguousGroups.find((g) => g.groupId === id),
    });
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const res = parse(await tools.find((t) => t.name === 'zalo_mod_settings').execute('c1', { groups: ['h'], key: 'muted', value: true }));
    assert.equal(res.ok, false);
    assert.equal(res.ambiguous.length, 1);
    assert.equal(calls.length, 0);
});

test('zalo_mod_settings: lỗi license nổi lên nguyên văn kèm gợi ý — bot không được báo thành công', async () => {
    const { host } = makeHost({
        runAction: async () => {
            const e = new Error('Thao tác hàng loạt/nhiều group chỉ dành cho gói PRO hoặc TEAM.');
            e.code = 'PRO_REQUIRED';
            throw e;
        },
    });
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const result = await tools.find((t) => t.name === 'zalo_mod_settings').execute('c1', { groups: ['all'], key: 'muted', value: true });
    assert.equal(result.content[0].isError, true);
    const res = parse(result);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'PRO_REQUIRED');
    assert.match(res.hint, /giới hạn gói license/);
});

test('zalo_mod_history: nhóm chưa bật follow → cảnh báo không có dữ liệu thay vì bịa', async () => {
    const { host } = makeHost();
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const res = parse(await tools.find((t) => t.name === 'zalo_mod_history').execute('c1', { groups: ['Kỹ Thuật'] }));
    assert.equal(res.ok, true);
    const entry = res.groups[0];
    assert.equal(entry.followEnabled, false);
    assert.match(entry.warning, /chưa bật follow/);
    assert.equal(entry.days[0].messageCount, 0);
});

test('zalo_mod_history: gộp nhiều groupId cùng tên, lấy id nào thật có lịch sử', async () => {
    const { host } = makeHost();
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const res = parse(await tools.find((t) => t.name === 'zalo_mod_history').execute('c1', { groups: ['Kinh Doanh'] }));
    const entry = res.groups[0];
    assert.deepEqual(entry.groupIds.sort(), ['g-kd-a', 'g-kd-b']);
    assert.equal(entry.days[0].messageCount, 1);
    assert.equal(entry.days[0].messages[0].text, 'chốt đơn 5 thùng');
});

test('zalo_mod_history: days=3 trả đúng 3 ngày lùi dần theo giờ VN', async () => {
    const { host } = makeHost();
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const res = parse(await tools.find((t) => t.name === 'zalo_mod_history').execute('c1', { groups: ['Kinh Doanh'], date: '2026-07-27', days: 3 }));
    assert.deepEqual(res.dates, ['2026-07-27', '2026-07-26', '2026-07-25']);
});

test('classifyAction: chặn cứng tiền/license/permission, chặn mềm nhóm phá hoại', () => {
    assert.equal(classifyAction('sync-groups').allowed, true);
    for (const action of AGENT_FORBIDDEN_ACTIONS) {
        const v = classifyAction(action, { allowDestructive: true });
        assert.equal(v.allowed, false, `${action} phải bị chặn kể cả khi bật allowDestructive`);
    }
    for (const action of AGENT_DESTRUCTIVE_ACTIONS) {
        assert.equal(classifyAction(action).allowed, false, `${action} mặc định phải bị chặn`);
        assert.equal(classifyAction(action, { allowDestructive: true }).allowed, true);
    }
    assert.equal(classifyAction('rm -rf').allowed, false);
    assert.equal(classifyAction('').allowed, false);
});

test('zalo_mod_action: list-actions phản ánh đúng cờ allowDestructive', async () => {
    const { host } = makeHost({ isDestructiveAllowed: () => true });
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const res = parse(await tools.find((t) => t.name === 'zalo_mod_action').execute('c1', { action: 'list-actions' }));
    assert.equal(res.destructiveEnabled, true);
    assert.ok(res.forbidden.includes('activate-license'));
});

test('zalo_mod_action: action ngoài allowlist bị từ chối trước khi chạm dispatcher', async () => {
    const { host, calls } = makeHost();
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const res = parse(await tools.find((t) => t.name === 'zalo_mod_action').execute('c1', { action: 'activate-license', payload: { key: 'x' } }));
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
});

test('mọi tool đều có parameters là JSON Schema object hợp lệ (host không cần typebox)', () => {
    const { host } = makeHost();
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    assert.equal(tools.length, ZALO_MOD_TOOL_NAMES.length);
    for (const tool of tools) {
        assert.equal(typeof tool.description, 'string');
        assert.ok(tool.description.length > 40, `${tool.name} cần description đủ để model biết khi nào dùng`);
        assert.equal(tool.parameters.type, 'object');
        assert.equal(typeof tool.parameters.properties, 'object');
        assert.equal(typeof tool.execute, 'function');
    }
});

// Mô tả tool LUÔN nằm trong prompt; SKILL.md thì model phải chủ động mở mới đọc. Bug thật: owner nhờ
// đổi giờ lịch hai lần, model không mở skill nên không biết `report-job-save` tồn tại — chỉ gọi action
// ĐỌC rồi báo "đã đổi xong". Vì vậy action GHI của những việc hay được nhờ phải có tên ngay trong mô tả.
test('mô tả zalo_mod_action nêu tên action GHI, không để trong skill', () => {
    const { host } = makeHost();
    const tools = createZaloModAgentTools(host)({ requesterSenderId: OWNER });
    const action = tools.find((t) => t.name === 'zalo_mod_action');
    assert.ok(action, 'phải có tool zalo_mod_action');
    for (const needle of ['report-job-save', 'save-templates', 'get-templates', 'zalo-api']) {
        assert.ok(action.description.includes(needle), `mô tả phải nêu ${needle}`);
    }
    assert.match(action.description, /chỉ cần id \+ field muốn đổi/, 'phải nói rõ là sửa được một phần');
    assert.match(action.description, /SAU KHI action GHI trả về ok/, 'phải có luật chống báo khống ngay trong mô tả');
});
