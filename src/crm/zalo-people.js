/**
 * Gộp mọi nguồn dữ liệu người Zalo mà plugin ĐÃ CÓ thành một danh sách giàu trường
 * để import vào CRM.
 *
 * Vì sao cần module riêng, và vì sao nó THUẦN (không đọc file, không gọi API):
 * - Ba nguồn nằm ba chỗ khác nhau — `group-members.json` (ai ở nhóm nào),
 *   `zalo-profiles-cache.json` (ngày sinh + sđt, do job sync nền ghi), và danh sách bạn bè
 *   (`get-friends`). Việc gộp là logic thật, có nhiều ca lệch, nên phải test được mà không
 *   cần dựng server.
 * - Bản import cũ dựng danh sách ở TRÌNH DUYỆT từ `state.members`, nên chỉ có tên + avatar:
 *   hồ sơ giàu trường nằm ở đĩa phía server, trình duyệt không thấy. Đó là lý do bảng
 *   contacts đầy bản ghi trống trường dù dữ liệu đã có sẵn.
 */

/** Zalo trả sđt lúc `+84…`, lúc `84…`, lúc có khoảng trắng/dấu chấm. Chuẩn hoá về `0…`. */
export function normalizePhone(raw) {
    if (raw == null) return '';
    const digits = String(raw).trim().replace(/[^+0-9]/g, '');
    if (!digits) return '';
    if (digits.startsWith('+84')) return `0${digits.slice(3)}`;
    if (digits.startsWith('84') && digits.length >= 10) return `0${digits.slice(2)}`;
    return digits;
}

/**
 * Zalo trả giới tính lúc là số (0/1), lúc là chuỗi. Không đoán bừa: kiểu lạ → `null`.
 * Một bản ghi trống thì owner còn biết là chưa có; đoán sai thì lọc ra kết quả sai mà
 * không ai phát hiện.
 */
export function normalizeGender(raw) {
    if (raw == null || raw === '') return null;
    if (raw === 0 || raw === '0') return 'male';
    if (raw === 1 || raw === '1') return 'female';
    const v = String(raw).trim().toLowerCase();
    if (['male', 'm', 'nam'].includes(v)) return 'male';
    if (['female', 'f', 'nu', 'nữ'].includes(v)) return 'female';
    return null;
}

/**
 * Tách ngày/tháng từ chuỗi ngày sinh thô của Zalo (`sdob`).
 *
 * Trả `{ day, month }` — CỐ Ý bỏ năm: cái owner cần là "sinh nhật sắp tới", mà nhiều hồ sơ
 * Zalo giấu năm hoặc điền năm rác (1900). Không parse được thì trả `null` thay vì đoán.
 *
 * Nhập nhằng `05/06`: hai số đều <= 12 nên không có cách nào biết chắc. Chọn DD/MM (quy ước
 * Việt Nam) vì nguồn là Zalo VN — ghi rõ ở đây để không ai đọc code rồi tưởng là lỗi.
 */
export function birthdayDayMonth(raw) {
    if (raw == null || raw === '') return null;
    const str = String(raw).trim();
    // ISO `YYYY-MM-DD` (có thể kèm giờ) — năm đứng trước nên không nhập nhằng.
    const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(str);
    if (iso) {
        const month = Number(iso[2]);
        const day = Number(iso[3]);
        return validDayMonth(day, month);
    }
    // `DD/MM/YYYY`, `DD-MM`, `DD/MM` — hai số đầu là ngày rồi tháng.
    const vn = /^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?$/.exec(str);
    if (vn) {
        let day = Number(vn[1]);
        let month = Number(vn[2]);
        // Số đầu > 12 thì chắc chắn là ngày; số sau > 12 thì chắc chắn phải hoán lại.
        if (month > 12 && day <= 12) [day, month] = [month, day];
        return validDayMonth(day, month);
    }
    return null;
}

