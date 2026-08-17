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
export function slug(text) {
    return String(text ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

/**
 * @param {object} p
 * @param {Array<{id, dedupe_key, source, status}>} p.existing task hiện có của ĐÚNG group này (mọi
 *        status/source) — chỉ cần 4 field trên, caller có thể truyền nguyên row DB.
 * @param {Array<{what:string, who:string, due:string, state:string, evidence:string}>} p.items
 *        `openItems` (đã qua `normalizeOpenItems`) của ĐÚNG nhóm + ngày này.
 * @param {string} p.groupId
 * @param {string} p.date  `YYYY-MM-DD` — ngày báo cáo đang xử lý.
 * @returns {{insert:Array, update:Array, close:Array, skipped:Array}}
 */
export function reconcileOpenItems({ existing, items, groupId, date }) {
    const insert = [];
    const update = [];
    const close = [];
    const skipped = [];

    const byKey = new Map();
    for (const t of existing || []) {
        if (t?.dedupe_key) byKey.set(t.dedupe_key, t);
    }

    // Một ngày có thể có 2 câu nói ra CÙNG một việc (owner nhắc lại) — gộp trong vòng lặp bằng
    // `seenKeys`, không thì item thứ hai lại tưởng "chưa có" vì cái đầu chưa kịp vào `byKey`.
    const seenKeys = new Set();

    for (const raw of items || []) {
        const what = String(raw?.what ?? '').trim();
        if (!what) continue; // parse rỗng — không có gì để đối soát, bỏ qua im lặng
        const dedupeKey = slug(what);
        if (!dedupeKey || seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);

        const current = byKey.get(dedupeKey);

        if (current && current.source === 'manual') {
            skipped.push({ dedupeKey, what, reason: 'trùng dedupe_key với việc gõ tay — AI không được chạm' });
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

        // current.source === 'ai' từ đây — việc AI đã từng thấy trước đó, hôm nay thấy lại.
        if (raw.state === 'done') {
            close.push({ id: current.id, dedupeKey });
        } else {
            // pending/blocked: chỉ làm mới `last_seen_date`, KHÔNG đụng `status` — status là của
            // review/kanban (người duyệt), không để tín hiệu AI một ngày lật qua lật lại.
            update.push({ id: current.id, dedupeKey, lastSeenDate: date });
        }
    }

    return { insert, update, close, skipped };
}
