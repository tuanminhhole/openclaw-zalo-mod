/**
 * Đối soát TẤT ĐỊNH giữa `openItems` rút từ báo cáo NGÀY (đã qua `normalizeOpenItems` ở index.js) và
 * bảng `tasks` đã có — hàm THUẦN, không I/O, không LLM, theo đúng khuôn `zalo-people.js`. Ghi DB là
 * việc của caller (`crm-store.js`); hàm này chỉ QUYẾT ĐỊNH ghi gì, để test được không cần dựng DB.
 *
 * Luật cứng (Kent chốt 18/08, xem `thiet-ke-bao-cao-kanban.md`): AI KHÔNG BAO GIỜ được xoá hoặc tự
 * đóng việc `source='manual'` — trùng `dedupe_key` với việc gõ tay thì bỏ qua và báo trong `skipped`.
 * Việc `todo` không xuất hiện lại trong `openItems` một ngày nào đó KHÔNG được tự đổi trạng thái —
 * hàm này chỉ xử lý những gì CÓ trong `items`, task cũ không khớp thì đơn giản là không đụng tới.
 */

/**
 * `đ` không phải dấu tổ hợp nên NFD không tách được — cùng cách `foldName` của `zalo-people.js` xử lý.
 */
function foldNoDiacritics(text) {
    return String(text ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/đ/g, 'd');
}

