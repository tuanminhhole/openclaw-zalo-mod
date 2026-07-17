/**
 * MentionBuilder — dựng payload group-mention native của ZaloConnect.
 *
 * Nguyên tắc: UID lấy CHÍNH XÁC từ TurnContext của lượt đang trả lời.
 * Không parse text tìm tên, không dùng "người gửi gần nhất".
 *
 * Reply policy:
 *   - 'sender'        : mention đúng người đã tag bot (mặc định)
 *   - 'quoted-author' : mention tác giả tin được quote (khi có yêu cầu rõ)
 *   - 'all-addressed' : mention những user được bot NÊU ĐÍCH DANH trong câu trả lời
 *                       (caller truyền addressedUsers đã resolve UID)
 *   - 'off'           : không mention tự động
 */

const POLICIES = new Set(['sender', 'quoted-author', 'all-addressed', 'off']);

/**
 * @param {object} turn TurnContext của lượt trả lời (immutable)
 * @param {string} responseText nội dung bot trả lời (chưa gắn mention)
 * @param {object} [opts]
 * @param {'sender'|'quoted-author'|'all-addressed'|'off'} [opts.policy='sender']
 * @param {Array<{uid:string, displayName:string}>} [opts.addressedUsers] cho policy all-addressed
 * @returns {{message: string, mentions: Array<{uid:string, displayName:string, offset:number, length:number}>}}
 */
export function buildMentionPayload(turn, responseText, opts = {}) {
    const policy = opts.policy || 'sender';
    if (!POLICIES.has(policy)) throw new Error(`Unknown mention policy: ${policy}`);
    const text = String(responseText ?? '').trim();

    if (policy === 'off') return { message: text, mentions: [] };

    let targets = [];
    if (policy === 'sender') {
        targets = [{ uid: turn.senderId, displayName: turn.senderName || '' }];
    } else if (policy === 'quoted-author') {
        if (turn.quotedSenderId) {
            targets = [{ uid: turn.quotedSenderId, displayName: opts.quotedAuthorName || '' }];
        } else {
            // Không có quote → fallback an toàn về sender, không đoán mò.
            targets = [{ uid: turn.senderId, displayName: turn.senderName || '' }];
        }
    } else if (policy === 'all-addressed') {
        // Chỉ mention user caller đã resolve UID rõ ràng. Không bao giờ tự
        // quét toàn bộ context để mention hàng loạt.
        targets = (opts.addressedUsers || []).filter(u => u && u.uid);
        if (targets.length === 0) {
            targets = [{ uid: turn.senderId, displayName: turn.senderName || '' }];
        }
    }

    // Loại target thiếu uid (không bao giờ gửi mention rỗng/sai).
    targets = targets.filter(t => t.uid != null && String(t.uid).length > 0)
        .map(t => ({ uid: String(t.uid), displayName: t.displayName || '' }));
    if (targets.length === 0) return { message: text, mentions: [] };

    // Ghép "@Tên " vào đầu message; tính offset/length theo UTF-16 code unit
    // (chuẩn zca-js). Nếu displayName rỗng, dùng placeholder từ uid để offset hợp lệ.
    const parts = [];
    const mentions = [];
    let cursor = 0;
    for (const t of targets) {
        const label = `@${t.displayName || t.uid}`;
        parts.push(label);
        mentions.push({ uid: t.uid, displayName: t.displayName || t.uid, offset: cursor, length: label.length });
        cursor += label.length + 1; // +1 khoảng trắng phân cách
    }
    const prefix = parts.join(' ');
    const message = text.length > 0 ? `${prefix} ${text}` : prefix;
    return { message, mentions };
}

/** Payload hoàn chỉnh cho action group-mention của ZaloConnect. */
export function buildGroupMentionAction(turn, responseText, opts = {}) {
    const { message, mentions } = buildMentionPayload(turn, responseText, opts);
    return {
        action: 'group-mention',
        threadId: turn.groupId || turn.conversationId,
        message,
        mentions,
        // Quote tin đã kích hoạt lượt này khi runtime hỗ trợ.
        quoteMessageId: opts.quote === false ? undefined : turn.inboundMessageId,
    };
}
