/**
 * Agent tool surface — cho LLM tay chân thật để điều khiển Zalo Mod.
 *
 * Bối cảnh: trước đây zalo-mod chỉ có 3 mặt tiền đổi state (slash command
 * zero-token, dashboard HTTP, timer nội bộ) và LLM KHÔNG nằm trong số đó. Khi
 * owner nhắn "mute nhóm A, nhóm B" bằng ngôn ngữ tự nhiên, tin đó lọt lên LLM,
 * LLM không có tool nào nên trả lời nghe-hợp-lý ("đã mute rồi") mà không có gì
 * ghi settings.json → badge dashboard đứng nguyên. File này là actuator còn
 * thiếu đó.
 *
 * Mọi write đi qua ĐÚNG dispatcher mà nút dashboard bấm vào
 * (`runDashboardAction`) nên licensing/audit/fan-out per-bot không thể lệch.
 *
 * BẢO MẬT — tool này bị kích hoạt bởi tin nhắn của BẤT KỲ ai trong nhóm:
 *  - Chỉ owner dùng được. `requesterSenderId` do host cấp từ inbound context
 *    (SDK ghi rõ "runtime-provided, not tool args") — KHÔNG BAO GIỜ nhận
 *    senderId từ params của model.
 *  - Chặn 2 lớp: factory không trả tool nào cho người không phải owner (tool
 *    biến mất khỏi prompt), và execute kiểm tra lại lần nữa với danh sách owner
 *    đọc live từ config.
 *  - Nhóm action tiền/license/permission bị chặn cứng; nhóm phá hoại
 *    (kick/block/leave) mặc định TẮT, bật bằng config.
 */

/** Tên 4 tool — phải khớp `contracts.tools` trong openclaw.plugin.json. */
export const ZALO_MOD_TOOL_NAMES = Object.freeze([
    'zalo_mod_groups',
    'zalo_mod_settings',
    'zalo_mod_history',
    'zalo_mod_action',
]);

/**
 * Action của `runDashboardAction` mà agent được phép gọi qua `zalo_mod_action`.
 * Chỉ đọc + tác vụ vận hành thường ngày.
 */
export const AGENT_SAFE_ACTIONS = Object.freeze([
    'get-group-info', 'get-user-info', 'get-friends', 'get-pending', 'get-blocked',
    'get-permissions', 'get-name-triggers', 'group-detail', 'journal-data',
    'scan-members', 'sync-groups', 'generate-summary', 'send-message',
    'toggle-setting', 'bulk-toggle-setting', 'save-report-schedule',
    'toggle-custom-mode', 'upsert-custom-mode', 'delete-custom-mode',
    'set-name-triggers', 'save-templates',
]);

/**
 * Action phá hoại / không thể hoàn tác. Mặc định TẮT với agent; bật bằng
 * `agentTools.allowDestructive: true` trong plugin config.
 */
export const AGENT_DESTRUCTIVE_ACTIONS = Object.freeze([
    'remove-user', 'block-member', 'unblock-member', 'leave-group',
    'send-friend-request', 'accept-friend', 'reject-friend', 'review-pending',
    'send-messages', 'bulk-friend-request',
]);

/**
 * Không bao giờ cho agent chạm: tiền, license, và quyền truy cập. Những thứ này
 * chỉ đổi được từ dashboard (token-gated) hoặc lệnh owner tường minh.
 */
export const AGENT_FORBIDDEN_ACTIONS = Object.freeze([
    'create-payment', 'check-payment-status', 'cancel-payment',
    'activate-license', 'refresh-license', 'save-permissions',
]);

const MAX_HISTORY_MESSAGES = 400;
const MAX_HISTORY_GROUPS = 10;
const MAX_TEXT_LEN = 500;

/** Bỏ dấu + hạ chữ + gom khoảng trắng — so khớp tên nhóm người dùng gõ. */
export function foldGroupName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function toolText(payload, isError = false) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text', text, ...(isError ? { isError: true } : {}) }], details: payload };
}

function ok(payload) { return toolText(payload); }
function fail(message, extra = {}) { return toolText({ ok: false, error: message, ...extra }, true); }

