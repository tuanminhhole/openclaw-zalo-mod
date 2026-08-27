/**
 * Ghép lại ảnh đã tải về với tin nhắn đã mất link.
 *
 * OpenClaw tải sẵn ảnh về `<home>/.openclaw/media/{inbound,outbound}` và đặt tên theo mốc thời gian
 * (`2026-08-21T12-03-47-zalo-<hash>.jpg`). Trước bản vá P17, đường bắt tin trực tiếp đánh rơi link
 * nên `media_json` là NULL — chữ "[Media attachment]" trơ ra dù ẢNH VẪN CÒN TRÊN ĐĨA.
 *
 * Hàm này nối hai thứ đó lại bằng thời gian.
 *
 * 🔴 Luật quan trọng: **chỉ nhận ghép 1-1**. Trong cửa sổ ±N giây mà có nhiều hơn một tệp thì BỎ QUA,
 * không đoán. Gán nhầm ảnh của người này sang tin của người khác trong một khung chat CRM là hỏng
 * nặng hơn nhiều so với việc thiếu một tấm ảnh.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEN_TEP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/;
const DUOI_HOP_LE = /\.(jpg|jpeg|png|gif|webp|mp4|pdf)$/i;

/** Đọc kho media, trả về [{ url, t }] với `t` là mốc thời gian lấy từ TÊN TỆP. */
export function docKhoMedia(openclawHome, kinds = ['inbound', 'outbound']) {
    const out = [];
    for (const kind of kinds) {
        const dir = join(openclawHome, '.openclaw', 'media', kind);
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
            const m = TEN_TEP.exec(f);
            if (!m || !DUOI_HOP_LE.test(f)) continue;
            const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
            if (Number.isNaN(t)) continue;
            out.push({ url: `/media/${kind}/${encodeURIComponent(f)}`, t, kind });
        }
    }
    return out;
}

/**
 * @returns {{ quet: number, ghep: number, boQuaNhapNhang: number, khongCo: number }}
 */
export function ghepLaiMedia(storage, openclawHome, { toleranceMs = 5000, limit = 5000, dryRun = false } = {}) {
    const kho = docKhoMedia(openclawHome);
    const tin = storage.messagesWithoutMedia?.(limit) || [];
    let ghep = 0, boQuaNhapNhang = 0, khongCo = 0;

    for (const t of tin) {
        const sentAt = Number(t.sent_at) || 0;
        // Tin của chính bot thì ảnh nằm ở `outbound`, tin người khác ở `inbound` — lọc theo đúng
        // hướng để bớt hẳn nhập nhằng khi bot và khách gửi ảnh gần như cùng lúc.
        const huong = t.from_self ? 'outbound' : 'inbound';
        const ungVien = kho.filter((m) => m.kind === huong && Math.abs(m.t - sentAt) <= toleranceMs);
        if (ungVien.length === 0) { khongCo++; continue; }
        if (ungVien.length > 1) { boQuaNhapNhang++; continue; }
        if (dryRun) { ghep++; continue; }
        if (storage.setMessageMedia?.(t.id, [ungVien[0].url])) ghep++;
    }
    return { quet: tin.length, ghep, boQuaNhapNhang, khongCo };
}
