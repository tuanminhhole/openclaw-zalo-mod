/**
 * Phân loại action của zalo-connect để bot gọi được qua passthrough `zalo-api`.
 *
 * BỐI CẢNH: zalo-connect phơi ~141 action (zca-js), zalo-mod chỉ bọc lại 43 → owner nhờ bot "đổi tên
 * nhóm" thì bot trả lời không làm được, đúng sự thật vì nó không có tay. Bridge đã có `executeAction`
 * nên chỉ cần MỘT cửa có kiểm soát thay vì bọc tay từng action.
 *
 * DENY-BY-DEFAULT là điều kiện bắt buộc của cửa đó: action nào không có trong bảng này thì bot không
 * gọi được. Nhờ vậy zalo-connect thêm API mới ở bản sau sẽ KHÔNG tự động lọt ra cho bot — phải có
 * người đọc và xếp hạng nó trước.
 *
 * Ba mức:
 *   READ        — chỉ đọc, không đổi gì.
 *   WRITE       — đổi state nhưng làm lại/hoàn tác được (đổi tên nhóm, gửi tin, tạo poll…).
 *   DESTRUCTIVE — không hoàn tác được hoặc phá quan hệ. Mặc định TẮT với bot, owner bật bằng
 *                 `agentTools.allowDestructive` — cùng công tắc mà kick/block/leave đang dùng.
 *
 * Giới hạn theo plan KHÔNG nằm ở đây. Nó do `assertActionAllowed` quyết (Free = xem + thao tác lẻ,
 * PRO = hàng loạt), áp cho cả dashboard lẫn bot ở cùng một chỗ: `runDashboardAction`.
 */

/** Chỉ đọc — an toàn cho mọi plan, không đổi gì trên Zalo. */
export const CONNECT_READ_ACTIONS = Object.freeze([
    // Nhóm
    'groups', 'get-group-info', 'get-group-members-info', 'get-group-link', 'get-group-blocked',
    'get-pending-members', 'get-group-chat-history', 'get-group-invites',
    // Bạn bè & người dùng
    'friends', 'get-user-info', 'find-user', 'find-user-by-username', 'check-friend-status',
    'get-friend-requests', 'get-sent-requests', 'get-close-friends', 'get-online-friends',
    'get-friend-recommendations', 'get-related-friend-groups', 'get-alias-list',
    'get-multi-users-by-phones', 'last-online', 'get-friend-board',
    // Hồ sơ tài khoản bot
    'me', 'status', 'get-qr', 'get-avatar-list', 'get-full-avatar', 'get-biz-account', 'get-settings',
    // Hội thoại
    'get-archived-chats', 'get-hidden-conversations', 'get-pinned-conversations', 'get-unread-marks',
    'get-mute-status', 'get-auto-delete-chats',
    // Xin Zalo đẩy lịch sử chat về (WS cmd 510/511). Xếp READ vì nó không đổi gì trên Zalo — chỉ
    // yêu cầu gửi lại dữ liệu đã có. Tin cũ về qua sự kiện `old_messages` riêng nên không thể chạm
    // tới đường dispatch của model.
    'request-old-messages',
    // Nội dung
    'get-poll-detail', 'get-boards', 'get-labels', 'list-reminders', 'get-reminder',
    'get-reminder-responses', 'list-quick-messages', 'list-auto-replies', 'get-catalogs',
    'get-products', 'list-passive-groups',
    // Block/access — chỉ liệt kê
    'list-blocked', 'list-allowed', 'list-blocked-in-group', 'list-allowed-in-group',
    // Tiện ích
    'parse-link', 'search-stickers', 'search-sticker-detail',
]);

/** Đổi state nhưng hoàn tác/làm lại được. */
export const CONNECT_WRITE_ACTIONS = Object.freeze([
    // Quản trị nhóm — đây là nhóm owner hỏi nhiều nhất (đổi tên, ảnh, cài đặt, phó nhóm)
    'rename-group', 'change-group-avatar', 'update-group-settings',
    'add-group-admin', 'remove-group-admin',
    'enable-group-link', 'disable-group-link', 'create-group',
    'review-pending-members', 'add-to-group', 'group-mention',
    'block-group-member', 'unblock-group-member',
    'allow-user-in-group', 'unallow-user-in-group', 'block-user-in-group', 'unblock-user-in-group',
    // Nhắn tin
    'send', 'send-image', 'send-file', 'send-video', 'send-voice', 'send-sticker', 'send-card',
    'send-link', 'send-styled', 'send-bank-card', 'send-typing', 'send-to-stranger',
    'forward-message', 'add-reaction', 'delete-message', 'undo-message',
    // Hội thoại
    'pin-conversation', 'mute-conversation', 'hide-conversation', 'mark-unread',
    'update-archived-chat', 'set-auto-delete-chat',
    // Nội dung
    'create-poll', 'add-poll-options', 'vote-poll', 'lock-poll', 'share-poll',
    'create-note', 'edit-note',
    'create-reminder', 'edit-reminder', 'remove-reminder',
    'add-quick-message', 'update-quick-message', 'remove-quick-message',
    'create-auto-reply', 'update-auto-reply', 'delete-auto-reply',
    'create-catalog', 'create-product',
    // Hồ sơ bot
    'update-profile', 'update-profile-bio', 'change-avatar', 'reuse-avatar', 'update-active-status',
    'update-setting',
    // Bạn bè — thêm/sửa quan hệ, còn gỡ được
    'send-friend-request', 'accept-friend-request', 'reject-friend-request', 'undo-friend-request',
    'set-friend-nickname', 'remove-friend-nickname',
    // Lời mời nhóm
    'join-group-link', 'join-group-invite', 'delete-group-invite',
    // Lịch sử thụ động
    'recall-group-history',
]);