/** Owner hợp lệ = ownerId gốc + ownerId của từng bot profile. */
export function collectOwnerIds(pluginCfg) {
    const ids = new Set();
    const push = (value) => { const id = String(value || '').trim(); if (id) ids.add(id); };
    push(pluginCfg?.ownerId);
    for (const bot of Object.values(pluginCfg?.bots || {})) push(bot?.ownerId);
    return ids;
}

export function isOwnerRequester(requesterSenderId, ownerIds) {
    const id = String(requesterSenderId || '').trim();
    if (!id) return false; // lượt không có sender (cron/heartbeat) → không phải owner
    return ownerIds instanceof Set ? ownerIds.has(id) : new Set(ownerIds || []).has(id);
}

/**
 * Đổi danh sách người dùng gõ (tên nhóm / groupId / "all") thành groupId thật.
 *
 * Owner nói "mute nhóm Kinh Doanh" chứ không đọc groupId, nên bước này là bắt
 * buộc. Khớp chính xác trước, rồi khớp chứa-chuỗi; nhập nhằng thì TRẢ VỀ để bot
 * hỏi lại thay vì đoán.
 */
export function resolveGroupTargets(inputs, groups) {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    const wantAll = list.some((v) => foldGroupName(v) === 'all' || foldGroupName(v) === 'tat ca');
    if (wantAll) return { matched: groups.map((g) => g.groupId), unresolved: [], ambiguous: [] };

    const matched = [];
    const unresolved = [];
    const ambiguous = [];
    for (const raw of list) {
        const needle = String(raw ?? '').trim();
        if (!needle) continue;
        const byId = groups.filter((g) => g.groupId === needle.replace(/^group:/, ''));
        if (byId.length) { matched.push(...byId.map((g) => g.groupId)); continue; }

        const folded = foldGroupName(needle);
        if (!folded) { unresolved.push(needle); continue; }
        const exact = groups.filter((g) => foldGroupName(g.name) === folded);
        const pool = exact.length ? exact : groups.filter((g) => foldGroupName(g.name).includes(folded));
        if (!pool.length) { unresolved.push(needle); continue; }

        // Cùng một nhóm vật lý có nhiều groupId (mỗi bot một id per-account) —
        // trùng tên là ĐÚNG, không phải nhập nhằng.
        const distinctNames = new Set(pool.map((g) => foldGroupName(g.name)));
        if (distinctNames.size > 1) {
            ambiguous.push({ input: needle, candidates: [...new Set(pool.map((g) => g.name))].slice(0, 8) });
            continue;
        }
        matched.push(...pool.map((g) => g.groupId));
    }
    return { matched: [...new Set(matched)], unresolved, ambiguous };
}

/** Phân loại action cho `zalo_mod_action`. */
export function classifyAction(action, { allowDestructive = false } = {}) {
    const name = String(action || '').trim();
    if (!name) return { allowed: false, reason: 'Thiếu tên action.' };
    if (AGENT_FORBIDDEN_ACTIONS.includes(name)) {
        return { allowed: false, reason: `Action "${name}" liên quan thanh toán/license/quyền truy cập — chỉ đổi được từ dashboard, bot không được phép chạy.` };
    }
    if (AGENT_SAFE_ACTIONS.includes(name)) return { allowed: true, kind: 'safe' };
    if (AGENT_DESTRUCTIVE_ACTIONS.includes(name)) {
        return allowDestructive
            ? { allowed: true, kind: 'destructive' }
            : { allowed: false, reason: `Action "${name}" có thể gây hậu quả không hoàn tác nên đang bị chặn. Owner bật bằng cách đặt agentTools.allowDestructive = true trong config zalo-mod.` };
    }
    return { allowed: false, reason: `Action "${name}" không nằm trong danh sách bot được phép gọi.` };
}

