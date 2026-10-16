import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { leaveGroupVerified, isStillGroupMember, dropProfileFromGroup } from '../src/integration/leave-group.js';

// Bối cảnh (vps_thuy-le 16/10/2026): owner bấm Rời nhóm cho bot Em Mơ, Zalo trả "Không đủ quyền."
// nhưng bot đã rời thật. Dashboard báo lỗi và vẫn hiện nhóm tới lần sync sau.

const parseProfiles = (s) => String(s ?? 'default').split(',').map(x => x.trim()).filter(Boolean);
const GID = '8719637058580372432';

function fakeApi({ leaveError = null, allGroupIds = [], infoName = '' , allGroupsThrows = false } = {}) {
    const calls = [];
    return {
        calls,
        async leaveGroup(gid, silent) {
            calls.push(['leaveGroup', gid, silent]);
            if (leaveError) throw new Error(leaveError);
            return { ok: 1 };
        },
        async getAllGroups() {
            calls.push(['getAllGroups']);
            if (allGroupsThrows) throw new Error('network');
            return { gridVerMap: Object.fromEntries(allGroupIds.map(id => [id, '1'])) };
        },
        async getGroupInfo(gid) {
            calls.push(['getGroupInfo', gid]);
            return { gridInfoMap: infoName ? { [gid]: { name: infoName } } : {} };
        },
    };
}

test('rời bình thường thì trả kết quả của Zalo, không hỏi lại', async () => {
    const api = fakeApi();
    assert.deepEqual(await leaveGroupVerified(api, GID, true), { ok: 1 });
    assert.deepEqual(api.calls, [['leaveGroup', GID, true]]);
});

test('Zalo báo lỗi nhưng bot đã không còn trong nhóm => coi là đã rời', async () => {
    const api = fakeApi({ leaveError: 'Không đủ quyền.', allGroupIds: [] });
    const res = await leaveGroupVerified(api, GID, true);
    assert.equal(res.ok, true);
    assert.equal(res.alreadyLeft, true);
    assert.equal(res.zaloError, 'Không đủ quyền.');
});

test('getAllGroups còn ID "ma" nhưng getGroupInfo không có tên => vẫn là đã rời', async () => {
    const api = fakeApi({ leaveError: 'Không đủ quyền.', allGroupIds: [GID], infoName: '' });
    assert.equal(await isStillGroupMember(api, GID), false);
    assert.equal((await leaveGroupVerified(api, GID)).alreadyLeft, true);
});

test('Zalo báo lỗi và bot vẫn còn trong nhóm => giữ lỗi gốc', async () => {
    const api = fakeApi({ leaveError: 'Không đủ quyền.', allGroupIds: [GID], infoName: 'Nhà 3' });
    await assert.rejects(leaveGroupVerified(api, GID), /Không đủ quyền/);
});

test('không hỏi lại được Zalo => giữ lỗi gốc, không đoán là đã rời', async () => {
    const api = fakeApi({ leaveError: 'Không đủ quyền.', allGroupsThrows: true });
    assert.equal(await isStillGroupMember(api, GID), null);
    await assert.rejects(leaveGroupVerified(api, GID), /Không đủ quyền/);
});

test('gỡ nhóm chỉ có một bot => xoá hẳn bản ghi', () => {
    const names = { [GID]: { name: 'Nhà 3', profile: 'default' }, other: { name: 'X', profile: 'default' } };
    assert.equal(dropProfileFromGroup(names, GID, 'default', parseProfiles), 'deleted');
    assert.equal(names[GID], undefined);
    assert.ok(names.other);
});

test('nhóm còn bot khác => chỉ bỏ profile vừa rời, giữ các trường khác', () => {
    const names = { [GID]: { name: 'Nhà 3', profile: 'default,trolylinhthinhvuong', inviteLink: 'https://zalo.me/g/x' } };
    assert.equal(dropProfileFromGroup(names, GID, 'default', parseProfiles), 'updated');
    assert.deepEqual(names[GID], { name: 'Nhà 3', profile: 'trolylinhthinhvuong', inviteLink: 'https://zalo.me/g/x' });
});

test('bot không có trong bản ghi nhóm, hoặc không có nhóm => không đụng gì', () => {
    const names = { [GID]: { name: 'Nhà 3', profile: 'trolylinhthinhvuong' } };
    assert.equal(dropProfileFromGroup(names, GID, 'default', parseProfiles), 'absent');
    assert.equal(dropProfileFromGroup(names, 'missing', 'default', parseProfiles), 'absent');
    assert.equal(names[GID].profile, 'trolylinhthinhvuong');
});

test('bản ghi đời cũ dạng chuỗi tên vẫn gỡ được', () => {
    const names = { [GID]: 'Nhà 3' };
    assert.equal(dropProfileFromGroup(names, GID, 'default', parseProfiles), 'deleted');
    assert.equal(names[GID], undefined);
});

test('index.js nối action leave-group vào bản có kiểm lại và gỡ nhóm khỏi state', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const block = source.match(/if \(action === 'leave-group'\) \{[\s\S]*?return res;\s*\}/);
    assert.ok(block, 'không tìm thấy khối leave-group');
    assert.match(block[0], /leaveGroupVerified\(zaloApi, groupId/);
    assert.match(block[0], /dropProfileFromGroup\(groupNames, groupId, targetProfile/);
    assert.match(block[0], /watchGroupIds\.splice/);
    assert.match(block[0], /saveGroupNames\(onDisk\)/);
    assert.doesNotMatch(source, /if \(action === 'leave-group'\) return await zaloApi\.leaveGroup/);
});