function validDayMonth(day, month) {
    if (!Number.isInteger(day) || !Number.isInteger(month)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { day, month };
}

/**
 * Số ngày từ `today` tới lần sinh nhật kế tiếp. `0` = đúng hôm nay.
 *
 * So theo ngày-tháng, không theo năm, và vòng qua giao thừa: 30/12 nhìn tới 02/01 phải ra 3
 * ngày chứ không phải âm. 29/02 trong năm không nhuận rơi về 01/03 thay vì biến mất.
 *
 * @param {{day:number,month:number}} dm
 * @param {Date} today
 */
export function daysUntilBirthday(dm, today) {
    if (!dm) return null;
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    for (let yearOffset = 0; yearOffset <= 1; yearOffset++) {
        const year = base.getFullYear() + yearOffset;
        const next = new Date(year, dm.month - 1, dm.day);
        // `new Date(2025, 1, 29)` tự trôi sang 01/03 — đúng thứ ta muốn cho 29/02.
        if (next < base) continue;
        return Math.round((next - base) / 86400000);
    }
    return null;
}

/**
 * @param {object} src
 * @param {Record<string, Record<string, any>>} src.memberDir `{ groupId: { uid: name|object } }`
 * @param {Record<string, any>} [src.profileCache] `{ uid: { displayName, avatar, sdob, phoneNumber, gender } }`
 * @param {Iterable<string>} [src.friendIds] uid của những người đã kết bạn
 * @param {(groupId: string) => string} [src.groupNameOf]
 * @returns {Array<{uid,name,avatar,phone,birthday,gender,isFriend,source,groups}>}
 */
export function buildZaloPeople({ memberDir, profileCache, friendIds, groupNameOf } = {}) {
    const dir = memberDir && typeof memberDir === 'object' ? memberDir : {};
    const profiles = profileCache && typeof profileCache === 'object' ? profileCache : {};
    // `null`/thiếu = KHÔNG BIẾT ai là bạn (gọi `get-friends` hỏng), khác hẳn với "danh sách rỗng".
    // Phân biệt hai ca này là bắt buộc: coi "không biết" thành "không phải bạn" sẽ khiến một lần
    // import lúc Zalo lỗi xoá sạch cờ bạn bè của toàn bộ khách đã có.
    const friendsKnown = friendIds != null;
    const friends = new Set([...(friendIds || [])].map(id => cleanUid(id)).filter(Boolean));
    const nameOfGroup = typeof groupNameOf === 'function' ? groupNameOf : (id) => id;

    const byUid = new Map();
    for (const groupId of Object.keys(dir)) {
        const users = dir[groupId];
        if (!users || typeof users !== 'object') continue;
        const groupName = String(nameOfGroup(groupId) || groupId);
        for (const [rawUid, rawMember] of Object.entries(users)) {
            const uid = cleanUid(rawUid);
            if (!uid) continue;
            const entry = byUid.get(uid) || newPerson(uid, rawMember, profiles[uid] || profiles[rawUid]);
            // Người không có tên ở đâu cả thì bỏ: contacts bắt buộc `displayName`, và một bản
            // ghi tên rỗng trong CRM không dùng được vào việc gì.
            if (!entry.name) continue;
            if (!entry.groups.some(g => g.groupId === groupId)) {
                entry.groups.push({ groupId, name: groupName });
            }
            byUid.set(uid, entry);
        }
    }

    // Bạn bè KHÔNG ở nhóm nào vẫn phải vào danh sách — họ là khách hàng thật, chỉ là nhắn
    // riêng. Bản import cũ chỉ quét member nhóm nên bỏ sót trọn nhóm người này.
    for (const uid of friends) {
        if (byUid.has(uid)) continue;
        const entry = newPerson(uid, null, profiles[uid]);
        if (!entry.name) continue;
        entry.source = 'zalo-friend';
        byUid.set(uid, entry);
    }

    for (const entry of byUid.values()) {
        entry.isFriend = friendsKnown ? friends.has(entry.uid) : undefined;
    }

    return [...byUid.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

/** Zalo gắn hậu tố `_0` vào uid ở một số response — cùng một người, hai chuỗi. */
function cleanUid(raw) {
    return String(raw ?? '').trim().replace(/_0$/, '');
}

function newPerson(uid, rawMember, profile) {
    const fromMember = typeof rawMember === 'string'
        ? { name: rawMember }
        : {
            name: rawMember?.name || rawMember?.displayName || rawMember?.dName || rawMember?.zaloName || '',
            avatar: rawMember?.avatar || rawMember?.avatarUrl || rawMember?.avatar_url || rawMember?.photo || '',
        };
    const p = profile || {};
    return {
        uid,
        // Hồ sơ đồng bộ từ Zalo mới hơn tên chép trong danh sách nhóm, nên nó thắng.
        name: String(p.displayName || fromMember.name || '').trim(),
        avatar: p.avatar || fromMember.avatar || '',
        phone: normalizePhone(p.phoneNumber || p.phone),
        birthday: String(p.sdob || p.dob || '').trim(),
        gender: normalizeGender(p.gender),
        isFriend: false,
        source: 'zalo-group',
        groups: [],
    };
}