const SETTINGS_SCHEMA = {
    type: 'object',
    properties: {
        groups: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tên nhóm (tiếng Việt có dấu cũng được), groupId, hoặc "all" cho mọi nhóm. Ví dụ: ["Kinh Doanh","Kỹ Thuật"].',
        },
        key: {
            type: 'string',
            enum: ['muted', 'silent', 'welcome', 'tracking', 'follow', 'pendingAuto', 'autoSummary'],
            description: 'Toggle cần đổi. muted = bot im lặng hoàn toàn; silent = chỉ reply khi @tag/gọi tên; follow = ghi lịch sử chat + memory.',
        },
        value: { type: 'boolean', description: 'true = bật, false = tắt.' },
        profile: { type: 'string', description: 'Chỉ áp cho một bot (accountId). Bỏ trống = áp cho mọi bot đang ở nhóm đó (khuyến nghị).' },
    },
    required: ['groups', 'key', 'value'],
    additionalProperties: false,
};

const HISTORY_SCHEMA = {
    type: 'object',
    properties: {
        groups: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tên nhóm hoặc groupId. Nhiều nhóm cùng lúc được.',
        },
        date: { type: 'string', description: 'Ngày YYYY-MM-DD theo giờ VN. Bỏ trống = hôm nay.' },
        days: { type: 'integer', minimum: 1, maximum: 14, description: 'Lấy N ngày gần nhất tính từ `date` (mặc định 1).' },
        summarize: { type: 'boolean', description: 'true = gọi bộ tổng hợp có sẵn của plugin (lưu lại bản tổng hợp, tốn 1 lượt LLM riêng). false/bỏ trống = trả transcript thô để bạn tự tổng hợp.' },
        limit: { type: 'integer', minimum: 20, maximum: 400, description: `Số tin tối đa mỗi nhóm (mặc định ${MAX_HISTORY_MESSAGES}).` },
    },
    required: ['groups'],
    additionalProperties: false,
};

/**
 * Tạo factory tool cho `api.registerTool`.
 *
 * @param {object} host cầu nối tới closure của register() trong index.js
 */
