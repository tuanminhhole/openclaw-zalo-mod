/**
 * UI dev server — chạy dashboard + CRM API THẬT (SQLite) không cần OpenClaw gateway.
 *
 *   node tests/helpers/ui-dev-server.mjs [port] [dbPath]
 *
 * - Serve index.html / dashboard.js / dashboard.css / logo.png từ repo root.
 * - POST /api/action: action `crm-*` đi vào src/crm thật; action khác trả stub rỗng.
 * - GET /api/state: state stub tối thiểu (license PRO + vài member Zalo mẫu để
 *   test nút "Import từ Zalo").
 * - Token: 'openclaw-zalo-mod' (mặc định của dashboard).
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/storage/database.js';
import { CrmStore } from '../../src/crm/crm-store.js';
import { handleCrmAction } from '../../src/crm/crm-api.js';
import { buildZaloPeople } from '../../src/crm/zalo-people.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.argv[2]) || 19791;
const DB_PATH = process.argv[3] || path.join(os.tmpdir(), 'zalo-mod-crm-dev.db');
const TOKEN = 'openclaw-zalo-mod';

// Fixture cho trang "Lịch báo cáo" — vài nhóm + 2 lịch để xem UI ở cả hai kiểu.
// Lịch sử báo cáo đã gửi — đủ đa dạng để thử mọi trục lọc: 2 loại, 2 lịch, nhiều nhóm, có bản
// "Gửi thử", có bản nhiều phần, và trải nhiều ngày để lọc theo thời gian có tác dụng.
const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const dstr = (n) => dayAgo(n).slice(0, 10);
const DEV_REPORT_SENT = [
    { id: 's1', jobId: 'job-1', jobName: 'Tổng hợp ASA cuối ngày', kind: 'digest', reportFor: 'yesterday',
      date: dstr(1), time: '08:00', trigger: 'schedule', sentAt: dayAgo(0), sentDate: dstr(0),
      scope: [{ groupId: 'g1', name: 'Vọc Tech Không Cọc' }, { groupId: 'g2', name: 'ASA 7881 - [ORDER TQ] ME ME' }],
      targets: [{ type: 'group', id: 'g4', name: 'ASACHINA ZALO' }], chars: 420,
      texts: ['📊 TỔNG HỢP ' + dstr(1) + ' · 2 nhóm · 39 tin\n\n📋 Vọc Tech Không Cọc — 10 tin\n  • Cần kiểm tra mã vận đơn 1371101854581 tại kho.\n\n📋 ASA 7881 — 4 tin\n  • Phí ship thanh toán gộp một lượt.'] },
    { id: 's2', jobId: 'job-2', jobName: 'Nội bộ — báo cáo lẻ', kind: 'group', reportFor: 'today',
      date: dstr(0), time: '18:00', trigger: 'manual', sentAt: dayAgo(0), sentDate: dstr(0),
      scope: [{ groupId: 'g3', name: 'ASA Điều hành' }],
      targets: [{ type: 'dm', id: 'o1', name: 'DM owner' }], chars: 160,
      texts: ['📋 ASA Điều hành — ' + dstr(0) + '\n  • Chốt lịch họp tuần.'] },
    { id: 's3', jobId: 'job-1', jobName: 'Tổng hợp ASA cuối ngày', kind: 'digest', reportFor: 'yesterday',
      date: dstr(4), time: '08:00', trigger: 'schedule', sentAt: dayAgo(3), sentDate: dstr(3),
      scope: [{ groupId: 'g5', name: '237.KẾ TOÁN ASA-VNLOGS' }],
      targets: [{ type: 'group', id: 'g4', name: 'ASACHINA ZALO' }], chars: 300,
      texts: ['📊 TỔNG HỢP ' + dstr(4) + ' · phần 1', '📊 TỔNG HỢP ' + dstr(4) + ' · phần 2 (tiếp)'] },
    { id: 's4', jobId: 'job-1', jobName: 'Tổng hợp ASA cuối ngày', kind: 'digest', reportFor: 'yesterday',
      date: dstr(21), time: '08:00', trigger: 'schedule', sentAt: dayAgo(20), sentDate: dstr(20),
      scope: [{ groupId: 'g6', name: 'ASA Thiên Hà- AS2741' }],
      targets: [{ type: 'group', id: 'g4', name: 'ASACHINA ZALO' }], chars: 90,
      texts: ['📊 TỔNG HỢP ' + dstr(21) + ' · 1 nhóm · 5 tin'] },
];

const DEV_REPORT_JOBS = {
    jobs: [
        { id: 'job-1', name: 'Tổng hợp ASA cuối ngày', enabled: true, kind: 'digest', groups: '*', time: '22:30',
          deliver: { ownerDm: true, eachGroup: false, groups: [] }, resolvedCount: 6 },
        { id: 'job-2', name: 'Nội bộ — báo cáo lẻ', enabled: false, kind: 'group', groups: ['g1', 'g2'], time: '18:00',
          deliver: { ownerDm: false, eachGroup: true, groups: ['g3'] }, resolvedCount: 2 },
    ],
    groups: [
        { groupId: 'g1', name: 'Vọc Tech Không Cọc' },
        { groupId: 'g2', name: 'ASA 7881 - [ORDER TQ] ME ME' },
        { groupId: 'g3', name: 'ASA Điều hành' },
        { groupId: 'g4', name: 'ASACHINA ZALO' },
        { groupId: 'g5', name: '237.KẾ TOÁN ASA-VNLOGS' },
        { groupId: 'g6', name: 'ASA Thiên Hà- AS2741' },
    ],
    state: { 'job-1': { date: '2026-07-29', time: '22:30' } },
};

const store = openStore(DB_PATH, { logger: console });
if (store.kind !== 'sqlite') {
    console.error('Cần Node >= 22.5 (node:sqlite) để chạy CRM dev server.');
    process.exit(1);
}
const crm = new CrmStore(store.db);

// Vài hội thoại mẫu để khung chat có thứ mà vẽ: một DM hai chiều, một nhóm nhiều người, và một
// hội thoại rỗng (ca dễ vỡ nhất — hội thoại có trong danh sách mà chưa tin nào được đồng bộ).
(function seedChat() {
    if (store.listConversations({ limit: 1 }).length) return;
    const now = Date.now();
    const mk = (id, accountId, type, lastMessageAt) => store.upsertConversation({ id, accountId, type, lastMessageAt });
    const say = (conv, id, who, name, text, minsAgo, fromSelf = false, mediaUrls) => store.insertMessage({
        id, conversationId: conv, senderId: who, senderName: name, text,
        sentAt: now - minsAgo * 60000, fromSelf, mediaUrls, rawType: 'history',
    });

    mk('default|uid-1001', 'default', 'dm', now - 2 * 60000);
    say('default|uid-1001', 'd1', 'uid-1001', 'Nguyễn Văn An', 'Shop ơi, váy này còn size M không?', 40);
    say('default|uid-1001', 'd2', 'bot', 'DevBot', 'Dạ còn size M ạ, chị lấy giúp em nhé.', 38, true);
    say('default|uid-1001', 'd3', 'uid-1001', 'Nguyễn Văn An', 'Cho mình 2 cái nhé', 2);

    mk('default|group-demo', 'default', 'group', now - 15 * 60000);
    say('default|group-demo', 'g1', 'uid-1002', 'Trần Thị Bích', 'Đơn hôm nay gửi chưa mọi người?', 90);
    say('default|group-demo', 'g2', 'uid-1003', 'Lê Minh Châu', 'Gửi rồi nha, mã VD123', 60,
        false, ['https://example.invalid/anh-van-don.jpg']);
    say('default|group-demo', 'g3', 'bot', 'DevBot', 'Em ghi nhận mã VD123 vào sổ rồi ạ.', 15, true);

    mk('default|uid-9001', 'default', 'dm', now - 3 * 86400000);
})();

console.log(`[dev] CRM DB: ${DB_PATH}`);

const STATE_STUB = {
    ok: true,
    pluginVersion: '2.16.0',
    license: { isPro: true, canBulk: true, canMultiBot: true, tier: 'pro', plan: 'personal', expiry: '2026-08-18', isTrial: true },
    bot: { botName: 'DevBot', ownerId: '', ownerName: 'Owner', profile: 'default' },
    // HAI bot: nếu chỉ có một thì không bao giờ thấy được lỗi "bot này nhìn thấy liên hệ của bot
    // kia" và nhánh gộp trùng người cũng không chạy.
    // Đúng hình dạng bản thật trả về (`{ id, name, profile }`) — khai thiếu `id`/`name` thì
    // `getBotBadge` ném và giết luôn `renderState()`, làm mọi bộ lọc trông như "không chạy".
    bots: [
        { id: 'william', name: 'DevBot', profile: 'default', avatar: '' },
        { id: 'mkt', name: 'DevBot Mkt', profile: 'mkt', avatar: '' },
    ],
    // Có nhóm thật + người ở NHIỀU nhóm (uid-1002) để thử phần nối CRM ↔ nhóm.
    groups: [
        { groupId: 'group-demo', name: 'ASA 7881 - [ORDER TQ] ME ME', profile: 'default' },
        { groupId: 'group-kt', name: '237.KẾ TOÁN ASA-VNLOGS', profile: 'default' },
        { groupId: 'group-x3', name: 'X3 Diamond_ Gia đình Kim Cương X3', profile: 'default' },
        { groupId: 'group-mkt', name: 'MKT — Khách lẻ', profile: 'mkt' },
    ],
    friends: [], pendingByGroup: {}, warnings: {}, violations: {},
    members: {
        'group-demo': {
            'uid-1001': { name: 'Nguyễn Văn An', avatar: '' },
            'uid-1002': { name: 'Trần Thị Bích', avatar: '' },
            'uid-1003': { name: 'Lê Minh Châu', avatar: '' },
            'uid-1004': { name: 'Phạm Quốc Dũng', avatar: '' },
        },
        'group-kt': {
            'uid-1002': { name: 'Trần Thị Bích', avatar: '' },
            'uid-2001': { name: 'Đặng Đình Đạt', avatar: '' },
        },
        // Nhóm của bot `mkt`. `mkt-1001` CHÍNH LÀ Nguyễn Văn An ở trên nhưng mang uid khác — đúng
        // cách Zalo cấp id riêng cho từng tài khoản. Cùng sđt nên phải gộp thành một dòng ở chế độ
        // tất cả bot, và tuyệt đối không được hiện khi đang chọn bot `default`.
        'group-mkt': {
            'mkt-1001': { name: 'Nguyễn Văn An', avatar: '' },
            'mkt-9002': { name: 'Khách chỉ của Mkt', avatar: '' },
        },
    },
    settings: {}, permissions: {}, reports: [], apis: [], audit: [], templates: {},
    totals: { groups: 0, members: 0, warnings: 0, violations: 0 },
};

// Bản sao `zalo-profiles-cache.json` — thứ mà bản thật đọc từ đĩa gateway. Cố ý KHÔNG cho mọi
// người đủ trường: hồ sơ Zalo chỉ lộ sđt/ngày sinh với bot đã kết bạn, nên UI phải trông tử tế
// cả với người trống trường. Ngày sinh trải nhiều định dạng + một cái sắp tới để thử bộ lọc.
const nextWeek = new Date(Date.now() + 5 * 86400000);
const DEV_PROFILE_CACHE = {
    'uid-1001': {
        userId: 'uid-1001', displayName: 'Nguyễn Văn An', avatar: '',
        sdob: '1990-05-17', phoneNumber: '+84901234567', gender: 0,
    },
    // Cùng người với `uid-1001` nhưng nhìn từ bot `mkt`: uid khác, sđt trùng (ghi kiểu khác để thử
    // luôn phần chuẩn hoá), và bot này KHÔNG thấy ngày sinh — đúng cảnh mỗi bot biết một mẩu.
    'mkt-1001': {
        userId: 'mkt-1001', displayName: 'Nguyễn Văn An', avatar: '',
        sdob: '', phoneNumber: '0901234567', gender: 0,
    },
    'uid-1002': {
        userId: 'uid-1002', displayName: 'Trần Thị Bích', avatar: '',
        // Sinh nhật trong 5 ngày tới → thử được bộ lọc "7 ngày tới" ngay khi mở trang.
        sdob: `${String(nextWeek.getDate()).padStart(2, '0')}/${String(nextWeek.getMonth() + 1).padStart(2, '0')}/1995`,
        phoneNumber: '0912345678', gender: 1,
    },
    'uid-1003': { userId: 'uid-1003', displayName: 'Lê Minh Châu', phoneNumber: '84987654321' },
    // uid-1004 và uid-2001 KHÔNG có hồ sơ → phải hiện "—" chứ không được vỡ.
    'uid-9001': { userId: 'uid-9001', displayName: 'Bạn chỉ nhắn riêng', phoneNumber: '0977000111', gender: 0 },
};
// Bạn bè theo TỪNG bot — bản thật gọi `get-friends` riêng cho mỗi profile, mỗi tài khoản Zalo có
// danh sách bạn của riêng nó. Dùng chung một mảng thì bot `mkt` sẽ nhận cả bạn của `default` và
// lỗi "bot này thấy liên hệ của bot kia" bị che mất ngay trong dev.
// `uid-9001` KHÔNG ở nhóm nào, để thử nhánh gộp bạn-bè-ngoài-nhóm.
const DEV_FRIENDS_BY_PROFILE = {
    default: ['uid-1001', 'uid-9001'],
    mkt: ['mkt-1001'],
};

// Nhãn phân loại của Zalo — đúng 6 nhãn mặc định kèm màu thật lấy từ tài khoản production.
// Cố ý để một nhãn RỖNG (Đồng nghiệp) và một id KHÔNG có trong CRM (`group-demo`): hai ca đó là
// thứ hay bị hiểu nhầm thành "đồng bộ hỏng", nên phải nhìn thấy được ngay trong dev.
const DEV_ZALO_LABELS = [
    { id: 1, text: 'Khách hàng', color: '#d91b1b', emoji: '', conversations: ['uid-1001', 'uid-1002', 'mkt-1001', 'group-demo'] },
    { id: 2, text: 'Gia đình', color: '#f31bc8', emoji: '', conversations: ['uid-9001'] },
    { id: 3, text: 'Công việc', color: '#ff6905', emoji: '', conversations: ['uid-1003'] },
    { id: 4, text: 'Bạn bè', color: '#fac000', emoji: '', conversations: ['uid-1001'] },
    { id: 5, text: 'Trả lời sau', color: '#4bc377', emoji: '', conversations: ['uid-2001'] },
    { id: 6, text: 'Đồng nghiệp', color: '#0068ff', emoji: '', conversations: [] },
];

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname.startsWith('/api/')) {
        const auth = String(req.headers.authorization || '');
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (bearer !== TOKEN && req.headers['x-zalo-dashboard-token'] !== TOKEN) {
            return send(res, 401, { ok: false, error: 'unauthorized' });
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
            return send(res, 200, STATE_STUB);
        }
        if (req.method === 'POST' && url.pathname === '/api/action') {
            let raw = '';
            for await (const chunk of req) raw += chunk;
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { }
            const action = String(body.action || '').trim();
            console.log(`[dev] action: ${action}`);
            // Hai action này ở bản thật nằm trong index.js (phải đọc file phía server), không nằm
            // trong crm-api.js. Dựng lại đúng đường đi đó ở đây, nếu không nút "Import từ Zalo" sẽ
            // vỡ trong dev mà vẫn chạy trên production — kiểu lệch harness khó chịu nhất.
            if (action === 'crm-zalo-people' || action === 'crm-import-zalo') {
                // Bắt chước index.js: import chạy RIÊNG từng bot, mỗi bot chỉ thấy nhóm của mình.
                const wanted = body.payload?.profile
                    ? [String(body.payload.profile)]
                    : STATE_STUB.bots.map(b => b.profile);
                let created = 0, updated = 0, linked = 0;
                const all = [];
                for (const prof of wanted) {
                    const dir = {};
                    for (const g of STATE_STUB.groups) {
                        if (g.profile === prof && STATE_STUB.members[g.groupId]) dir[g.groupId] = STATE_STUB.members[g.groupId];
                    }
                    const people = buildZaloPeople({
                        memberDir: dir,
                        profileCache: DEV_PROFILE_CACHE,
                        friendIds: DEV_FRIENDS_BY_PROFILE[prof] || [],
                        groupNameOf: (gid) => STATE_STUB.groups.find(g => g.groupId === gid)?.name || gid,
                    });
                    all.push(...people);
                    if (action === 'crm-import-zalo') {
                        const r = crm.importMembers(people, prof, 'dev-ui');
                        created += r.created; updated += r.updated; linked += r.linked;
                    }
                }
                const stats = {
                    profiles: wanted,
                    total: all.length,
                    withPhone: all.filter(p => p.phone).length,
                    withBirthday: all.filter(p => p.birthday).length,
                    friendsKnown: true,
                    friends: all.filter(p => p.isFriend).length,
                };
                const result = action === 'crm-zalo-people'
                    ? { ...stats, people: all.slice(0, 500) }
                    : { created, updated, linked, ...stats };
                return send(res, 200, { ok: true, result, state: STATE_STUB });
            }
            // ── Khung chat: đọc thẳng store, giống index.js bên bản thật ──
            const chatVersion = () => {
                try {
                    const r = store.db.prepare(
                        'SELECT MAX(last_message_at) AS mx, (SELECT COUNT(*) FROM messages) AS n FROM conversations').get();
                    return `${r?.mx || 0}:${r?.n || 0}`;
                } catch { return '0:0'; }
            };
            if (action === 'chat-version') {
                return send(res, 200, { ok: true, result: { v: chatVersion() }, state: STATE_STUB });
            }
            if (action === 'chat-conversations') {
                const rows = store.listConversations({ accountId: body.payload?.accountId, limit: 200 });
                return send(res, 200, {
                    ok: true,
                    result: {
                        v: chatVersion(),
                        conversations: rows.map(c => {
                            const raw = String(c.id || '').split('|').slice(1).join('|');
                            return {
                                id: c.id,
                                accountId: c.account_id,
                                type: c.type,
                                title: c.type === 'group'
                                    ? (STATE_STUB.groups.find(g => g.groupId === raw)?.name || raw)
                                    : (DEV_PROFILE_CACHE[raw]?.displayName || raw),
                                avatar: DEV_PROFILE_CACHE[raw]?.avatar || '',
                                lastMessageAt: Number(c.last_message_at) || 0,
                                lastText: c.last_text || '',
                                messageCount: Number(c.message_count) || 0,
                            };
                        }),
                    },
                    state: STATE_STUB,
                });
            }
            if (action === 'chat-messages') {
                const msgs = store.recentMessages(String(body.payload?.conversationId || ''), 100);
                return send(res, 200, {
                    ok: true,
                    result: {
                        conversationId: body.payload?.conversationId,
                        messages: msgs.map(m => ({
                            id: m.id, senderId: m.sender_id, senderName: m.sender_name, text: m.text,
                            sentAt: Number(m.sent_at) || 0, fromSelf: !!m.from_self,
                            media: m.media_json ? JSON.parse(m.media_json) : undefined,
                        })),
                    },
                    state: STATE_STUB,
                });
            }
            // Giả lập trợ lý AI: KHÔNG gọi model thật trong dev (tốn token và cần key), nhưng trả
            // về đúng hình dạng dữ liệu để kiểm được mọi nhánh giao diện.
            if (action === 'chat-ai') {
                const mode = body.payload?.mode || 'draft';
                const n = Number(body.payload?.contextCount) || 30;
                const rows = store.recentMessages(String(body.payload?.conversationId || ''), n);
                const last = rows[rows.length - 1]?.text || '';
                const out = { mode, contextUsed: rows.length, isGroup: false };
                if (mode === 'suggest') {
                    out.suggestions = [
                        'Dạ vâng, chị nhắn địa chỉ giúp em nhé.',
                        'Ok ạ, em đang sẵn sàng ghi nhận đây ạ.',
                        'Sau khi có địa chỉ em sẽ gửi mã đơn cho chị.',
                        'Chị gửi qua đây em lên đơn luôn ạ.',
                    ];
                    out.text = out.suggestions.join('\n');
                } else if (mode === 'summary') {
                    out.text = `- Khách hỏi về đơn hàng\n- Đã chốt 2 món\n- Còn chờ địa chỉ giao\n- (dev stub, đọc ${rows.length} tin)`;
                } else if (mode === 'ask') {
                    out.text = `(dev stub) Câu hỏi: "${body.payload?.question}" — đọc ${rows.length} tin gần nhất.`;
                } else {
                    out.text = `Dạ em xác nhận ạ. Chị cho em xin địa chỉ để em gửi hàng sớm nhất nhé!`
                        + (last ? `\n(tin cuối: ${String(last).slice(0, 40)})` : '');
                }
                return send(res, 200, { ok: true, result: out, state: STATE_STUB });
            }
            if (action === 'send-message') {
                // Bản thật gửi qua Zalo; ở dev chỉ ghi vào store để thấy tin hiện lên đúng chỗ.
                const conv = `${body.payload?.accountId || 'default'}|${body.payload?.targetId}`;
                store.upsertConversation({ id: conv, accountId: 'default', type: 'dm', lastMessageAt: Date.now() });
                store.insertMessage({
                    id: `dev-${Date.now()}`, conversationId: conv, senderId: 'bot', senderName: 'DevBot',
                    text: String(body.payload?.text || ''), sentAt: Date.now(), fromSelf: true,
                });
                return send(res, 200, { ok: true, result: { sent: true }, state: STATE_STUB });
            }

            // Cũng nằm ở index.js bên bản thật (cần gọi Zalo), không nằm trong crm-api.js.
            if (action === 'crm-sync-zalo-labels') {
                const wanted = body.payload?.profile
                    ? [String(body.payload.profile)]
                    : STATE_STUB.bots.map(b => b.profile);
                let assigned = 0, unmatched = 0;
                for (const prof of wanted) {
                    const r = crm.syncZaloLabels(DEV_ZALO_LABELS, 'dev-ui', { prune: false, accountId: prof });
                    assigned += r.assigned; unmatched += r.unmatched;
                }
                const removed = body.payload?.profile ? 0 : crm.pruneZaloTags(DEV_ZALO_LABELS.map(l => l.text), 'dev-ui');
                return send(res, 200, {
                    ok: true,
                    result: { tags: DEV_ZALO_LABELS.length, assigned, unmatched, removed, profiles: wanted.length, failed: [], pruned: !body.payload?.profile },
                    state: STATE_STUB,
                });
            }
            if (action.startsWith('crm-')) {
                const r = handleCrmAction(crm, action, body.payload || {}, 'dev-ui');
                if (!r.body.ok) return send(res, r.status, { ok: false, error: r.body.error });
                return send(res, 200, { ok: true, result: r.body.data, state: STATE_STUB });
            }
            // Lịch báo cáo: stub có dữ liệu thật-như-thật để dựng UI được (stub rỗng thì trang trắng).
            if (action === 'report-sent') {
                return send(res, 200, { ok: true, result: { ok: true, entries: DEV_REPORT_SENT, keepDays: 90 }, state: STATE_STUB });
            }
            if (action === 'report-jobs') {
                return send(res, 200, { ok: true, result: DEV_REPORT_JOBS, state: STATE_STUB });
            }
            if (action === 'report-job-save') {
                const job = body.payload?.job;
                const i = DEV_REPORT_JOBS.jobs.findIndex(j => j.id === job.id);
                const resolved = { ...job, resolvedCount: job.groups === '*' ? DEV_REPORT_JOBS.groups.length : job.groups.length };
                if (i >= 0) DEV_REPORT_JOBS.jobs[i] = resolved; else DEV_REPORT_JOBS.jobs.push(resolved);
                return send(res, 200, { ok: true, result: { ok: true, job }, state: STATE_STUB });
            }
            if (action === 'report-job-delete') {
                DEV_REPORT_JOBS.jobs = DEV_REPORT_JOBS.jobs.filter(j => j.id !== body.payload?.id);
                return send(res, 200, { ok: true, result: { ok: true }, state: STATE_STUB });
            }
            if (action === 'report-digest-preview') {
                const text = [
                    '📊 TỔNG HỢP 2026-07-29 · 2 nhóm · 34 tin',
                    '',
                    '📋 Vọc Tech Không Cọc — 26 tin · 6 người',
                    '  • Hướng dẫn cài OpenClaw + bot Zalo (Docker/WSL2)',
                    '  • Thanhagg hỏi plugin memory xử lý PDF/Excel',
                    '  • ⚠️ Hiếu: lỗi lưu API 9Router — CHƯA XONG',
                    '',
                    '📋 ASA 7881 ORDER TQ — 8 tin · 3 người',
                    '  • Chốt đơn 2 kiện, hỏi giá vận chuyển',
                    '  • ⚠️ Khách chờ báo giá',
                    '',
                    '🔗 2 link · 📅 1 hẹn lịch → xem chi tiết ở dashboard',
                ].join('\n');
                return send(res, 200, { ok: true, result: { date: '2026-07-29', parts: 1, texts: [text], chars: text.length }, state: STATE_STUB });
            }
            return send(res, 200, { ok: true, result: {}, state: STATE_STUB });
        }
        return send(res, 404, { ok: false, error: 'not found' });
    }

    // Static files
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const safe = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
    const full = path.join(ROOT, safe);
    if (!full.startsWith(ROOT) || !existsSync(full)) return send(res, 404, 'not found', 'text/plain');
    let content = readFileSync(full);
    if (safe === 'index.html') {
        content = content.toString('utf8').replace('</head>',
            `<script>window.ZALO_DASHBOARD_TOKEN='${TOKEN}';</script></head>`);
    }
    return send(res, 200, content, MIME[path.extname(safe)] || 'application/octet-stream');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[dev] dashboard: http://127.0.0.1:${PORT}/`);
});
