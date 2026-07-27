/**
 * Catalogue lệnh — NGUỒN SỰ THẬT DUY NHẤT.
 *
 * Trước đây bảng lệnh bị copy-paste ở 4 chỗ trong index.js (menu markdown,
 * SKILL.md workspace, owner panel DM, admin panel group) nên chắc chắn sẽ lệch
 * mỗi lần thêm lệnh. Mọi mặt tiền giờ render từ file này.
 *
 * `cmd` KHÔNG chứa prefix: prefix per-bot (`/minhkhang-`, `/william-`…) được
 * ghép lúc render. Các lệnh dùng prefix cố định `/` (mute/unmute) đặt
 * `bare: true`.
 */

/** Phạm vi nơi gõ được lệnh. */
export const SCOPE_GROUP = 'group';
export const SCOPE_DM = 'dm';

/** Nhóm lệnh theo quyền. Thứ tự ở đây là thứ tự hiển thị. */
export const COMMAND_SECTIONS = [
    {
        id: 'public',
        icon: '👤',
        label: 'Mọi người (trong group)',
        scope: SCOPE_GROUP,
        role: 'member',
        commands: [
            { cmd: 'noi-quy', desc: 'Xem nội quy nhóm' },
            { cmd: 'menu', desc: 'Danh sách lệnh' },
            { cmd: 'huong-dan', desc: 'Hướng dẫn sử dụng bot' },
        ],
    },
    {
        id: 'admin',
        icon: '🔧',
        label: 'Admin (trong group)',
        scope: SCOPE_GROUP,
        role: 'admin',
        commands: [
            { cmd: 'mute', bare: true, alias: ['tat-bot'], desc: 'Tắt bot hoàn toàn trong group này' },
            { cmd: 'unmute', bare: true, alias: ['bat-bot'], desc: 'Bật lại bot' },
            { cmd: 'warn', args: '@name [lý do]', desc: 'Cảnh cáo member' },
            { cmd: 'note', args: '[text]', desc: 'Ghi chú admin' },
            { cmd: 'report', desc: 'Báo cáo vi phạm + warn' },
            { cmd: 'memory', args: '[note]', desc: 'Lưu memory digest' },
            { cmd: 'history', args: '[ngày]', desc: 'Tổng hợp lịch sử chat của group (mặc định hôm nay)' },
        ],
    },
    {
        id: 'admin-rules',
        icon: '⚙️',
        label: 'Admin — cấu hình group đang đứng (trong group)',
        scope: SCOPE_GROUP,
        role: 'admin',
        commands: [
            { cmd: 'rules', desc: 'Xem panel cấu hình' },
            { cmd: 'rules status', desc: 'Cấu hình group hiện tại' },
            { cmd: 'rules silent-on', desc: 'Bật silent (chỉ reply khi @tag hoặc gọi tên)' },
            { cmd: 'rules silent-off', desc: 'Tắt silent mode' },
            { cmd: 'rules welcome-on', desc: 'Bật chào member mới' },
            { cmd: 'rules welcome-off', desc: 'Tắt chào member mới' },
            { cmd: 'rules follow-on', alias: ['rules tracking-on'], desc: 'Bật theo dõi nhóm (ghi lịch sử chat + memory)' },
            { cmd: 'rules follow-off', alias: ['rules tracking-off'], desc: 'Tắt theo dõi nhóm' },
            { cmd: 'rules groupid', desc: 'Thêm group này vào config' },
            { cmd: 'rules groupid-list', desc: 'Danh sách group đang quản lý' },
            { cmd: 'rules groupid-add-all', desc: 'Thêm mọi group bot đang ở vào config' },
        ],
    },
    {
        id: 'owner',
        icon: '👑',
        label: 'Owner — điều khiển từ xa qua DM riêng',
        scope: SCOPE_DM,
        role: 'owner',
        commands: [
            { cmd: 'rules mute-list', desc: 'Trạng thái mute mọi group' },
            { cmd: 'rules mute', args: '<groupId> on/off', desc: 'Mute/unmute group cụ thể' },
            { cmd: 'rules mute all', args: 'on/off', desc: 'Mute/unmute tất cả group' },
            { cmd: 'rules silent-list', desc: 'Trạng thái silent mọi group' },
            { cmd: 'rules silent', args: '<groupId> on/off', desc: 'Silent group cụ thể' },
            { cmd: 'rules silent all', args: 'on/off', desc: 'Silent tất cả group' },
            { cmd: 'rules welcome-list', desc: 'Trạng thái welcome mọi group' },
            { cmd: 'rules welcome', args: '<groupId> on/off', desc: 'Welcome group cụ thể' },
            { cmd: 'rules welcome all', args: 'on/off', desc: 'Welcome tất cả group' },
            { cmd: 'rules tracking-list', desc: 'Trạng thái tracking mọi group' },
            { cmd: 'rules tracking', args: '<groupId> on/off', desc: 'Tracking group cụ thể' },
            { cmd: 'rules tracking all', args: 'on/off', desc: 'Tracking tất cả group' },
            { cmd: 'rules follow-list', desc: 'Trạng thái follow (memory) mọi group' },
            { cmd: 'rules follow', args: '<groupId> on/off', desc: 'Follow group cụ thể' },
            { cmd: 'rules follow all', args: 'on/off', desc: 'Follow tất cả group' },
            { cmd: 'rules dm-list', desc: 'DM whitelist' },
            { cmd: 'rules dm-add', args: '<tên member>', desc: 'Thêm vào DM whitelist' },
            { cmd: 'rules dm-remove', args: '<tên member>', desc: 'Xóa khỏi DM whitelist' },
            { cmd: 'rules groupid-list', desc: 'Danh sách tất cả group' },
            { cmd: 'rules groupid-add', args: '<groupId>', desc: 'Thêm group từ xa' },
            { cmd: 'rules groupid-add-all', desc: 'Thêm mọi group bot đang ở' },
            { cmd: 'rules status', desc: 'Tổng quan cấu hình bot' },
            { cmd: 'ownerid', desc: 'Xem/đặt owner ID' },
            { cmd: 'kich-hoat', alias: ['active-key'], args: '<license key>', desc: 'Kích hoạt license (dùng được cả trong group)' },
        ],
    },
];