export function createZaloModAgentTools(host) {
    const {
        listGroups, runAction, getGroupState, readHistory, listHistoryDates,
        getNotes, getGroupMemories, getSummary, generateSummary, vnDateStr,
        getOwnerIds, isDestructiveAllowed, audit, logger, listCommands,
    } = host;

    const denied = (senderId) => fail(
        'Chỉ owner của bot mới điều khiển được Zalo Mod. Hãy nói với người dùng rằng bạn không có quyền và họ cần dùng dashboard hoặc nhờ owner.',
        { requester: senderId ? String(senderId) : null },
    );

    /** Kiểm tra owner lần 2 lúc execute, với danh sách owner đọc live. */
    const guard = (requesterSenderId) => {
        if (isOwnerRequester(requesterSenderId, getOwnerIds())) return null;
        logger?.warn?.(`[openclaw-zalo-mod] agent tool bị từ chối — requester=${requesterSenderId || 'unknown'} không phải owner`);
        return denied(requesterSenderId);
    };

    const logRun = async (tool, params, result) => {
        try { await audit?.({ action: `agent:${tool}`, payload: params, ok: !result?.content?.[0]?.isError }); } catch { /* audit best-effort */ }
    };

    const groupsSnapshot = async () => (await listGroups()).map((g) => ({ ...g }));

    /** Đọc lại state sau khi ghi — bot phải báo sự thật, không báo ý định. */
    const readBack = (groupIds) => groupIds.map((id) => getGroupState(id));

    function buildTools(requesterSenderId) {
        return [
            {
                name: 'zalo_mod_groups',
                label: 'Zalo Mod — danh sách nhóm & trạng thái',
                description: [
                    'Liệt kê mọi nhóm Zalo mà bot đang quản lý kèm TRẠNG THÁI THẬT của từng toggle',
                    '(muted/silent/welcome/follow/autoSummary) — đúng những badge hiển thị trên dashboard Zalo Mod.',
                    'Gọi tool này TRƯỚC khi trả lời bất kỳ câu hỏi về cấu hình nhóm, và SAU mỗi lần đổi cấu hình để xác nhận.',
                    'Chỉ owner dùng được.',
                ].join(' '),
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Lọc theo tên nhóm (không dấu cũng được). Bỏ trống = tất cả.' },
                        includeCommands: { type: 'boolean', description: 'true = kèm danh sách slash command đầy đủ của từng bot.' },
                    },
                    additionalProperties: false,
                },
                execute: async (_toolCallId, params = {}) => {
                    const blocked = guard(requesterSenderId);
                    if (blocked) return blocked;
                    const all = await groupsSnapshot();
                    const folded = foldGroupName(params.query);
                    const groups = folded ? all.filter((g) => foldGroupName(g.name).includes(folded)) : all;
                    const result = ok({
                        ok: true,
                        total: all.length,
                        groups,
                        ...(params.includeCommands ? { commands: listCommands() } : {}),
                        note: 'Đây là state thật đọc từ store của plugin. Báo lại đúng các giá trị này, không suy diễn.',
                    });
                    await logRun('zalo_mod_groups', params, result);
                    return result;
                },
            },
            {
                name: 'zalo_mod_settings',
                label: 'Zalo Mod — bật/tắt tính năng theo nhóm',
                description: [
                    'Bật/tắt một toggle của Zalo Mod cho một hoặc nhiều nhóm — TƯƠNG ĐƯƠNG bấm badge trên dashboard.',
                    'Dùng tool này khi owner nói kiểu "mute nhóm A và nhóm B", "bật follow hết", "tắt welcome nhóm X".',
                    'Nhận TÊN nhóm, không cần groupId. Tool tự đồng bộ runtime policy và trả về state đã đọc lại.',
                    'TUYỆT ĐỐI không tự nhận đã đổi xong khi chưa gọi tool này và chưa thấy applied > 0.',
                ].join(' '),
                parameters: SETTINGS_SCHEMA,
                execute: async (_toolCallId, params = {}) => {
                    const blocked = guard(requesterSenderId);
                    if (blocked) return blocked;
                    const all = await groupsSnapshot();
                    const { matched, unresolved, ambiguous } = resolveGroupTargets(params.groups, all);
                    if (ambiguous.length) {
                        return fail('Tên nhóm chưa rõ — hỏi lại owner chọn nhóm nào trước khi đổi cấu hình.', { ambiguous, unresolved });
                    }
                    if (!matched.length) {
                        return fail('Không tìm thấy nhóm nào khớp. Gọi zalo_mod_groups để xem tên nhóm đúng rồi hỏi lại owner.', { unresolved, known: all.map((g) => g.name) });
                    }
                    // Chọn action ĐÚNG NHƯ dashboard chọn, vì licensing gắn vào tên
                    // action: mọi action `bulk-*` đòi gói PRO kể cả khi chỉ 1 nhóm.
                    // Một nhóm Zalo có thể có nhiều groupId (mỗi bot một id) — đó vẫn
                    // là MỘT nhóm về mặt logic nên phải đi đường single, không thì
                    // owner gói FREE bấm badge được mà nhờ bot lại báo "cần PRO".
                    const logicalGroups = new Set(matched.map((id) => {
                        const info = all.find((g) => g.groupId === id);
                        return foldGroupName(info?.name) || id;
                    }));
                    const single = logicalGroups.size <= 1;
                    const profilePart = params.profile ? { profile: String(params.profile) } : {};
                    const payload = single
                        ? { groupId: matched[0], key: params.key, value: !!params.value, ...profilePart }
                        : { groupIds: matched, key: params.key, value: !!params.value, ...profilePart };
                    try {
                        const raw = await runAction(single ? 'toggle-setting' : 'bulk-toggle-setting', payload);
                        const result = ok({
                            ok: true,
                            key: params.key,
                            value: !!params.value,
                            applied: raw?.count ?? raw?.applied ?? matched.length,
                            runtimePolicy: raw?.runtimePolicy,
                            groups: readBack(matched),
                            unresolved,
                            note: 'Đã ghi và đọc lại. Báo cho owner đúng theo mảng groups ở trên.',
                        });
                        await logRun('zalo_mod_settings', params, result);
                        return result;
                    } catch (e) {
                        const result = fail(`Không đổi được cấu hình: ${e.message}`, {
                            code: e.code || null,
                            hint: e.code === 'PRO_REQUIRED' || e.code === 'TEAM_REQUIRED'
                                ? 'Đây là giới hạn gói license, không phải lỗi kỹ thuật. Nói thẳng cho owner biết cần nâng gói. Cách làm được ngay với gói FREE: gọi lại tool này NHIỀU LƯỢT, mỗi lượt đúng MỘT nhóm.'
                                : undefined,
                            attemptedGroups: readBack(matched),
                        });
                        await logRun('zalo_mod_settings', params, result);
                        return result;
                    }
                },
            },
            {
                name: 'zalo_mod_history',
                label: 'Zalo Mod — đọc lịch sử chat nhóm',
                description: [
                    'Đọc lịch sử chat đã ghi của các nhóm đang bật follow/tracking, kèm ghi chú admin và memory của ngày đó.',
                    'Dùng khi owner nhờ "tổng hợp nhóm A, nhóm B", "hôm nay nhóm X nói gì", "tóm tắt tuần này".',
                    'Mặc định trả transcript thô để bạn tự tổng hợp bằng lời của mình.',
                    'Đặt summarize=true nếu owner muốn LƯU bản tổng hợp chuẩn của plugin (xuất hiện trong Nhật ký nhóm trên dashboard).',
                ].join(' '),
                parameters: HISTORY_SCHEMA,
                execute: async (_toolCallId, params = {}) => {
                    const blocked = guard(requesterSenderId);
                    if (blocked) return blocked;
                    const all = await groupsSnapshot();
                    const { matched, unresolved, ambiguous } = resolveGroupTargets(params.groups, all);
                    if (ambiguous.length) return fail('Tên nhóm chưa rõ — hỏi lại owner.', { ambiguous });
                    if (!matched.length) {
                        return fail('Không tìm thấy nhóm nào khớp.', { unresolved, known: all.map((g) => g.name) });
                    }

                    // Cùng một nhóm vật lý có thể có nhiều groupId (một id / bot).
                    // Lịch sử ghi theo id nào có tin thì lấy id đó — gộp theo tên.
                    const byName = new Map();
                    for (const id of matched) {
                        const info = all.find((g) => g.groupId === id);
                        const key = foldGroupName(info?.name) || id;
                        if (!byName.has(key)) byName.set(key, []);
                        byName.get(key).push(id);
                    }
                    if (byName.size > MAX_HISTORY_GROUPS) {
                        return fail(`Quá nhiều nhóm một lượt (${byName.size}). Chia nhỏ tối đa ${MAX_HISTORY_GROUPS} nhóm.`);
                    }

                    const baseDate = String(params.date || vnDateStr());
                    const days = Math.max(1, Math.min(14, Number(params.days) || 1));
                    const dates = [];
                    for (let i = 0; i < days; i += 1) {
                        const d = new Date(`${baseDate}T00:00:00Z`);
                        d.setUTCDate(d.getUTCDate() - i);
                        dates.push(d.toISOString().slice(0, 10));
                    }
                    const limit = Math.max(20, Math.min(MAX_HISTORY_MESSAGES, Number(params.limit) || MAX_HISTORY_MESSAGES));

                    const out = [];
                    for (const [, ids] of byName) {
                        const info = all.find((g) => ids.includes(g.groupId)) || { groupId: ids[0], name: ids[0] };
                        const entry = {
                            group: info.name,
                            groupIds: ids,
                            followEnabled: ids.some((id) => getGroupState(id)?.follow),
                            days: [],
                        };
                        if (!entry.followEnabled) {
                            entry.warning = 'Nhóm này chưa bật follow nên plugin không ghi lịch sử. Đề nghị owner bật follow trước (dùng zalo_mod_settings key=follow value=true) — chỉ có dữ liệu từ lúc bật trở đi.';
                        }
                        for (const date of dates) {
                            let messages = [];
                            for (const id of ids) {
                                const rows = await readHistory(id, date);
                                if (rows?.length) messages = rows;
                                if (messages.length) break;
                            }
                            const activeId = ids.find((id) => messages.length) || ids[0];
                            const trimmed = messages.slice(-limit).map((m) => ({
                                t: m.t,
                                name: m.name || m.userId || '',
                                text: String(m.text || '').slice(0, MAX_TEXT_LEN),
                                ...(m.links?.length ? { links: m.links } : {}),
                            }));
                            const day = {
                                date,
                                messageCount: messages.length,
                                truncated: messages.length > trimmed.length,
                                messages: trimmed,
                                notes: (await getNotes(activeId)).filter((n) => vnDateStr(new Date(n.ts)) === date).map((n) => ({ name: n.userName, text: n.text })),
                                memories: (await getGroupMemories(activeId)).filter((m) => vnDateStr(new Date(m.ts)) === date).map((m) => ({ name: m.userName, text: m.text })),
                            };
                            if (params.summarize) {
                                try { day.summary = await generateSummary(activeId, date); }
                                catch (e) { day.summaryError = e.message; }
                            } else {
                                const existing = await getSummary(activeId, date);
                                if (existing) day.existingSummary = existing;
                            }
                            entry.days.push(day);
                        }
                        entry.availableDates = (await listHistoryDates(ids[0])).slice(0, 30);
                        out.push(entry);
                    }
                    const result = ok({
                        ok: true,
                        dates,
                        groups: out,
                        unresolved,
                        note: params.summarize
                            ? 'Bản tổng hợp đã được lưu vào Nhật ký nhóm.'
                            : 'Transcript thô. Tự tổng hợp bằng lời của bạn, ngắn gọn theo quy tắc group. Nếu messageCount = 0 thì nói thật là không có dữ liệu, đừng bịa.',
                    });
                    await logRun('zalo_mod_history', params, result);
                    return result;
                },
            },
            {
                name: 'zalo_mod_action',
                label: 'Zalo Mod — chạy action của dashboard',
                description: [
                    'Chạy đúng những action mà mỗi nút trên dashboard Zalo Mod gọi (sync-groups, scan-members, get-group-info,',
                    'journal-data, generate-summary, send-message, custom modes, report schedule…).',
                    'Dùng khi việc owner nhờ không khớp 3 tool kia. Gọi với action="list-actions" để xem danh sách được phép.',
                    'Action liên quan tiền/license/quyền bị chặn cứng; action phá hoại cần owner bật riêng trong config.',
                ].join(' '),
                parameters: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', description: 'Tên action, hoặc "list-actions" để xem danh sách được phép.' },
                        payload: { type: 'object', description: 'Payload của action (giống body dashboard gửi).', additionalProperties: true },
                    },
                    required: ['action'],
                    additionalProperties: false,
                },
                execute: async (_toolCallId, params = {}) => {
                    const blocked = guard(requesterSenderId);
                    if (blocked) return blocked;
                    const action = String(params.action || '').trim();
                    if (action === 'list-actions') {
                        return ok({
                            ok: true,
                            safe: AGENT_SAFE_ACTIONS,
                            destructive: AGENT_DESTRUCTIVE_ACTIONS,
                            destructiveEnabled: !!isDestructiveAllowed(),
                            forbidden: AGENT_FORBIDDEN_ACTIONS,
                        });
                    }
                    const verdict = classifyAction(action, { allowDestructive: !!isDestructiveAllowed() });
                    if (!verdict.allowed) return fail(verdict.reason);
                    try {
                        const raw = await runAction(action, params.payload || {});
                        const result = ok({ ok: true, action, kind: verdict.kind, result: raw });
                        await logRun('zalo_mod_action', params, result);
                        return result;
                    } catch (e) {
                        const result = fail(`Action "${action}" lỗi: ${e.message}`, { code: e.code || null });
                        await logRun('zalo_mod_action', params, result);
                        return result;
                    }
                },
            },
        ];
    }

    /**
     * Factory cho api.registerTool. Host gọi lại mỗi lượt agent với ctx của lượt
     * đó (descriptor cache có khoá theo requesterSenderId nên an toàn).
     */
    return function zaloModToolFactory(toolContext) {
        const requesterSenderId = toolContext?.requesterSenderId;
        if (!isOwnerRequester(requesterSenderId, getOwnerIds())) return [];
        return buildTools(requesterSenderId);
    };
}
