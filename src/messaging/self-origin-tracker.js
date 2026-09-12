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
 * Mention đầu câu phải cắt vì mỗi chặng viết nó một kiểu:
 *   - payload OpenClaw gửi xuống:  `Dạ anh Kent, …`  hoặc  `@[Kent] Dạ anh Kent, …`
 *   - tin quay về từ Zalo:          `@Kent Dạ anh Kent, …`  (zalo-connect gắn mention native,
 *                                    MỘT khoảng trắng - bản đầu đòi hai nên trượt sạch)
 * Đo thật trên máy khách 13/09/2026: mọi câu trả lời trong nhóm đều bị gán nhầm "Tự gõ" vì chỗ này.
 *
 * Không đoán được tên dài mấy chữ, nên thay vì cắt cho "đúng", sinh NHIỀU biến thể rồi khớp biến
 * thể nào cũng được: rẻ, và sai sót chỉ làm mất nhãn chứ không gán nhãn bừa.
 */
const MENTION_BRACKET = /^\s*@\[[^\]]{1,60}\]\s*/;

/** Bỏ `@Tên` đầu câu với `n` từ trong tên (1..5), dùng để sinh biến thể. */
function stripLeadingMentionWords(text, words) {
    const re = new RegExp(`^\\s*@[^\\s]+(?:\\s+[^\\s]+){0,${words - 1}}\\s+`);
    return text.replace(re, '');
}

function normalize(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .slice(0, 400);
}

/** Vân tay chính: nguyên văn đã chuẩn hoá. */
export function fingerprint(text) {
    return normalize(text);
}

/**
 * Mọi cách viết có thể có của CÙNG một câu, để hai đầu gặp nhau ở ít nhất một biến thể.
 * Luôn gồm bản nguyên văn; nếu câu mở đầu bằng `@` thì thêm các bản đã cắt mention.
 */
export function fingerprintVariants(text) {
    const base = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!base) return [];
    const out = new Set();
    const push = (t) => { const fp = normalize(t); if (fp) out.add(fp); };
    push(base);
    push(base.replace(MENTION_BRACKET, ''));
    if (base.startsWith('@')) for (let w = 1; w <= 5; w += 1) push(stripLeadingMentionWords(base, w));
    return [...out];
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
        /** @type {Map<string, object[]>} vân tay -> các dấu đang chờ mang vân tay đó */
        this.pending = new Map();
        /** @type {object[]} mọi dấu đang chờ, cũ trước mới sau (để dọn và chặn trên) */
        this.entries = [];
    }

    /**
     * Ghi nhận "bot vừa gửi câu này". Gọi từ hook reply_payload_sending và từ adapter.
     * Nhận thêm các bản viết khác của cùng câu (trước/sau khi gắn mention) - tất cả trỏ về MỘT dấu,
     * nên khớp bản nào thì cả nhóm cùng bị tiêu, không để lại dấu thừa gán nhầm cho tin sau.
     */
    remember(...texts) {
        const fps = new Set();
        for (const t of texts.flat()) for (const fp of fingerprintVariants(t)) fps.add(fp);
        if (!fps.size) return false;
        this.sweep();
        const entry = { at: this.now(), fps: [...fps] };
        for (const fp of entry.fps) {
            const list = this.pending.get(fp) || [];
            list.push(entry);
            this.pending.set(fp, list);
        }
        this.entries.push(entry);
        // Quá tải thì bỏ dấu CŨ NHẤT: nó ít khả năng còn đang trên đường nhất.
        while (this.entries.length > this.max) this._drop(this.entries[0]);
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
        this.sweep();
        for (const fp of fingerprintVariants(text)) {
            const list = this.pending.get(fp);
            if (!list?.length) continue;
            this._drop(list[0]);
            return 'bot';
        }
        return 'human';
    }

    /** Gỡ một dấu khỏi mọi biến thể của nó. */
    _drop(entry) {
        if (!entry) return;
        for (const fp of entry.fps) {
            const list = this.pending.get(fp);
            if (!list) continue;
            const i = list.indexOf(entry);
            if (i >= 0) list.splice(i, 1);
            if (!list.length) this.pending.delete(fp);
        }
        const i = this.entries.indexOf(entry);
        if (i >= 0) this.entries.splice(i, 1);
    }

    /** Dọn dấu quá hạn. */
    sweep() {
        const cutoff = this.now() - this.ttlMs;
        for (const entry of [...this.entries]) if (entry.at < cutoff) this._drop(entry);
    }

    get size() {
        return this.entries.length;
    }
}
