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
    'zalo_mod_reports',
    'zalo_mod_tasks',
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
    'toggle-setting', 'bulk-toggle-setting',
    // Lịch báo cáo — bot ĐỌC + TẠO + SỬA được, để owner sai bằng lời thay vì tự vào dashboard.
    // `report-digest-preview` chỉ dựng chuỗi (không gửi) nên an toàn. `report-job-run` GỬI thật nhưng
    // chỉ tới các đích đã cấu hình sẵn trong lịch, không nhận đích tuỳ ý từ agent.
    // `report-job-save` sửa MỘT PHẦN (gửi {id, time} là đủ) và vẫn qua đúng kiểm tra hợp lệ như dashboard.
    'report-jobs', 'report-digest-preview', 'report-job-run', 'report-job-save',
    // `report-sent` chỉ đọc lịch sử đã gửi — để owner hỏi "sáng nay bot gửi gì" thì bot đọc được
    // đúng bản đã gửi, thay vì dựng lại (dựng lại ra kết quả khác nếu lịch đã đổi từ lúc đó).
    'report-sent',
    // XOÁ lịch cũng cho, nhưng phanh là bước XÁC NHẬN HAI NHỊP trong `zalo_mod_reports`
    // (operation="delete" không kèm confirm=true thì chỉ trả về sẽ xoá gì rồi bắt hỏi lại owner),
    // KHÔNG phải cờ `allowDestructive`. Cờ đó mở kèm remove-user/block-member/leave-group —
    // bắt owner mở cả chùm đó chỉ để xoá một lịch báo cáo là đổi phanh nhỏ lấy rủi ro lớn.
    'report-job-delete',
    // get-templates: bot đọc được KEY hợp lệ + nội dung hiện tại, nên "cập nhật welcome" mới làm được
    // (trước đây chỉ có save-templates nên bot phải đoán key → báo không làm được).
    'get-templates',
    // zalo-api: một cửa sang ~141 action của zalo-connect. Tự có deny-by-default + phân loại
    // read/write/destructive trong src/agent/connect-actions.js, và vẫn qua luật gói như mọi action.
    'zalo-api',
    'toggle-custom-mode', 'upsert-custom-mode', 'delete-custom-mode',
    'set-name-triggers', 'save-templates',
    // P15 (Kent chốt mở — đảo lại luật P4 "bot không có đường nào tới crm-task-*"): việc tồn đọng
    // đọc/duyệt/từ chối/đổi cột được qua chat, đi ĐÚNG action mà dashboard dùng. TUYỆT ĐỐI KHÔNG mở
    // `crm-task-delete` — xoá dữ liệu khách không bao giờ đi qua đường chat, kể cả với allowDestructive.
    'crm-tasks-list', 'crm-tasks-board', 'crm-task-status', 'crm-task-approve',
    'crm-task-approve-move', 'crm-task-reject',
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

/**
 * Khớp tên nhóm theo TỪNG TỪ, không cần đúng thứ tự -- bỏ dấu qua `foldGroupName` trước (P3b).
 *
 * Sự cố thật 09/08: owner nhờ bật silent cho "39 Cùng rèn", so khớp CHUỖI CON không ra `[39] RÈN
 * CÙNG NHAU` vì thứ tự chữ khác nhau ("cung ren" không phải chuỗi con của "ren cung nhau") -> bot kết
 * luận sai "nhóm chưa được quản lý" dù nhóm đã bật follow/silent thật.
 *
 * Đòi khớp ĐỦ mọi từ vẫn quá cứng: người nhớ tên hay lẫn một từ (owner có thể gõ "39 - tự rèn" thay
 * vì "cùng rèn"). Ngược lại khớp lỏng quá (chỉ cần 1 từ) thì một chữ số như "39" trùng ngẫu nhiên
 * hàng chục nhóm. Chọn mốc giữa: **quá NỬA số từ phải khớp** (làm tròn lên) -- với truy vấn 1 từ thì
 * vẫn đòi khớp tuyệt đối, không có chỗ cho sai.
 */
export function tokenMatchGroupName(name, query) {
    const tokens = foldGroupName(query).split(' ').filter(Boolean);
    if (!tokens.length) return false;
    const foldedName = foldGroupName(name);
    const matched = tokens.filter((t) => foldedName.includes(t)).length;
    return matched >= Math.ceil(tokens.length / 2);
}

