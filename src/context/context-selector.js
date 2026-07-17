/**
 * ContextSelector — chọn snapshot bounded từ ConversationBuffer khi bot được tag.
 *
 * Mặc định theo product plan §6.2:
 *   - tối đa 20 tin, tuổi tối đa 15 phút
 *   - ưu tiên burst liền mạch gần nhất của người kích hoạt
 *   - kèm tối đa 5 tin xung quanh từ người khác
 *   - dừng tại reply thực chất gần nhất của bot (trừ khi tin sau đó nối tiếp chủ đề
 *     — heuristic: mọi tin sau bot reply đều được xét, tin trước bot reply bị cắt)
 *   - loại slash command và tin điều hành nội bộ
 *   - dedupe đã do buffer đảm nhiệm (edit thay thế)
 */

export const DEFAULT_SELECTOR_OPTIONS = Object.freeze({
    maxMessages: 20,
    maxAgeMs: 15 * 60 * 1000,
    maxOthers: 5,
    slashPrefixes: ['/', '!', '.'],
});

/**
 * @param {Array<object>} records buffer records (cũ → mới), record cuối thường là tin kích hoạt
 * @param {object} params
 * @param {string} params.triggerSenderId
 * @param {string} [params.triggerMessageId] để luôn giữ tin kích hoạt
 * @param {number} [params.now]
 * @param {object} [opts] override DEFAULT_SELECTOR_OPTIONS
 * @returns {Array<object>} snapshot records (cũ → mới)
 */
export function selectContext(records, params, opts = {}) {
    const o = { ...DEFAULT_SELECTOR_OPTIONS, ...opts };
    const now = params.now ?? Date.now();
    const triggerSenderId = String(params.triggerSenderId ?? '');

    // 1) Lọc tuổi + loại slash command / tin nội bộ.
    let pool = records.filter((r) => {
        if (now - r.timestamp > o.maxAgeMs) return false;
        if (r.rawType === 'internal' || r.rawType === 'moderation') return false;
        const trimmed = (r.text || '').trimStart();
        if (r.messageId !== params.triggerMessageId
            && o.slashPrefixes.some(p => trimmed.startsWith(p))) return false;
        return true;
    });

    // 2) Cắt tại reply thực chất gần nhất của bot (giữ tin sau nó).
    let lastBotIdx = -1;
    for (let i = pool.length - 1; i >= 0; i--) {
        if (pool[i].fromBot && pool[i].botSubstantiveReply) { lastBotIdx = i; break; }
    }
    if (lastBotIdx >= 0) pool = pool.slice(lastBotIdx + 1);

    // 3) Ưu tiên: toàn bộ tin của trigger sender + tối đa maxOthers tin của người khác
    //    (chọn các tin người-khác GẦN NHẤT để giữ mạch hội thoại).
    const othersIdx = [];
    for (let i = 0; i < pool.length; i++) {
        if (pool[i].senderId !== triggerSenderId && !pool[i].fromBot) othersIdx.push(i);
    }
    const allowedOthers = new Set(othersIdx.slice(-o.maxOthers));
    let selected = pool.filter((r, i) =>
        r.senderId === triggerSenderId || r.fromBot || allowedOthers.has(i));

    // 4) Budget số tin: giữ các tin MỚI nhất, nhưng không bao giờ rơi tin kích hoạt.
    if (selected.length > o.maxMessages) {
        selected = selected.slice(-o.maxMessages);
    }
    if (params.triggerMessageId
        && !selected.some(r => r.messageId === params.triggerMessageId)) {
        const trigger = records.find(r => r.messageId === params.triggerMessageId);
        if (trigger) selected = [...selected.slice(-(o.maxMessages - 1)), trigger];
    }
    return selected;
}