/**
 * Không hoàn tác được, hoặc phá quan hệ khách hàng. Mặc định TẮT với bot.
 *
 * Rủi ro ở đây không đối xứng: bot đọc sai MỘT câu là giải tán nhóm khách hoặc nhường quyền chủ
 * nhóm, không có nút hoàn tác, mà nhóm chính là quan hệ khách hàng. Owner nào cần thì bật
 * `agentTools.allowDestructive` một lần — PRO không bị chặn, chỉ là phải nói "tôi biết tôi đang làm gì".
 */
export const CONNECT_DESTRUCTIVE_ACTIONS = Object.freeze([
    'disperse-group',            // giải tán nhóm — mất sạch, không dựng lại được
    'change-group-owner',        // nhường quyền chủ nhóm — không tự lấy lại được
    'upgrade-group-to-community',// đổi loại nhóm, không hạ cấp lại được
    'leave-group', 'remove-from-group',
    'unfriend', 'block-user', 'unblock-user', 'zalo-block-user', 'zalo-unblock-user',
    'invite-to-groups',          // mời hàng loạt — dễ thành spam, dễ bị Zalo khoá tài khoản bot
    'delete-chat', 'delete-avatar',
    'send-report',               // báo cáo người dùng lên Zalo
]);

const READ = new Set(CONNECT_READ_ACTIONS);
const WRITE = new Set(CONNECT_WRITE_ACTIONS);
const DESTRUCTIVE = new Set(CONNECT_DESTRUCTIVE_ACTIONS);

/**
 * Tham số mang danh sách nhiều đích. Đây là chỗ luật plan bám vào: cùng một action, một đích thì Free
 * làm được, nhiều đích là hàng loạt → PRO. Tên tham số theo đúng zca-js/zalo-connect.
 */
export const CONNECT_MULTI_TARGET_KEYS = Object.freeze([
    'threadIds', 'groupIds', 'userIds', 'memberIds', 'members', 'targets', 'uids', 'phoneNumbers',
]);

/** Số đích mà một lời gọi passthrough nhắm tới — dùng để suy ra hạng plan cần thiết. */
export function connectTargetCount(params = {}) {
    let max = 0;
    for (const key of CONNECT_MULTI_TARGET_KEYS) {
        const value = params?.[key];
        if (Array.isArray(value)) max = Math.max(max, value.filter(Boolean).length);
        else if (typeof value === 'string' && value.trim()) {
            max = Math.max(max, value.split(',').map((s) => s.trim()).filter(Boolean).length);
        }
    }
    return max;
}

/**
 * Bot có được gọi action zalo-connect này không.
 * Không nằm trong bảng → CHẶN, kèm lý do nói rõ là chưa xếp hạng (không phải "sai tên").
 */
export function classifyConnectAction(action, { allowDestructive = false } = {}) {
    const name = String(action || '').trim();
    if (!name) return { allowed: false, reason: 'Thiếu tên action zalo-connect.' };
    if (READ.has(name)) return { allowed: true, kind: 'read' };
    if (WRITE.has(name)) return { allowed: true, kind: 'write' };
    if (DESTRUCTIVE.has(name)) {
        return allowDestructive
            ? { allowed: true, kind: 'destructive' }
            : {
                allowed: false,
                reason: `Action "${name}" không hoàn tác được nên bot đang bị chặn. Owner bật bằng cách đặt agentTools.allowDestructive = true trong config zalo-mod, hoặc tự làm trên dashboard.`,
            };
    }
    return {
        allowed: false,
        reason: `Action "${name}" chưa được xếp hạng an toàn cho bot. Nếu cần, thêm nó vào src/agent/connect-actions.js rồi phát hành lại.`,
    };
}

/** Danh sách bot được phép gọi — cho `list-actions` trả về cho model. */
export function listConnectActions({ allowDestructive = false } = {}) {
    return {
        read: [...CONNECT_READ_ACTIONS],
        write: [...CONNECT_WRITE_ACTIONS],
        destructive: allowDestructive ? [...CONNECT_DESTRUCTIVE_ACTIONS] : [],
        destructiveLocked: allowDestructive ? [] : [...CONNECT_DESTRUCTIVE_ACTIONS],
    };
}