/** 5 nhóm "gần giống" nhất theo số từ trùng -- dùng khi khớp tên ra 0 kết quả, để owner còn cái chọn. */
export function suggestGroupNames(query, groups, limit = 5) {
    const tokens = foldGroupName(query).split(' ').filter(Boolean);
    return groups
        .map((g) => ({ name: g.name, score: tokens.filter((t) => foldGroupName(g.name).includes(t)).length }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((s) => s.name);
}

function toolText(payload, isError = false) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text', text, ...(isError ? { isError: true } : {}) }], details: payload };
}

function ok(payload) { return toolText(payload); }
function fail(message, extra = {}) { return toolText({ ok: false, error: message, ...extra }, true); }

/** `due_at`/`updated_at` lưu epoch ms — đổi sang YYYY-MM-DD cho LLM đọc, null nếu không có. */
function isoDate(ms) {
    if (!ms) return null;
    try { return new Date(ms).toISOString().slice(0, 10); } catch { return null; }
}

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
 * Owner theo NGỮ CẢNH INBOUND, không chỉ theo id khớp bảng.
 *
 * Host cấp hai tín hiệu, và CẢ HAI chỉ được cấp khi gateway client có ADMIN_SCOPE (xem
 * `canSupplyTrustedRequester` trong core) — nên `senderIsOwner` đáng tin y như `requesterSenderId`:
 *   requesterSenderId?: string   — id người gửi
 *   senderIsOwner?: boolean      — "trusted owner bit from inbound context"
 *
 * Trước đây chỉ so id, và đó là lỗi thật trên vps_asa (2026-07-31): trong DM thì id khớp `ownerId`
 * đã cấu hình nên bot có tool; trong NHÓM host gửi `senderIsOwner: true` nhưng id không khớp bảng →
 * plugin trả về 0 tool. Bot mất cả đường ĐỌC lẫn đường GHI nên nó tự ứng biến: lấy `cron` để đặt
 * lịch (thành lịch ẩn), và trả lời trạng thái bằng ký ức hội thoại (nói 08:00 khi thật là 09:00).
 * Mọi triệu chứng đêm đó đều từ một dòng gate này.
 */
export function isTrustedOwnerContext(toolContext, ownerIds) {
    if (toolContext?.senderIsOwner === true) return true;
    return isOwnerRequester(toolContext?.requesterSenderId, ownerIds);
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
            enum: ['muted', 'silent', 'welcome', 'tracking', 'follow', 'pendingAuto', 'autoSummary', 'backlogInclude'],
            description: 'Toggle cần đổi. muted = bot im lặng hoàn toàn; silent = chỉ reply khi @tag/gọi tên; follow = ghi lịch sử chat + memory; '
                + 'backlogInclude = nhóm này có vào tin "việc còn treo" (lịch backlog) hay không — tắt cho nhóm rèn luyện/nội bộ, '
                + 'không phải task team có deadline thật.',
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

/** "all"/"tất cả" → '*'; còn lại giữ nguyên tên nhóm để tầng dưới resolve. undefined = không đổi. */
function normalizeReportGroups(groups) {
    if (groups === undefined) return undefined;
    const list = (Array.isArray(groups) ? groups : [groups]).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (!list.length) return undefined;
    if (list.some((v) => ['all', 'tat ca', 'tất cả'].includes(foldGroupName(v)) || v === '*')) return '*';
    return list;
}

/**
 * Lịch báo cáo — schema PHẲNG, cố ý không lồng.
 *
 * Bug thật, ba lần liên tiếp: owner nhờ "đổi lịch báo cáo tổng hợp thành 9h sáng vào nhóm ASACHINA
 * ZALO", bot gọi vài action ĐỌC rồi báo "đã đổi xong" trong khi lịch không đổi. Đường duy nhất để ghi
 * là `zalo_mod_action { action: "report-job-save", payload: { job: { … } } }` — model phải tự chọn đúng
 * tên action trong danh sách hơn 40 cái RỒI lồng JSON ba lớp. Nó không làm nổi, kể cả khi tên action đã
 * nằm trong mô tả tool.
 *
 * `zalo_mod_settings` thì luôn gọi đúng, vì phẳng + có enum + có required. Tool này bắt chước y hệt:
 * mỗi thứ owner hay nhờ là MỘT field ở tầng ngoài cùng.
 */
const REPORTS_SCHEMA = {
    type: 'object',
    properties: {
        operation: {
            type: 'string',
            enum: ['list', 'save', 'run', 'preview', 'delete'],
            description: 'list = xem các lịch đang có (LÀM ĐẦU TIÊN để lấy id). save = tạo mới hoặc sửa. run = gửi ngay. preview = xem trước chuỗi sẽ gửi, không gửi. delete = xoá vĩnh viễn, cần confirm=true.',
        },
        confirm: {
            type: 'boolean',
            description: 'Chỉ dùng với operation="delete". Gọi lần đầu KHÔNG có confirm để biết sẽ xoá lịch nào, hỏi lại owner, rồi mới gọi lại với confirm=true.',
        },
        id: { type: 'string', description: 'id của lịch cần sửa (lấy từ operation="list"). Bỏ trống khi tạo lịch mới.' },
        name: { type: 'string', description: 'Tên lịch, ví dụ "BC Tổng Hợp". Chỉ cần khi tạo mới.' },
        time: { type: 'string', description: 'Giờ gửi mỗi ngày, dạng HH:MM giờ VN. Ví dụ "09:00".' },
        reportFor: {
            type: 'string',
            enum: ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'custom'],
            description: 'Báo cáo nói về khoảng thời gian nào. Lịch BUỔI SÁNG phải dùng "yesterday" — nếu để '
                + '"today" thì lúc 08:00 nó chỉ tóm tắt mấy tiếng đầu ngày (gần như trống) và cả ngày hôm trước '
                + 'không bao giờ được báo. Lịch cuối ngày (sau ~20:00) thì dùng "today". "last7"/"last30" = 7/30 '
                + 'ngày kết thúc HÔM QUA, "thisMonth" = từ đầu tháng tới hôm qua — owner nói "tổng hợp 7 ngày", '
                + '"báo cáo tháng này" thì dùng các giá trị này. "custom" cần thêm rangeFrom/rangeTo. '
                + '⚠️ "last7"/"last30"/"thisMonth"/"custom" CHỈ ĐỌC bản tổng hợp NGÀY đã có sẵn (summaries/), '
                + 'TUYỆT ĐỐI không sinh lại bằng AI — ngày nào chưa có bản tổng hợp thì báo cáo tự ghi rõ '
                + 'ngày đó thiếu, không phải lỗi, không phải bịa. Mặc định "today".',
        },
        rangeFrom: {
            type: 'string',
            description: 'Chỉ dùng khi reportFor="custom". Ngày bắt đầu, dạng YYYY-MM-DD.',
        },
        rangeTo: {
            type: 'string',
            description: 'Chỉ dùng khi reportFor="custom". Ngày kết thúc, dạng YYYY-MM-DD.',
        },
        kind: {
            type: 'string',
            enum: ['digest', 'group', 'backlog'],
            description: 'digest = gộp tất cả nhóm vào MỘT tin ngắn. group = mỗi nhóm một tin đầy đủ. '
                + 'backlog = "việc còn treo" của các nhóm — TRUY VẤN kanban đã có, KHÔNG dùng AI để sinh lại. '
                + 'Dùng "backlog" khi owner nói kiểu "báo cáo còn việc gì chưa làm", "việc tồn đọng", "nhắc việc chưa xong".',
        },
        groups: {
            type: 'array',
            items: { type: 'string' },
            description: 'Các nhóm được tổng hợp. Tên nhóm có dấu cũng được, hoặc ["all"] cho tất cả nhóm đang follow.',
        },
        toOwnerDm: { type: 'boolean', description: 'true = gửi vào DM riêng của owner.' },
        toGroups: {
            type: 'array',
            items: { type: 'string' },
            description: 'Gửi báo cáo vào (các) nhóm này — tên nhóm cũng được. Dùng khi owner nói "gửi vào nhóm X".',
        },
        toEachGroup: { type: 'boolean', description: 'true = mỗi nhóm tự nhận báo cáo của nó. Chỉ dùng với kind="group".' },
        enabled: { type: 'boolean', description: 'false = tạm tắt lịch mà không xoá.' },
    },
    required: ['operation'],
    additionalProperties: false,
};

/**
 * P15: việc tồn đọng (kanban "Công việc") điều khiển bằng lời. Schema PHẲNG như `zalo_mod_settings`/
 * `zalo_mod_reports` — owner nói tên việc, không nói id, nên `title` phải khớp gần đúng thay vì đòi
 * chính xác. Đảo lại luật P4 ("bot không có đường nào tới crm-task-*") theo quyết định của Kent —
 * xem CHANGELOG mục P15 để biết đây là đổi có chủ ý, không phải lỗ hổng.
 */
const TASKS_SCHEMA = {
    type: 'object',
    properties: {
        operation: {
            type: 'string',
            enum: ['list', 'status', 'approve', 'reject'],
            description: 'list = xem việc còn treo, lọc được theo nhóm + trạng thái. status = đổi cột '
                + '(todo/doing/blocked/done) của một việc ĐÃ duyệt — không nhận "pending_review", muốn duyệt '
                + 'dùng operation="approve". approve = duyệt việc AI đề xuất (bỏ trạng thái chờ xác nhận), có '
                + 'thể kèm `status` để duyệt và chuyển cột trong một lượt. reject = từ chối việc AI đề xuất — '
                + 'KHÔNG xoá dữ liệu, chỉ ẩn khỏi kanban/báo cáo, có thể tự quay lại "Chờ xác nhận" sau 30 ngày.',
        },
        groups: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tên nhóm (có dấu cũng được) hoặc groupId, hoặc ["all"]. operation="list": lọc phạm '
                + 'vi xem. Các operation khác: dùng để thu hẹp khi `title` khớp trùng nhiều nhóm. Bỏ trống = mọi nhóm.',
        },
        status: {
            type: 'string',
            enum: ['pending_review', 'todo', 'doing', 'blocked', 'done'],
            description: 'operation="list": lọc theo cột kanban, bỏ trống = mọi việc CHƯA xong (không gồm '
                + '"done"). operation="status": cột đích, chỉ nhận todo|doing|blocked|done. operation="approve": '
                + 'tuỳ chọn, có thì duyệt và chuyển luôn sang cột này.',
        },
        title: {
            type: 'string',
            description: 'Tên việc cần tìm, khớp GẦN ĐÚNG (không cần đúng từng chữ) — bắt buộc cho operation='
                + '"status"/"approve"/"reject" khi chưa có `id`. Khớp ra nhiều hơn một việc thì tool trả về '
                + '`suggestions` thay vì tự chọn — phải hỏi lại owner rõ hơn (thêm `groups` để thu hẹp) rồi gọi lại.',
        },
        id: {
            type: 'string',
            description: 'id việc đã biết chắc (từ operation="list" hoặc từ `suggestions` của lần gọi trước) — '
                + 'có thì dùng luôn, bỏ qua bước khớp theo `title`.',
        },
    },
    required: ['operation'],
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

    /**
     * Kiểm tra owner lần 2 lúc execute, với danh sách owner đọc live.
     *
     * `hostSaysOwner` là bit đáng tin của host, đã kiểm ở factory và đi kèm suốt vòng đời tool —
     * phải xét lại ở đây, không thì tool cấp cho owner-trong-nhóm lại bị chính guard này chặn.
     */
    const guard = (requesterSenderId, hostSaysOwner = false) => {
        if (isTrustedOwnerContext({ requesterSenderId, senderIsOwner: hostSaysOwner }, getOwnerIds())) return null;
        logger?.warn?.(`[openclaw-zalo-mod] agent tool bị từ chối — requester=${requesterSenderId || 'unknown'} không phải owner`);
        return denied(requesterSenderId);
    };

    const logRun = async (tool, params, result) => {
        try { await audit?.({ action: `agent:${tool}`, payload: params, ok: !result?.content?.[0]?.isError }); } catch { /* audit best-effort */ }
    };

    const groupsSnapshot = async () => (await listGroups()).map((g) => ({ ...g }));

    /** Đọc lại state sau khi ghi — bot phải báo sự thật, không báo ý định. */
    const readBack = (groupIds) => groupIds.map((id) => getGroupState(id));

    function buildTools(requesterSenderId, hostSaysOwner = false) {
        return [
            {
                name: 'zalo_mod_groups',
                label: 'Zalo Mod — danh sách nhóm & trạng thái',
                description: [
                    'Liệt kê mọi nhóm Zalo mà bot đang quản lý kèm TRẠNG THÁI THẬT của từng toggle',
                    '(muted/silent/welcome/follow/autoSummary) — đúng những badge hiển thị trên dashboard Zalo Mod.',
                    'Gọi tool này TRƯỚC khi trả lời bất kỳ câu hỏi về cấu hình nhóm, và SAU mỗi lần đổi cấu hình để xác nhận.',
                    'query khớp THEO TỪNG TỪ, không dấu, không cần đúng thứ tự — "39 cùng rèn" vẫn ra đúng nhóm dù',
                    'tên thật là "[39] RÈN CÙNG NHAU". Nếu trả về "total: 0" kèm "suggestions": tin có nhóm gần giống,',
                    // Bài học 09/08: khớp chuỗi-con thất bại vì thứ tự chữ khác nhau → bot tự kết luận "nhóm chưa
                    // được quản lý" dù nhóm ĐÃ follow/silent thật, nghe y như bịa. Luật phải nằm ở mô tả tool (nơi
                    // LUÔN nằm trong prompt) để thắng được hướng dẫn "phải đi tìm" của SKILL.md.
                    '⛔ TUYỆT ĐỐI đừng tự kết luận "nhóm chưa được Zalo Mod quản lý" chỉ vì không khớp đúng tên owner',
                    'gõ — hỏi lại owner tên chính xác hơn, hoặc gợi ý một trong các suggestions.',
                    'Chỉ owner dùng được.',
                ].join(' '),
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Lọc theo tên nhóm (không dấu cũng được, không cần đúng thứ tự từ). Bỏ trống = tất cả.' },
                        includeCommands: { type: 'boolean', description: 'true = kèm danh sách slash command đầy đủ của từng bot.' },
                    },
                    additionalProperties: false,
                },
                execute: async (_toolCallId, params = {}) => {
                    const blocked = guard(requesterSenderId, hostSaysOwner);
                    if (blocked) return blocked;
                    const all = await groupsSnapshot();
                    const folded = foldGroupName(params.query);
                    let groups = folded ? all.filter((g) => foldGroupName(g.name).includes(folded)) : all;
                    // Khớp chuỗi-con thất bại (thứ tự từ khác nhau, sự cố "39 Cùng rèn" 09/08) → thử lại
                    // bằng TOKEN trước khi kết luận "không có nhóm nào khớp".
                    if (folded && !groups.length) {
                        groups = all.filter((g) => tokenMatchGroupName(g.name, params.query));
                    }
                    const zeroResult = !!folded && !groups.length;
                    const result = ok({
                        ok: true,
                        total: all.length,
                        groups,
                        ...(params.includeCommands ? { commands: listCommands() } : {}),
                        ...(zeroResult
                            ? {
                                suggestions: suggestGroupNames(params.query, all),
                                note: 'KHÔNG tìm thấy nhóm theo tên này. ĐỪNG kết luận nhóm chưa được quản lý — hỏi lại owner hoặc chọn trong suggestions.',
                            }
                            : { note: 'Đây là state thật đọc từ store của plugin. Báo lại đúng các giá trị này, không suy diễn.' }),
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
                    const blocked = guard(requesterSenderId, hostSaysOwner);
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
                    const blocked = guard(requesterSenderId, hostSaysOwner);
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
                name: 'zalo_mod_reports',
                label: 'Zalo Mod — lịch báo cáo tổng hợp',
                description: [
                    'Xem / tạo / sửa / xoá lịch báo cáo lịch sử chat — TƯƠNG ĐƯƠNG trang "Nhật ký → Lịch báo cáo" trên dashboard.',
                    'Dùng tool này khi owner nói kiểu "đổi lịch báo cáo tổng hợp thành 9h sáng", "gửi báo cáo vào nhóm X",',
                    '"tạo lịch tổng hợp tất cả nhóm", "tắt lịch báo cáo", "xoá lịch báo cáo", "gửi thử báo cáo cho tôi xem".',
                    // Bẫy đã xảy ra thật (vps_asa 2026-07-31): AGENTS.md của bot dạy "Cron khi cần giờ chính
                    // xác, kết quả gửi thẳng vào channel" — khớp từng chữ với "đổi lịch báo cáo thành 8h, gửi
                    // vào nhóm X". Bot tạo cron job, báo đã xong, còn dashboard vẫn hiện giờ cũ → owner tưởng
                    // bot nói dối. Hướng dẫn luôn-bật thắng SKILL.md phải-đi-tìm, nên luật phải nằm Ở ĐÂY.
                    '⛔ ĐÂY LÀ ĐƯỜNG DUY NHẤT để đặt/đổi lịch báo cáo. TUYỆT ĐỐI không dùng tool `cron` cho việc này,',
                    'kể cả khi owner nói giờ chính xác và nói gửi vào nhóm nào — cron tạo ra lịch ẩn mà dashboard',
                    'không hiện, owner xem thấy giờ cũ và tưởng bạn báo sai. Cron chỉ dành cho việc hẹn giờ KHÁC.',
                    'Nhận TÊN nhóm, không cần groupId. Luôn gọi operation="list" trước để lấy id của lịch cần sửa.',
                    'Sửa một phần là đủ: đổi giờ chỉ cần { operation:"save", id, time }.',
                    'TUYỆT ĐỐI không tự nhận đã đổi xong khi chưa gọi operation="save" và chưa thấy ok trong kết quả.',
                    // Bẫy thật (vps_asa 01:23 ngày 2026-07-31): owner nhờ đổi giờ lần thứ hai, bot thấy trong
                    // lịch sử hội thoại là lượt trước mình đã báo "đã đổi xong 08:00" nên trả lời "lịch hiện
                    // đã đúng" mà KHÔNG gọi tool nào. Thực tế lịch đang 09:00 và đang tắt. Lịch sử hội thoại
                    // không phải trạng thái — dashboard, owner, hay agent khác đều có thể đã đổi từ lúc đó.
                    '⛔ Owner hỏi hay nhờ BẤT CỨ GÌ về lịch báo cáo thì PHẢI gọi operation="list" rồi mới trả lời —',
                    'kể cả khi bạn nhớ là lượt trước đã làm rồi, kể cả khi định nói "lịch hiện đã đúng".',
                    'Lời bạn nói ở lượt trước KHÔNG phải bằng chứng về trạng thái hiện tại. Chỉ kết quả tool mới là.',
                ].join(' '),
                parameters: REPORTS_SCHEMA,
                execute: async (_toolCallId, params = {}) => {
                    const blocked = guard(requesterSenderId, hostSaysOwner);
                    if (blocked) return blocked;
                    const op = String(params.operation || '').trim();
                    try {
                        if (op === 'list') {
                            const result = await runAction('report-jobs', {});
                            await logRun('zalo_mod_reports', params, result);
                            return ok({ ok: true, ...result });
                        }
                        if (op === 'preview') {
                            const groups = normalizeReportGroups(params.groups);
                            const previewPayload = { groups: groups ?? '*' };
                            if (params.reportFor !== undefined) previewPayload.reportFor = params.reportFor;
                            if (params.rangeFrom !== undefined) previewPayload.rangeFrom = params.rangeFrom;
                            if (params.rangeTo !== undefined) previewPayload.rangeTo = params.rangeTo;
                            const result = await runAction('report-digest-preview', previewPayload);
                            await logRun('zalo_mod_reports', params, result);
                            return ok({ ok: true, ...result });
                        }
                        if (op === 'run') {
                            if (!params.id) return fail('Thiếu id. Gọi operation="list" trước để lấy id của lịch.');
                            const result = await runAction('report-job-run', { id: params.id });
                            await logRun('zalo_mod_reports', params, result);
                            return ok({ ok: true, ...result });
                        }
                        if (op === 'delete') {
                            const id = String(params.id || '').trim();
                            if (!id) return fail('Thiếu id. Gọi operation="list" trước để lấy id của lịch cần xoá.');
                            const before = await runAction('report-jobs', {});
                            const target = (before?.jobs || []).find((j) => j.id === id);
                            if (!target) return fail(`Không có lịch nào id "${id}". Gọi operation="list" để xem lại.`);
                            // Xoá lịch là không hoàn tác được và owner phải cài lại từ đầu, nên chặn một nhịp:
                            // lần gọi đầu chỉ trả về SẼ xoá cái gì, buộc bot hỏi lại owner rồi mới xoá thật.
                            if (params.confirm !== true) {
                                return ok({
                                    ok: false,
                                    needsConfirm: true,
                                    willDelete: { id: target.id, name: target.name, time: target.time, kind: target.kind },
                                    note: `Chưa xoá gì. Hỏi lại owner có chắc xoá lịch "${target.name}" (${target.time}) không, `
                                        + 'rồi gọi lại operation="delete" kèm confirm=true. Không tự quyết.',
                                });
                            }
                            const result = await runAction('report-job-delete', { id });
                            const after = await runAction('report-jobs', {});
                            const out = { ok: true, deleted: { id: target.id, name: target.name }, jobs: after?.jobs || [], ...result };
                            await logRun('zalo_mod_reports', params, out);
                            return ok(out);
                        }
                        if (op !== 'save') return fail(`operation "${op}" không hợp lệ. Dùng: list | save | run | preview | delete.`);

                        // Dựng payload lồng cho runDashboardAction TỪ các field phẳng — chỗ model hay sai
                        // nhất, nên để code làm thay vì bắt model tự lồng JSON.
                        const job = { id: String(params.id || '').trim() || `job-${Date.now().toString(36)}` };
                        if (params.name !== undefined) job.name = params.name;
                        if (params.time !== undefined) job.time = params.time;
                        if (params.reportFor !== undefined) job.reportFor = params.reportFor;
                        if (params.rangeFrom !== undefined) job.rangeFrom = params.rangeFrom;
                        if (params.rangeTo !== undefined) job.rangeTo = params.rangeTo;
                        if (params.kind !== undefined) job.kind = params.kind;
                        if (params.enabled !== undefined) job.enabled = params.enabled;
                        const groups = normalizeReportGroups(params.groups);
                        if (groups !== undefined) job.groups = groups;
                        const deliver = {};
                        if (params.toOwnerDm !== undefined) deliver.ownerDm = params.toOwnerDm;
                        if (params.toEachGroup !== undefined) deliver.eachGroup = params.toEachGroup;
                        if (params.toGroups !== undefined) deliver.groups = Array.isArray(params.toGroups) ? params.toGroups : [params.toGroups];
                        if (Object.keys(deliver).length) job.deliver = deliver;

                        const saved = await runAction('report-job-save', { job });
                        // Đọc lại NGAY và trả về state thật, để model không phải tự tin vào lời mình.
                        const after = await runAction('report-jobs', {});
                        const result = { ok: true, saved: saved?.job || saved, jobs: after?.jobs || [] };
                        await logRun('zalo_mod_reports', params, result);
                        return ok(result);
                    } catch (err) {
                        await logRun('zalo_mod_reports', params, { ok: false, error: err.message });
                        return fail(err.message);
                    }
                },
            },
            {
                name: 'zalo_mod_tasks',
                label: 'Zalo Mod — việc tồn đọng (kanban)',
                description: [
                    'Xem / duyệt / từ chối / đổi cột việc tồn đọng — TƯƠNG ĐƯƠNG trang "Công việc" (kanban) trên dashboard.',
                    'Dùng khi owner hỏi "nhóm X còn việc gì chưa xong", hoặc nói một việc cụ thể đã xong/đã duyệt/sai/nhiễu.',
                    // P15 (Kent chốt mở, đảo lại luật P4 "bot không có đường nào tới crm-task-*"): trước đây
                    // cố tình không cho bot chạm việc AI đề xuất, để tránh bot tự duyệt lén qua chat. Giờ owner
                    // muốn nói bằng lời cũng duyệt được — an toàn vẫn giữ vì owner PHẢI tự nói tên việc + nói rõ
                    // ý muốn (duyệt/từ chối/đổi cột), không phải bot tự quyết.
                    'Owner nói TÊN việc, không nói id — luôn dùng `title` để tool tự khớp gần đúng, ĐỪNG tự bịa ra',
                    'một id. Khớp ra NHIỀU HƠN MỘT việc thì tool trả `suggestions` — hỏi lại owner rõ hơn (kèm tên',
                    'nhóm vào `groups`) rồi gọi lại, TUYỆT ĐỐI không tự chọn đại một cái. Khớp ra 0 việc thì nói thật',
                    'là không tìm thấy, đừng suy ra là "đã xong" hay "đã có".',
                    'operation="status" chỉ đổi cột của việc ĐÃ duyệt (todo/doing/blocked/done) — việc còn ở',
                    '"Chờ xác nhận" (🤖 AI đề xuất) phải dùng operation="approve" (kèm `status` nếu muốn duyệt và',
                    'chuyển cột luôn trong một lượt).',
                    '"Từ chối" (reject) KHÔNG xoá dữ liệu, chỉ ẩn khỏi kanban/báo cáo — việc có thể tự quay lại',
                    '"Chờ xác nhận" sau 30 ngày nếu AI vẫn thấy owner nhắc lại, đó không phải lỗi.',
                    'TUYỆT ĐỐI không có thao tác xoá việc qua tool này — xoá dữ liệu khách chỉ làm được trên dashboard.',
                ].join(' '),
                parameters: TASKS_SCHEMA,
                execute: async (_toolCallId, params = {}) => {
                    const blocked = guard(requesterSenderId, hostSaysOwner);
                    if (blocked) return blocked;
                    const op = String(params.operation || '').trim();
                    // P15: audit phải ghi RÕ ai đứng sau một lượt qua chat, không chỉ 'ai' chung chung —
                    // sau này còn lần được vết "ai đã bảo bot đóng việc này".
                    const actor = `agent:${requesterSenderId || 'unknown'}`;
                    try {
                        const all = await groupsSnapshot();
                        const groupNameOf = (gid) => all.find((g) => g.groupId === gid)?.name || gid;

                        let scopedGroupIds = null;
                        if (params.groups !== undefined) {
                            const { matched, unresolved, ambiguous } = resolveGroupTargets(params.groups, all);
                            if (ambiguous.length) return fail('Tên nhóm chưa rõ — hỏi lại owner chọn nhóm nào.', { ambiguous, unresolved });
                            if (!matched.length) return fail('Không tìm thấy nhóm nào khớp. Gọi zalo_mod_groups để xem tên nhóm đúng.', { unresolved });
                            scopedGroupIds = new Set(matched);
                        }

                        // Nguồn dữ liệu DUY NHẤT: đúng action dashboard dùng cho kanban, không tự query CRM
                        // riêng — không thể lệch với những gì owner đang thấy trên màn hình.
                        const board = await runAction('crm-tasks-board', {}, actor);
                        const flat = [];
                        for (const [col, arr] of Object.entries(board?.columns || {})) {
                            for (const task of (arr || [])) flat.push({ ...task, _col: col });
                        }
                        const inScope = scopedGroupIds ? flat.filter((t) => scopedGroupIds.has(t.group_id)) : flat;
                        const toView = (t) => ({
                            id: t.id, title: t.title, status: t._col, groupId: t.group_id,
                            groupName: groupNameOf(t.group_id), assignee: t.assignee || null,
                            note: t.note || null, dueAt: isoDate(t.due_at), source: t.source,
                        });

                        if (op === 'list') {
                            const wantStatus = params.status;
                            const rows = inScope.filter((t) => (wantStatus ? t._col === wantStatus : t._col !== 'done'));
                            const result = ok({
                                ok: true, total: rows.length, tasks: rows.map(toView),
                                note: '`status` là CỘT kanban thật (pending_review/todo/doing/blocked/done) — báo đúng giá trị này, đừng suy diễn.',
                            });
                            await logRun('zalo_mod_tasks', params, result);
                            return result;
                        }
                        if (!['status', 'approve', 'reject'].includes(op)) {
                            return fail(`operation "${op}" không hợp lệ. Dùng: list | status | approve | reject.`);
                        }

                        // Xác định đúng MỘT việc: theo id nếu owner/model đã biết chắc, không thì khớp title.
                        let target = null;
                        if (params.id) {
                            target = flat.find((t) => t.id === params.id);
                            if (!target) return fail(`Không có việc nào id "${params.id}". Gọi operation="list" để xem lại.`);
                        } else {
                            const title = String(params.title || '').trim();
                            if (!title) return fail('Thiếu `title` (hoặc `id`) — cần biết ĐÚNG việc nào trước khi đổi.');
                            const folded = foldGroupName(title);
                            const exact = inScope.filter((t) => foldGroupName(t.title) === folded);
                            // Dùng lại đúng bộ khớp theo TỪNG TỪ của P3b (`tokenMatchGroupName`) — hàm chỉ so
                            // chuỗi thuần, không riêng cho tên nhóm, nên áp được luôn cho tên việc.
                            const pool = exact.length ? exact : inScope.filter((t) => tokenMatchGroupName(t.title, title));
                            if (!pool.length) {
                                return fail(`Không tìm thấy việc nào khớp "${title}". Gọi operation="list" để xem tên đúng — đừng suy ra là đã xong.`, {
                                    known: inScope.slice(0, 20).map((t) => t.title),
                                });
                            }
                            if (pool.length > 1) {
                                return fail(`Khớp "${title}" ra ${pool.length} việc — chưa rõ là việc nào.`, {
                                    suggestions: pool.map(toView),
                                    note: 'Hỏi lại owner chọn đúng việc nào (có thể kèm tên nhóm vào `groups` để thu hẹp), hoặc gọi lại kèm `id` lấy từ đây. KHÔNG được tự chọn.',
                                });
                            }
                            [target] = pool;
                        }

                        if (op === 'status') {
                            const status = String(params.status || '').trim();
                            if (!['todo', 'doing', 'blocked', 'done'].includes(status)) {
                                return fail('operation="status" cần `status` là todo|doing|blocked|done. Muốn duyệt từ "Chờ xác nhận" thì dùng operation="approve".');
                            }
                            const raw = await runAction('crm-task-status', { id: target.id, status }, actor);
                            const result = ok({ ok: true, task: raw });
                            await logRun('zalo_mod_tasks', params, result);
                            return result;
                        }
                        if (op === 'approve') {
                            const status = params.status !== undefined ? String(params.status).trim() : undefined;
                            if (status !== undefined && !['todo', 'doing', 'blocked', 'done'].includes(status)) {
                                return fail('`status` kèm operation="approve" chỉ nhận todo|doing|blocked|done.');
                            }
                            const raw = status
                                ? await runAction('crm-task-approve-move', { id: target.id, status }, actor)
                                : await runAction('crm-task-approve', { id: target.id }, actor);
                            const result = ok({ ok: true, task: raw });
                            await logRun('zalo_mod_tasks', params, result);
                            return result;
                        }
                        // reject
                        const raw = await runAction('crm-task-reject', { id: target.id }, actor);
                        const result = ok({
                            ok: true, task: raw,
                            note: 'Đã ẩn khỏi kanban/báo cáo, KHÔNG xoá dữ liệu — có thể tự quay lại "Chờ xác nhận" sau 30 ngày nếu AI thấy lại việc này.',
                        });
                        await logRun('zalo_mod_tasks', params, result);
                        return result;
                    } catch (err) {
                        const result = fail(err.message);
                        await logRun('zalo_mod_tasks', params, result);
                        return result;
                    }
                },
            },
            {
                name: 'zalo_mod_action',
                label: 'Zalo Mod — chạy action của dashboard',
                // Mô tả tool LUÔN nằm trong prompt, còn SKILL.md là progressive-disclosure (model phải chủ
                // động mở mới đọc). Bug thật: owner nhờ đổi giờ lịch báo cáo hai lần, model không mở skill
                // nên không biết `report-job-save` tồn tại, chỉ gọi mấy action ĐỌC rồi báo "đã đổi xong"
                // trong khi lịch không đổi. Vì vậy tên action ghi + hình dạng payload của những việc hay
                // được nhờ phải nằm NGAY ĐÂY, không để trong skill.
                description: [
                    'Chạy đúng những action mà mỗi nút trên dashboard Zalo Mod gọi.',
                    'Gọi action="list-actions" để xem danh sách đầy đủ được phép.',
                    '',
                    'ĐỌC: report-jobs (danh sách lịch báo cáo + danh sách nhóm), journal-data, get-templates,',
                    'get-group-info, get-permissions, generate-summary.',
                    '',
                    'GHI — dùng ĐÚNG action này, đừng truyền field cấu hình vào action đọc (sẽ bị từ chối):',
                    '• Lịch báo cáo: report-job-save, payload { job: { id, time, kind, groups, deliver } } —',
                    '  chỉ cần id + field muốn đổi. VD đổi giờ: { job: { id: "job-x", time: "09:00" } }.',
                    '  Nơi nhận: deliver { ownerDm, eachGroup, groups: ["Tên nhóm"] }. kind: "digest" | "group".',
                    '  groups: "*" (tất cả nhóm follow) hoặc mảng tên nhóm/groupId.',
                    '• Template (nội quy/welcome/menu…): save-templates, payload { key, content }; đọc key hợp lệ',
                    '  bằng get-templates.',
                    '• Thao tác Zalo khác (đổi tên nhóm, ảnh nhóm, phó nhóm, poll…): zalo-api,',
                    '  payload { action: "rename-group", params: { … } }.',
                    '',
                    'BẮT BUỘC: chỉ được nói với owner là đã thay đổi SAU KHI action GHI trả về ok. Nếu chưa gọi',
                    'action ghi, hoặc nó trả lỗi, thì phải nói thẳng là chưa làm được kèm lý do — tuyệt đối không',
                    'suy ra thành công từ một action đọc.',
                    '',
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
                    const blocked = guard(requesterSenderId, hostSaysOwner);
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
        if (!isTrustedOwnerContext(toolContext, getOwnerIds())) {
            // KHÔNG được im lặng. Trả [] mà không log là thứ đã tốn nhiều giờ chẩn đoán: bot mất tool,
            // rồi tự ứng biến (dùng cron, trả lời bằng ký ức), còn log thì trống trơn nên trông y như
            // model bịa. Một dòng warn là đủ để lần sau grep ra ngay.
            logger?.warn?.('[openclaw-zalo-mod] KHÔNG cấp agent tool: người gửi không phải owner'
                + ` — requesterSenderId=${requesterSenderId || '(host không cấp)'}`
                + ` senderIsOwner=${toolContext?.senderIsOwner === undefined ? '(host không cấp)' : toolContext.senderIsOwner}`
                + ` ownerId đã cấu hình=[${[...getOwnerIds()].join(', ') || '(chưa set)'}]`
                + ` sessionKey=${toolContext?.sessionKey || '-'}`);
            return [];
        }
        return buildTools(requesterSenderId, toolContext?.senderIsOwner === true);
    };
}