/** Bảng sub-lệnh `/rules` gom theo tính năng — dùng cho panel owner trong DM. */
export const RULES_PANEL_SECTIONS = [
    { icon: '🔇', label: 'Mute (tắt bot hoàn toàn)', key: 'mute' },
    { icon: '🔕', label: 'Silent Mode (chỉ reply khi tag/gọi tên)', key: 'silent' },
    { icon: '🎉', label: 'Welcome (chào mem mới)', key: 'welcome' },
    { icon: '📋', label: 'Tracking (ghi lịch sử chat)', key: 'tracking' },
    { icon: '👁️', label: 'Follow (theo dõi chat + memory)', key: 'follow' },
];

/** Toggle per-group mà cả dashboard, slash và agent tool đều dùng chung. */
export const TOGGLE_KEYS = Object.freeze([
    'muted', 'silent', 'welcome', 'tracking', 'follow', 'pendingAuto', 'autoSummary',
]);

/** Nhãn tiếng Việt cho từng toggle — dùng khi bot báo lại cho owner. */
export const TOGGLE_LABELS = Object.freeze({
    muted: 'Mute (bot im lặng hoàn toàn)',
    silent: 'Silent (chỉ reply khi @tag hoặc gọi tên)',
    welcome: 'Welcome (chào member mới)',
    tracking: 'Tracking (ghi lịch sử chat)',
    follow: 'Follow (ghi lịch sử chat + memory)',
    pendingAuto: 'Tự động duyệt yêu cầu vào nhóm',
    autoSummary: 'Tự động tổng hợp cuối ngày',
});