export function slug(text) {
    return foldNoDiacritics(text)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

/**
 * Từ nối câu không mang nghĩa "việc gì" — loại trước khi so để bắt được các câu diễn đạt khác nhau
 * cho CÙNG một việc (P10, đo thật 18/08: "Ngủ sớm hơn" · "Kết thúc công việc sớm hơn và ngủ sớm hơn"
 * · "Kết thúc công việc sớm hơn để ngủ sớm" — 3 câu, ít nhất 2 câu sau phải gộp làm một).
 * CỐ Ý không đưa danh từ ("việc", "công việc"…) vào đây — mất từ mang nghĩa mới là bịa, không phải
 * chuẩn hoá.
 */
const STOPWORDS = new Set([
    'hon', 'de', 'va', 'vao', 'dung', 'la', 'cua', 'cho', 'cac', 'nhung', 'nay', 'do', 'roi',
    'se', 'da', 'dang', 'rat', 'cung', 'thi', 'ma', 'duoc', 'bi', 'mot', 'lai', 'nua', 'them',
    'nen', 'phai', 'can', 'voi', 'khi', 'sau', 'truoc',
]);

/**
 * Khoá "ngữ nghĩa" — mức RẺ, không phải NLP thật: bỏ dấu, bỏ stopword, SẮP TỪ rồi ghép lại. Bắt được
 * đổi thứ tự từ hoặc thêm/bớt một từ nối, KHÔNG bắt được câu diễn đạt khác hẳn từ vựng cho cùng ý
 * (đó là giới hạn đã biết, "làm mức rẻ trước" theo đúng đề bài — không phải bug).
 */
export function fuzzyKey(text) {
    const tokens = foldNoDiacritics(text)
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((t) => !STOPWORDS.has(t));
    if (!tokens.length) return '';
    return [...tokens].sort().join('-');
}

/**
 * P14: "Từ chối" là BIA MỘ (`review_state='rejected'`, dòng + `dedupe_key` vẫn giữ nguyên — không
 * `DELETE`), nên AI thấy lại việc đã bị từ chối thì phải BỎ QUA, không tạo lại/update. Bia mộ hết
 * hiệu lực sau 30 ngày (`updated_at` — mốc lúc từ chối, vì reject chỉ đổi đúng field đó) — một việc
 * bị từ chối hôm nay có thể là việc thật sau một tháng, khoá vĩnh viễn là bịa quyết định thay người.
 */
export const REJECT_TOMBSTONE_DAYS = 30;

function daysSince(sinceMs, dateStr) {
    const runMs = new Date(`${dateStr}T00:00:00Z`).getTime();
    return (runMs - (Number(sinceMs) || 0)) / 86400000;
}

/**
 * @param {object} p
 * @param {Array<{id, title, dedupe_key, source, status, review_state, updated_at}>} p.existing task
 *        hiện có của ĐÚNG group này (mọi status/source) — `title` dùng để so khớp NGỮ NGHĨA (P10),
 *        `review_state`/`updated_at` dùng để nhận diện + tính hiệu lực bia mộ (P14). Không lưu thêm
 *        cột nào, tính lại mỗi lần gọi nên KHÔNG cần migration. Thiếu `title` thì chỉ so được theo
 *        `dedupe_key` cũ; thiếu `updated_at` thì coi bia mộ như đã hết hiệu lực (an toàn hơn khoá mãi).
 * @param {Array<{what:string, who:string, due:string, state:string, evidence:string}>} p.items
 *        `openItems` (đã qua `normalizeOpenItems`) của ĐÚNG nhóm + ngày này.
 * @param {string} p.groupId
 * @param {string} p.date  `YYYY-MM-DD` — ngày báo cáo đang xử lý.
 * @returns {{insert:Array, update:Array, close:Array, skipped:Array, revive:Array}}
 */
export function reconcileOpenItems({ existing, items, groupId, date }) {
    const insert = [];
    const update = [];
    const close = [];
    const skipped = [];
    const revive = [];

    const byKey = new Map();
    const byFuzzyKey = new Map();
    for (const t of existing || []) {
        if (t?.dedupe_key) byKey.set(t.dedupe_key, t);
        // P10 (4): tính key ngữ nghĩa SONG SONG với dedupe_key cũ — không đổi cách lưu, không cần
        // migration, không mất liên kết với việc đã có (dedupe_key cột vẫn y nguyên).
        if (t?.title) {
            const fk = fuzzyKey(t.title);
            if (fk && !byFuzzyKey.has(fk)) byFuzzyKey.set(fk, t);
        }
    }

    // Một ngày có thể có 2 câu nói ra CÙNG một việc (owner nhắc lại) — gộp trong vòng lặp bằng
    // `seenKeys`/`seenFuzzyKeys`, không thì item thứ hai lại tưởng "chưa có" vì cái đầu chưa kịp
    // vào `byKey`.
    const seenKeys = new Set();
    const seenFuzzyKeys = new Set();

    for (const raw of items || []) {
        const what = String(raw?.what ?? '').trim();
        if (!what) continue; // parse rỗng — không có gì để đối soát, bỏ qua im lặng
        const dedupeKey = slug(what);
        const fuzzy = fuzzyKey(what);
        if (!dedupeKey || seenKeys.has(dedupeKey) || (fuzzy && seenFuzzyKeys.has(fuzzy))) continue;
        seenKeys.add(dedupeKey);
        if (fuzzy) seenFuzzyKeys.add(fuzzy);

        // Khớp CHÍNH XÁC trước (hành vi cũ, không đổi); không thấy mới thử khớp NGỮ NGHĨA — tránh
        // chuyện một việc đã khớp đúng key cũ lại bị đổi sang match ngữ nghĩa lỏng hơn không cần thiết.
        const current = byKey.get(dedupeKey) || (fuzzy ? byFuzzyKey.get(fuzzy) : undefined);

        if (current && current.source === 'manual') {
            skipped.push({ dedupeKey, what, reason: 'trùng dedupe_key với việc gõ tay — AI không được chạm' });
            continue;
        }

        if (current && current.review_state === 'rejected') {
            const age = daysSince(current.updated_at, date);
            if (age <= REJECT_TOMBSTONE_DAYS) {
                skipped.push({
                    dedupeKey, what,
                    reason: `đã bị từ chối ${Math.max(0, Math.floor(age))} ngày trước — bia mộ còn hiệu lực (${REJECT_TOMBSTONE_DAYS} ngày), AI không tự tạo lại`,
                });
                continue;
            }
            // Hết hiệu lực bia mộ: cho việc quay lại, nhưng vẫn phải qua "Chờ xác nhận" lại từ đầu —
            // KHÔNG tự coi là đã duyệt, một tháng im lặng không phải sự đồng ý ngầm.
            revive.push({ id: current.id, dedupeKey: current.dedupe_key || dedupeKey, lastSeenDate: date });
            continue;
        }

        if (!current) {
            insert.push({
                title: what,
                assignee: String(raw?.who ?? '').trim(),
                note: raw?.due ? `Hạn: ${raw.due}` : '',
                groupId,
                source: 'ai',
                status: 'todo',
                reviewState: 'pending',
                dedupeKey,
                evidence: String(raw?.evidence ?? '').trim(),
                firstSeenDate: date,
                lastSeenDate: date,
            });
            continue;
        }

        // current.source === 'ai' từ đây — việc AI đã từng thấy trước đó (khớp key cũ hoặc khớp ngữ
        // nghĩa), hôm nay thấy lại dưới một cách diễn đạt có thể khác.
        if (raw.state === 'done') {
            close.push({ id: current.id, dedupeKey: current.dedupe_key || dedupeKey });
        } else {
            // pending/blocked: chỉ làm mới `last_seen_date`, KHÔNG đụng `status` — status là của
            // review/kanban (người duyệt), không để tín hiệu AI một ngày lật qua lật lại.
            update.push({ id: current.id, dedupeKey: current.dedupe_key || dedupeKey, lastSeenDate: date });
        }
    }

    return { insert, update, close, skipped, revive };
}
