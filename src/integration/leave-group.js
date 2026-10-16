// Rời nhóm từ dashboard.
//
// Ghi nhận trên vps_thuy-le 16/10/2026: owner bấm Rời nhóm, Zalo trả "Không đủ quyền." nhưng bot đã rời
// thật (lần đồng bộ sau không còn nhóm đó). Chỉ có MỘT request, không retry, nên lỗi là của server Zalo.
// Dashboard báo lỗi và vẫn để nhóm nằm trong danh sách, owner không biết đã rời được hay chưa.
//
// Hai việc ở đây:
// 1. leaveGroupVerified: leaveGroup ném lỗi thì hỏi lại Zalo xem bot còn trong nhóm không. Không còn
//    thì coi là thành công. Còn, hoặc không hỏi được, thì giữ lỗi gốc - không đoán bừa là đã rời.
// 2. dropProfileFromGroup: gỡ bot vừa rời khỏi bản ghi nhóm. Nhóm còn bot khác thì chỉ bỏ profile
//    này, không còn bot nào thì xoá hẳn - đúng luật của sync-groups.

function groupIdsFromAllGroups(all) {
    return new Set([
        ...Object.keys(all?.gridVerMap || {}),
        ...Object.keys(all?.gridInfoMap || {}),
    ].map(String));
}

/**
 * Bot còn là thành viên nhóm không. Trả true/false, hoặc null khi không hỏi được Zalo.
 *
 * getAllGroups có thể còn trả ID "ma" của nhóm đã rời, nên nhóm chỉ được tính là còn khi getGroupInfo
 * trả được tên - cùng bằng chứng mà sync-groups dùng để gắn bot vào nhóm.
 */
export async function isStillGroupMember(zaloApi, groupId) {
    const gid = String(groupId);
    try {
        if (typeof zaloApi.getAllGroups === 'function') {
            const ids = groupIdsFromAllGroups(await zaloApi.getAllGroups());
            if (!ids.has(gid)) return false;
        }
        if (typeof zaloApi.getGroupInfo !== 'function') return null;
        const info = await zaloApi.getGroupInfo(gid);
        const entry = info?.gridInfoMap?.[gid];
        return Boolean(entry && entry.name);
    } catch {
        return null;
    }
}

export async function leaveGroupVerified(zaloApi, groupId, silent = false) {
    try {
        return await zaloApi.leaveGroup(groupId, silent);
    } catch (err) {
        const still = await isStillGroupMember(zaloApi, groupId);
        if (still === false) {
            return { ok: true, alreadyLeft: true, zaloError: String(err?.message || err) };
        }
        throw err;
    }
}

/**
 * Gỡ `profile` khỏi bản ghi nhóm trong `groupNames` (sửa tại chỗ).
 * Trả 'deleted' khi nhóm không còn bot nào, 'updated' khi còn bot khác, 'absent' khi không có gì để gỡ.
 */
export function dropProfileFromGroup(groupNames, groupId, profile, parseProfiles) {
    const gid = String(groupId);
    let entry = groupNames[gid];
    if (!entry) return 'absent';
    // group-names.json đời cũ lưu thẳng chuỗi tên, không có profile => thuộc bot 'default'.
    if (typeof entry !== 'object') entry = groupNames[gid] = { name: String(entry), profile: 'default' };
    const profs = parseProfiles(entry.profile);
    if (!profs.includes(profile)) return 'absent';
    const remaining = profs.filter(p => p !== profile);
    if (remaining.length === 0) {
        delete groupNames[gid];
        return 'deleted';
    }
    entry.profile = remaining.join(',');
    return 'updated';
}