/** Từ khoá tiếng Việt/Anh → toggle key. Dùng để map ý định ngôn ngữ tự nhiên. */
export const TOGGLE_ALIASES = Object.freeze({
    mute: 'muted', muted: 'muted', 'tat-bot': 'muted', 'tắt bot': 'muted',
    silent: 'silent', 'im lang': 'silent', 'chi tag': 'silent',
    welcome: 'welcome', 'chao mung': 'welcome',
    tracking: 'tracking', 'ghi lich su': 'tracking',
    follow: 'follow', 'theo doi': 'follow',
    pendingauto: 'pendingAuto', 'duyet vao nhom': 'pendingAuto',
    autosummary: 'autoSummary', 'tong hop': 'autoSummary', 'tong hop cuoi ngay': 'autoSummary',
});

/** Ghép prefix cho một entry. `bare` → luôn `/cmd`. */
export function formatCommand(entry, cmdPrefix) {
    const head = entry.bare ? `/${entry.cmd}` : `${cmdPrefix}${entry.cmd}`;
    return entry.args ? `${head} ${entry.args}` : head;
}

/** Mọi biến thể gõ được của một entry (kể cả alias). */
export function commandVariants(entry, cmdPrefix) {
    const names = [entry.cmd, ...(entry.alias || [])];
    return names.map((name) => formatCommand({ ...entry, cmd: name }, cmdPrefix));
}

/** Bảng markdown đầy đủ — dùng cho SKILL.md và tài liệu. */
export function renderCommandMarkdown(cmdPrefix, opts = {}) {
    const sections = COMMAND_SECTIONS.filter((s) => !opts.sections || opts.sections.includes(s.id));
    const out = [];
    for (const section of sections) {
        out.push(`### ${section.icon} ${section.label}`, '', '| Lệnh | Mô tả |', '|------|-------|');
        for (const entry of section.commands) {
            const variants = commandVariants(entry, cmdPrefix).map((v) => `\`${v}\``).join(' / ');
            out.push(`| ${variants} | ${entry.desc} |`);
        }
        out.push('');
    }
    return out.join('\n');
}

/** Panel plain-text cho Zalo (Zalo không render markdown). */
export function renderCommandPanel(cmdPrefix, sectionIds, title) {
    const sections = COMMAND_SECTIONS.filter((s) => sectionIds.includes(s.id));
    const out = [title, '━━━━━━━━━━━━━━━━━━'];
    for (const section of sections) {
        out.push('', `${section.icon} ${section.label}:`);
        for (const entry of section.commands) {
            out.push(`  ${commandVariants(entry, cmdPrefix).join(' / ')}  — ${entry.desc}`);
        }
    }
    return out.join('\n');
}

/** Panel `/rules` gọn cho owner: nhóm theo tính năng thay vì liệt kê phẳng. */
export function renderRulesPanel(cmdPrefix) {
    const out = [`🔐 OWNER PANEL — ${cmdPrefix}rules`, '━━━━━━━━━━━━━━━━━━'];
    for (const s of RULES_PANEL_SECTIONS) {
        out.push(
            '',
            `${s.icon} ${s.label}:`,
            `  ${cmdPrefix}rules ${s.key}-list`,
            `  ${cmdPrefix}rules ${s.key} <groupId> on/off`,
            `  ${cmdPrefix}rules ${s.key} all on/off`,
        );
    }
    out.push(
        '', '💬 DM Whitelist:',
        `  ${cmdPrefix}rules dm-list`,
        `  ${cmdPrefix}rules dm-add <tên member>`,
        `  ${cmdPrefix}rules dm-remove <tên member>`,
        '', '🆔 Group:',
        `  ${cmdPrefix}rules groupid-list`,
        `  ${cmdPrefix}rules groupid-add <groupId>`,
        `  ${cmdPrefix}rules groupid-add-all`,
        '', `📊 ${cmdPrefix}rules status`,
    );
    return out.join('\n');
}

/** Danh sách phẳng mọi lệnh (dùng cho tool `zalo_mod_action` action `list-commands`). */
export function listAllCommands(cmdPrefix) {
    const out = [];
    for (const section of COMMAND_SECTIONS) {
        for (const entry of section.commands) {
            out.push({
                section: section.id,
                role: section.role,
                scope: section.scope,
                command: formatCommand(entry, cmdPrefix),
                aliases: commandVariants(entry, cmdPrefix).slice(1),
                description: entry.desc,
            });
        }
    }
    return out;
}
