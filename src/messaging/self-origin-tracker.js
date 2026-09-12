/**
 * Phân biệt tin do BOT gửi với tin CHỦ MÁY tự gõ - cả hai đều đi ra từ cùng một tài khoản Zalo.
 *
 * Vì sao cần: bot Zalo cá nhân dùng chính tài khoản của khách. Khi zalo-connect nhặt tin về, tin
 * bot viết và tin người gõ trên điện thoại giống hệt nhau (cùng sender_id, cùng from_self=1).
 * Trước bản này, muốn biết "câu đó ai viết" phải mở log gateway soi xem có lượt gọi model quanh
 * mốc đó không - làm được, nhưng chỉ người có SSH mới làm nổi, và log thì xoay vòng.
 *
 * Cách làm: OpenClaw phát `reply_payload_sending` ngay TRƯỚC khi gửi, kèm nguyên văn payload. Ghi
 * vân tay nội dung đó vào sổ chờ; lát nữa tin quay về qua bridge thì đối chiếu. Khớp là 'bot',
 * không khớp là 'human'.
 *
 * Vì sao so nội dung chứ không so messageId: payload lúc gửi CHƯA có id - id do Zalo cấp khi tin
 * đã nằm trên server, và bridge trả về đường khác. Nội dung là thứ duy nhất hai đầu cùng thấy.
 */

/**
 * Mention đầu câu phải cắt vì HAI đầu viết nó khác nhau:
 *   - payload lúc gửi:  `@[Nhung Vn] dạ chị…`   (dạng đánh dấu của OpenClaw/zalo-mod)
 *   - tin lúc quay về:  `@Nhung Vn  dạ chị…`    (zalo-connect đã render thành mention native)
 * Không cắt thì mọi câu trả lời trong nhóm đều trượt khớp và bị gán nhầm là người gõ tay.
 */
const MENTION_BRACKET = /^\s*@\[[^\]]{1,60}\]\s*/;
const MENTION_RENDERED = /^\s*@[^\s]+(\s+[^\s]+){0,4}\s{2,}/;

function stripMentionPrefix(text) {
    let t = text;
    // Nhiều mention liền nhau vẫn có thể xảy ra; cắt tối đa 3 lần rồi dừng để không ăn vào nội dung.
    for (let i = 0; i < 3; i += 1) {
        const next = t.replace(MENTION_BRACKET, '').replace(MENTION_RENDERED, '');
        if (next === t) break;
        t = next;
    }
    return t;
}

/** Chuẩn hoá để hai đầu so được: bỏ khoảng trắng thừa, hạ chữ thường, cắt mention đầu câu. */
export function fingerprint(text) {
    let t = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!t) return '';
    t = stripMentionPrefix(t);
    // Zalo cắt tin quá dài; so 400 ký tự đầu là đủ phân biệt mà không vỡ vì phần đuôi bị cắt.
    return t.replace(/\s+/g, ' ').toLowerCase().slice(0, 400);
}

export class SelfOriginTracker {
    /**
     * @param {object} [opts]
     * @param {number} [opts.ttlMs] giữ dấu bao lâu. Mặc định 10 phút: tin gửi đi thường quay về
     *   trong vài giây, nhưng lúc mạng chập hoặc zalo-connect nối lại thì có thể trễ vài phút.
     * @param {number} [opts.max] chặn trên số dấu giữ cùng lúc, phòng rò bộ nhớ khi bridge im.
     */
    constructor({ ttlMs = 10 * 60_000, max = 500, now = () => Date.now() } = {}) {
        this.ttlMs = ttlMs;
        this.max = max;
        this.now = now;
        /** @type {Map<string, number[]>} vân tay -> danh sách mốc gửi (cùng câu gửi nhiều lần) */
        this.pending = new Map();
    }

    /** Ghi nhận "bot vừa gửi câu này". Gọi từ hook reply_payload_sending. */
    remember(text) {
        const fp = fingerprint(text);
        if (!fp) return false;
        this.sweep();
        const list = this.pending.get(fp) || [];
        list.push(this.now());
        this.pending.set(fp, list);
        // Quá tải thì bỏ dấu CŨ NHẤT: tin cũ nhất là tin ít có khả năng còn đang trên đường nhất.
        if (this.pending.size > this.max) {
            const oldest = [...this.pending.entries()].sort((a, b) => a[1][0] - b[1][0])[0];
            if (oldest) this.pending.delete(oldest[0]);
        }
        return true;
    }

    /**
     * Tin từ tài khoản này vừa quay về - của bot hay của người?
     *
     * Dấu khớp bị TIÊU khi dùng: gửi cùng một câu hai lần thì phải có hai dấu, nếu không lần thứ
     * hai (người gõ lại y hệt) sẽ bị gán nhầm là bot.
     *
     * @returns {'bot'|'human'}
     */
    claim(text) {
        const fp = fingerprint(text);
        if (!fp) return 'human';
        this.sweep();
        const list = this.pending.get(fp);
        if (!list?.length) return 'human';
        list.shift();
        if (!list.length) this.pending.delete(fp);
        return 'bot';
    }

    /** Dọn dấu quá hạn. */
    sweep() {
        const cutoff = this.now() - this.ttlMs;
        for (const [fp, list] of this.pending) {
            const kept = list.filter((t) => t >= cutoff);
            if (kept.length) this.pending.set(fp, kept);
            else this.pending.delete(fp);
        }
    }

    get size() {
        let n = 0;
        for (const list of this.pending.values()) n += list.length;
        return n;
    }
}
