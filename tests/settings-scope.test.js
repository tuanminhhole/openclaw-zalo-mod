import assert from 'node:assert/strict';
import test from 'node:test';

import { createZaloModAgentTools, currentGroupFromSession, pickSettingTargets } from '../src/agent/tool-surface.js';

// Máy khách 03/11/2026: owner bảo "đừng thả tim trong các nhóm nữa", nói trong nhóm thì phải áp cho đúng
// nhóm đó, nói ở tin riêng thì theo tên nhóm owner nêu, "tất cả" thì mọi nhóm của chính bot nhận lệnh.
const OWNER = '111';
const GROUPS = [
    { groupId: 'g-kd-a', name: 'Kinh Doanh', profile: 'default' },
    { groupId: 'g-kd-b', name: 'Kinh Doanh', profile: 'bot2' },
    { groupId: 'g-kt', name: 'Kỹ Thuật', profile: 'default' },
    { groupId: 'g-sk', name: 'Sống Khoẻ', profile: 'bot2' },
];
const GROUP_SESSION = 'agent:em-mo:zalo-connect:group:g-kt';
const DM_SESSION = 'agent:em-mo:zalo-connect:direct:111';

function makeHost() {
    const calls = [];
    const host = {
        listGroups: async () => GROUPS.map((g) => ({ ...g })),
        getGroupState: (id) => ({ ...(GROUPS.find((g) => g.groupId === id) || { groupId: id, name: id }) }),
        runAction: async (action, payload) => {
            calls.push({ action, payload });
            const ids = payload.groupIds || [payload.groupId];
            return { key: payload.key, value: !!payload.value, count: ids.length };
        },
        getOwnerIds: () => new Set([OWNER]),
        isDestructiveAllowed: () => false,
        audit: async () => {},
        logger: { warn() {}, info() {} },
        vnDateStr: () => '2026-11-03',
    };
    return { host, calls };
}
const settingsTool = (host, ctx) => createZaloModAgentTools(host)({ requesterSenderId: OWNER, ...ctx })
    .find((t) => t.name === 'zalo_mod_settings');
const parse = (r) => JSON.parse(r.content[0].text);

test('đọc groupId của nhóm đang chat từ sessionKey; tin riêng thì rỗng', () => {
    assert.equal(currentGroupFromSession(GROUP_SESSION), 'g-kt');
    assert.equal(currentGroupFromSession('agent:em-mo:zalo-connect:group:4319405915607263779'), '4319405915607263779');
    assert.equal(currentGroupFromSession(DM_SESSION), '');
    assert.equal(currentGroupFromSession(undefined), '');
});

test('nhắn trong nhóm, không nêu nhóm khác: áp đúng nhóm đang chat', async () => {
    for (const groups of [undefined, [], ['nhóm này'], ['Nhom nay']]) {
        const { host, calls } = makeHost();
        const res = parse(await settingsTool(host, { sessionKey: GROUP_SESSION, agentAccountId: 'default' })
            .execute('c1', { groups, key: 'reaction', value: false }));
        assert.equal(res.ok, true, JSON.stringify(groups));
        assert.equal(res.scope, 'current');
        assert.deepEqual(calls[0].payload, { groupId: 'g-kt', key: 'reaction', value: false });
    }
});

test('nhắn trong nhóm nhưng nêu thêm nhóm khác: áp cả nhóm đang chat lẫn nhóm được nêu', () => {
    const r = pickSettingTargets({ groups: ['nhóm này', 'Kinh Doanh'], turn: { sessionKey: GROUP_SESSION, accountId: 'default' }, all: GROUPS });
    assert.deepEqual(new Set(r.matched), new Set(['g-kd-a', 'g-kd-b', 'g-kt']));
});

test('nhắn trong nhóm và chỉ nêu nhóm khác: chỉ áp nhóm được nêu', () => {
    const r = pickSettingTargets({ groups: ['Kinh Doanh'], turn: { sessionKey: GROUP_SESSION, accountId: 'default' }, all: GROUPS });
    assert.deepEqual(new Set(r.matched), new Set(['g-kd-a', 'g-kd-b']));
    assert.equal(r.scope, 'named');
});

test('nhắn riêng mà không nêu nhóm: báo lỗi để bot hỏi lại, không đổi gì', async () => {
    const { host, calls } = makeHost();
    const res = parse(await settingsTool(host, { sessionKey: DM_SESSION, agentAccountId: 'default' })
        .execute('c1', { key: 'reaction', value: false }));
    assert.equal(res.ok, false);
    assert.match(res.error, /nhắn riêng/);
    assert.equal(calls.length, 0);
});

test('nhắn riêng nêu tên nhóm: áp theo tên, mọi bot trong nhóm đó', async () => {
    const { host, calls } = makeHost();
    const res = parse(await settingsTool(host, { sessionKey: DM_SESSION, agentAccountId: 'default' })
        .execute('c1', { groups: ['kinh doanh'], key: 'reaction', value: false }));
    assert.equal(res.ok, true);
    assert.equal(calls[0].payload.groupId, 'g-kd-a');
    assert.equal(calls[0].payload.profile, undefined, 'không profile = mọi bot trong nhóm');
});

test('"tất cả" = mọi nhóm của chính bot nhận lệnh, không đụng bot khác', async () => {
    const { host, calls } = makeHost();
    const res = parse(await settingsTool(host, { sessionKey: DM_SESSION, agentAccountId: 'default' })
        .execute('c1', { groups: ['tất cả'], key: 'reaction', value: false }));
    assert.equal(res.ok, true);
    assert.equal(res.scope, 'all-of-bot');
    assert.deepEqual(new Set(calls[0].payload.groupIds), new Set(['g-kd-a', 'g-kt']));
    assert.equal(calls[0].payload.profile, 'default', 'ghi riêng cho bot này, không lan sang id của bot khác');
});

test('"tất cả" kèm profile bot khác hoặc "all": theo đúng lời owner', () => {
    const other = pickSettingTargets({ groups: ['all'], profile: 'bot2', turn: { accountId: 'default' }, all: GROUPS });
    assert.deepEqual(new Set(other.matched), new Set(['g-kd-b', 'g-sk']));
    assert.equal(other.profile, 'bot2');
    const every = pickSettingTargets({ groups: ['tat ca'], profile: 'all', turn: { accountId: 'default' }, all: GROUPS });
    assert.equal(every.matched.length, GROUPS.length);
    assert.equal(every.profile, undefined);
});

test('"tất cả" mà không biết bot nào nhận lệnh và có nhiều bot: hỏi lại', () => {
    const r = pickSettingTargets({ groups: ['all'], turn: {}, all: GROUPS });
    assert.match(r.error, /bot nào/);
});

test('nhóm đang chat chưa được Zalo Mod quản lý: báo lỗi thay vì áp nhầm', () => {
    const r = pickSettingTargets({ groups: [], turn: { sessionKey: 'agent:x:zalo-connect:group:la-hoac' }, all: GROUPS });
    assert.match(r.error, /chưa nằm trong danh sách/);
});
