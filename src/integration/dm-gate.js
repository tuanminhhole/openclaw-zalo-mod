/**
 * Cổng phân quyền DM chạy SỚM, ngay tại `onInbound` của bridge zalo-connect.
 *
 * Vì sao cần chặn ở đây chứ không chỉ ở `before_dispatch`: zalo-connect thả reaction tự động
 * (`messages.ackReaction`) TRƯỚC khi gọi dispatch của OpenClaw, còn `before_dispatch` chạy bên
 * trong dispatch. Nên một người không được phép DM vẫn nhận tim dù bot im lặng - khách thấy bot
 * "đã xem, đã thả tim" mà không trả lời (vps_trang-alisa 21/10/2026). Bridge inbound thì chạy
 * trước bước thả reaction, và trả `{ handled: true }` ở đó khiến zalo-connect dừng hẳn tin này.
 *
 * Cố ý chỉ chặn đúng những tin mà `before_dispatch` cũng sẽ chặn. Hai ngoại lệ phải để lọt:
 *   - owner của bot nhận tin;
 *   - lệnh nhận chủ ("im owner <DEVICE_ID>", "/<prefix>ownerid"...) - bot phải trả lời được
 *     người chưa có quyền, nếu nuốt ở đây thì không ai đăng ký owner được nữa.
 * `before_dispatch` vẫn giữ nguyên cổng cũ làm lưới an toàn cho đường không đi qua bridge.
 */

const CLAIM_WORDS = 'im owner|iam owner|i am owner|im admin|iam admin|i am admin';

/** Tin có phải lệnh nhận chủ không - cùng mẫu với nhánh claim trong `handleZaloDispatch`. */
export function isOwnerClaimText(text, cmdPrefix = '/') {
    const prefixEsc = String(cmdPrefix || '/').replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const claimRe = new RegExp(`^(?:${prefixEsc}owner(?:id)?|${CLAIM_WORDS})(?:\\s+(\\S+))?$`, 'i');
    return claimRe.test(String(text || '').replace(/['’]/g, '').trim());
}

/**
 * Quyết định có chặn sớm một DM hay không.
 *
 * @param {object} p
 * @param {string} p.senderId
 * @param {string} [p.senderName]   tên kèm theo sự kiện (DM của Zalo thường chỉ có id)
 * @param {string} [p.text]
 * @param {string} [p.ownerId]      owner của bot nhận tin
 * @param {string} [p.cmdPrefix]
 * @param {string} [p.mode]         permissions.dm.mode hiện hành
 * @param {(id: string, name: string) => boolean} p.isDmAllowed
 * @param {(id: string) => Promise<string>} [p.resolveName]  tra tên thật, chỉ gọi khi mode cần danh sách
 * @returns {Promise<{ block: boolean, name: string }>}
 */
export async function decideEarlyDmBlock(p) {
    const senderId = String(p.senderId || '');
    let name = String(p.senderName || '').trim();
    if (!senderId) return { block: false, name };
    if (p.ownerId && senderId === String(p.ownerId)) return { block: false, name };
    if (isOwnerClaimText(p.text, p.cmdPrefix)) return { block: false, name };
    if (p.isDmAllowed(senderId, name)) return { block: false, name };
    // DM của Zalo không kèm tên và id khác nhau theo từng bot, nên danh sách cho phép còn khớp theo
    // tên hiển thị. Tra tên thật rồi thử lại, y như `before_dispatch`.
    if ((p.mode === 'list' || p.mode === 'friends') && typeof p.resolveName === 'function') {
        const realName = String((await p.resolveName(senderId)) || '').trim();
        if (realName) {
            name = realName;
            if (p.isDmAllowed(senderId, realName)) return { block: false, name };
        }
    }
    return { block: true, name };
}
