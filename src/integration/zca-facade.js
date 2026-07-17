/**
 * ZCA facade — cho phép mọi call-site cũ của zalo-mod (vốn gọi zca-js thô qua
 * globalThis.__zcaApiByProfile) chạy qua ZaloConnectBridge mà KHÔNG phải sửa từng chỗ.
 *
 * Hai điểm vào giữ nguyên chữ ký như code cũ:
 *   - withZaloApi(profile, op => op(zaloApi))   ← thay getSafeZaloApi()
 *   - compatModule.listZaloGroupMembers
 *                                                ← thay resolveZaloApiModule()
 *
 * Mỗi method dựng lại đúng shape zca-js thô mà caller đọc (gridInfoMap,
 * {profile}, mảng member...) từ output đã chuẩn hoá của tool zalo-connect.
 *
 * Tool zalo-connect (149 action) trả JSON chuẩn hoá; bảng dịch shape ở đây là
 * chỗ DUY NHẤT phải sửa nếu upstream đổi format.
 */

export function createZcaFacade({ getBridge, logger } = {}) {
    const log = logger || console;

    // Chỉ đọc được (me/groups/get-*) khi có bridge service thật của zalo-connect.
    // Không có → trả "không khả dụng" để call-site degrade như hành vi cũ.
    function serviceAvailable() {
        return !!globalThis.__zaloConnectBridgeService;
    }

    async function exec(profile, action) {
        const bridge = getBridge?.();
        if (!bridge) throw new Error('ZaloConnect bridge chưa sẵn sàng');
        const res = await bridge.execute(profile || 'default', action);
        // bridge.execute (adapter) bọc kết quả tool vào { ok, messageId, raw }.
        return res && typeof res === 'object' && 'raw' in res ? res.raw : res;
    }

    /** Object mô phỏng API zca-js cho một profile. */
    function makeZaloApi(profile) {
        return {
            // Bot profile: zca thô trả { profile: {...} }
            async fetchAccountInfo() {
                const me = await exec(profile, { action: 'me' });
                return { profile: me || {} };
            },
            // zca thô: string uid (được caller await)
            async getOwnId() {
                const me = await exec(profile, { action: 'me' });
                return me?.userId || '';
            },
            /**
             * zca thô getUserInfo(id) trả object profile lồng; getUserInfo([ids])
             * trả tập profile. Caller dùng qua extractAvatar / collectProfileNames
             * (walker nhận mọi shape có {id,name}), nên trả merge {userId, ...info}.
             */
            async getUserInfo(idOrArray) {
                const ids = Array.isArray(idOrArray) ? idOrArray : [idOrArray];
                const out = [];
                for (const id of ids) {
                    try {
                        const r = await exec(profile, { action: 'get-user-info', userId: String(id) });
                        const info = r?.info || r;
                        if (info) out.push({ userId: r?.userId || id, ...info });
                    } catch (e) { /* bỏ id lỗi, tiếp tục */ }
                }
                return Array.isArray(idOrArray) ? out : (out[0] || null);
            },
            /**
             * zca thô getGroupInfo(id | [ids]) trả { gridInfoMap: { [id]: {...} } }.
             * Tool get-group-info nhận 1 id, trả phẳng → loop dựng lại gridInfoMap.
             */
            async getGroupInfo(idOrArray) {
                const ids = Array.isArray(idOrArray) ? idOrArray : [idOrArray];
                const gridInfoMap = {};
                for (const id of ids) {
                    try {
                        const g = await exec(profile, { action: 'get-group-info', groupId: String(id) });
                        if (g) {
                            gridInfoMap[String(id)] = {
                                name: g.name,
                                desc: g.desc,
                                totalMember: g.totalMember,
                                creatorId: g.creatorId,
                                adminIds: g.adminIds,
                                memberIds: g.memberIds,
                                memVerList: g.memberIds, // extractMemberIds đọc field này
                            };
                        }
                    } catch (e) { /* group lỗi/không phải thành viên → bỏ */ }
                }
                return { gridInfoMap };
            },
            // zca thô: { gridVerMap, gridInfoMap }
            async getAllGroups() {
                const r = await exec(profile, { action: 'groups' });
                const gridVerMap = {};
                const gridInfoMap = {};
                for (const g of (r?.groups || [])) {
                    if (!g?.groupId) continue;
                    gridVerMap[g.groupId] = 1;
                    gridInfoMap[g.groupId] = {
                        name: g.name, desc: g.desc,
                        totalMember: g.totalMember, creatorId: g.creatorId,
                    };
                }
                return { gridVerMap, gridInfoMap };
            },
            // Pending: caller đọc qua pendingListFromResult (chịu nhiều shape)
            async getPendingGroupMembers(gid) {
                const r = await exec(profile, { action: 'get-pending-members', groupId: String(gid) });
                return r?.result ?? r;
            },
            /**
             * Tool không có "profiles theo mảng id" → resolve từng id qua get-user-info.
             * Dùng cho danh sách nhỏ (pending). Danh sách lớn (scan group) dùng
             * getGroupMembers(groupId) một phát bên dưới.
             */
            async getGroupMembersInfo(ids) {
                return this.getUserInfo(Array.isArray(ids) ? ids : [ids]);
            },
            /** Lấy toàn bộ member 1 nhóm trong 1 call (get-group-members-info theo groupId). */
            async getGroupMembers(groupId) {
                const r = await exec(profile, { action: 'get-group-members-info', groupId: String(groupId) });
                const profiles = r?.result?.profiles || r?.profiles || {};
                return Object.entries(profiles).map(([uid, p]) => ({
                    userId: p?.userId || uid,
                    displayName: p?.displayName || p?.zaloName || p?.dName || '',
                    zaloName: p?.zaloName,
                    avatar: p?.avatar,
                }));
            },
            async getAllFriends() {
                const r = await exec(profile, { action: 'friends' });
                return r?.friends || [];
            },
        };
    }

    async function withZaloApi(profile, operation) {
        if (!serviceAvailable()) {
            throw new Error('ZaloConnect bridge service chưa expose — không có API instance');
        }
        return operation(makeZaloApi(profile));
    }

    // Adapter mỏng cho member watcher hiện tại.
    const compatModule = {
        async listZaloGroupMembers(profile, groupId) {
            return makeZaloApi(profile).getGroupMembers(groupId);
        },
    };

    return { withZaloApi, compatModule, serviceAvailable, makeZaloApi };
}
