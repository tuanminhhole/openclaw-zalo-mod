import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZcaFacade } from '../src/integration/zca-facade.js';

/**
 * Bridge giả: nhận { action, ... } trả kết quả tool zalo-connect đã bọc như
 * openclaw-adapter (read action → { ok, raw }).
 */
function makeBridge(handlers) {
    return {
        async execute(profile, action) {
            const h = handlers[action.action];
            if (!h) throw new Error(`no handler for ${action.action}`);
            const data = await h(action, profile);
            return { ok: true, raw: data };
        },
    };
}

function withService(fn) {
    globalThis.__zaloConnectBridgeService = {};
    return Promise.resolve(fn()).finally(() => { delete globalThis.__zaloConnectBridgeService; });
}

test('serviceAvailable phản ánh globalThis.__zaloConnectBridgeService', () => {
    const f = createZcaFacade({ getBridge: () => makeBridge({}) });
    assert.equal(f.serviceAvailable(), false);
    globalThis.__zaloConnectBridgeService = {};
    assert.equal(f.serviceAvailable(), true);
    delete globalThis.__zaloConnectBridgeService;
});

test('withZaloApi ném lỗi khi chưa có service (call-site degrade như cũ)', async () => {
    const f = createZcaFacade({ getBridge: () => makeBridge({}) });
    await assert.rejects(f.withZaloApi('default', async () => 'x'), /chưa expose/);
});

test('fetchAccountInfo dựng lại shape { profile } từ tool me', async () => {
    const bridge = makeBridge({
        me: () => ({ userId: 'bot1', displayName: 'Minh Khang', avatar: 'http://a/1.jpg' }),
    });
    const f = createZcaFacade({ getBridge: () => bridge });
    await withService(async () => {
        const acc = await f.withZaloApi('default', (api) => api.fetchAccountInfo());
        assert.equal(acc.profile.userId, 'bot1');
        assert.equal(acc.profile.avatar, 'http://a/1.jpg');
    });
});

test('getOwnId trả userId (async, caller await được)', async () => {
    const bridge = makeBridge({ me: () => ({ userId: 'bot1' }) });
    const f = createZcaFacade({ getBridge: () => bridge });
    await withService(async () => {
        const id = await f.withZaloApi('default', (api) => api.getOwnId());
        assert.equal(id, 'bot1');
    });
});

test('getGroupInfo (đơn + mảng) dựng lại gridInfoMap giữ creatorId/adminIds/totalMember', async () => {
    const bridge = makeBridge({
        'get-group-info': (a) => ({
            groupId: a.groupId, name: `G${a.groupId}`, totalMember: 42,
            creatorId: 'owner-x', adminIds: ['ad1'], memberIds: ['m1', 'm2'],
        }),
    });
    const f = createZcaFacade({ getBridge: () => bridge });
    await withService(async () => {
        const single = await f.withZaloApi('default', (api) => api.getGroupInfo('g1'));
        const info = single.gridInfoMap['g1'];
        assert.equal(info.creatorId, 'owner-x');
        assert.deepEqual(info.adminIds, ['ad1']);
        assert.equal(info.totalMember, 42);
        assert.deepEqual(info.memVerList, ['m1', 'm2']);
        const multi = await f.withZaloApi('default', (api) => api.getGroupInfo(['g1', 'g2']));
        assert.deepEqual(Object.keys(multi.gridInfoMap).sort(), ['g1', 'g2']);
    });
});

test('getAllGroups dựng gridVerMap + gridInfoMap từ tool groups', async () => {
    const bridge = makeBridge({
        groups: () => ({ groups: [{ groupId: 'g1', name: 'A' }, { groupId: 'g2', name: 'B' }], count: 2 }),
    });
    const f = createZcaFacade({ getBridge: () => bridge });
    await withService(async () => {
        const r = await f.withZaloApi('default', (api) => api.getAllGroups());
        assert.deepEqual(Object.keys(r.gridVerMap).sort(), ['g1', 'g2']);
        assert.equal(r.gridInfoMap['g1'].name, 'A');
    });
});

test('getUserInfo: đơn trả object merge, mảng trả list (collectProfileNames đọc được)', async () => {
    const bridge = makeBridge({
        'get-user-info': (a) => ({ userId: a.userId, info: { displayName: `U${a.userId}`, avatar: 'x' } }),
    });
    const f = createZcaFacade({ getBridge: () => bridge });
    await withService(async () => {
        const one = await f.withZaloApi('default', (api) => api.getUserInfo('u1'));
        assert.equal(one.userId, 'u1');
        assert.equal(one.displayName, 'Uu1');
        const many = await f.withZaloApi('default', (api) => api.getUserInfo(['u1', 'u2']));
        assert.equal(many.length, 2);
        assert.equal(many[1].userId, 'u2');
    });
});

test('getGroupMembers map profiles → mảng {userId, displayName}', async () => {
    const bridge = makeBridge({
        'get-group-members-info': () => ({ result: { profiles: {
            'u1': { userId: 'u1', zaloName: 'An', avatar: 'a1' },
            'u2': { displayName: 'Bình' },
        }, unchangeds_profile: [] } }),
    });
    const f = createZcaFacade({ getBridge: () => bridge });
    await withService(async () => {
        const members = await f.withZaloApi('default', (api) => api.getGroupMembers('g1'));
        assert.equal(members.length, 2);
        assert.equal(members.find(m => m.userId === 'u1').displayName, 'An');
        assert.equal(members.find(m => m.userId === 'u2').displayName, 'Bình');
    });
});

test('getAllFriends trả mảng friends', async () => {
    const bridge = makeBridge({
        friends: () => ({ friends: [{ userId: 'f1', displayName: 'Bạn 1' }], count: 1 }),
    });
    const f = createZcaFacade({ getBridge: () => bridge });
    await withService(async () => {
        const fr = await f.withZaloApi('default', (api) => api.getAllFriends());
        assert.equal(fr[0].userId, 'f1');
    });
});

test('compatModule.listZaloGroupMembers → mảng member từ get-group-members-info', async () => {
    const bridge = makeBridge({
        'get-group-members-info': () => ({ result: { profiles: { 'u1': { userId: 'u1', displayName: 'An' } } } }),
    });
    const f = createZcaFacade({ getBridge: () => bridge });
    await withService(async () => {
        const members = await f.compatModule.listZaloGroupMembers('default', 'g1');
        assert.equal(members[0].displayName, 'An');
    });
});
