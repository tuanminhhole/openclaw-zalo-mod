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
console.log(`[dev] CRM DB: ${DB_PATH}`);

const STATE_STUB = {
    ok: true,
    pluginVersion: '2.16.0',
    license: { isPro: true, canBulk: true, canMultiBot: false, tier: 'pro', plan: 'personal', expiry: '2026-08-18', isTrial: true },
    bot: { botName: 'DevBot', ownerId: '', ownerName: 'Owner', profile: 'default' },
    bots: [{ profile: 'default', botName: 'DevBot', avatar: '' }],
    // Có nhóm thật + người ở NHIỀU nhóm (uid-1002) để thử phần nối CRM ↔ nhóm.
    groups: [
        { groupId: 'group-demo', name: 'ASA 7881 - [ORDER TQ] ME ME' },
        { groupId: 'group-kt', name: '237.KẾ TOÁN ASA-VNLOGS' },
        { groupId: 'group-x3', name: 'X3 Diamond_ Gia đình Kim Cương X3' },
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
// Bạn bè: có một người KHÔNG ở nhóm nào (uid-9001) để thử nhánh gộp bạn-bè-ngoài-nhóm.
const DEV_FRIEND_IDS = ['uid-1001', 'uid-9001'];

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
                const people = buildZaloPeople({
                    memberDir: STATE_STUB.members,
                    profileCache: DEV_PROFILE_CACHE,
                    friendIds: DEV_FRIEND_IDS,
                    groupNameOf: (gid) => STATE_STUB.groups.find(g => g.groupId === gid)?.name || gid,
                });
                const stats = {
                    total: people.length,
                    withPhone: people.filter(p => p.phone).length,
                    withBirthday: people.filter(p => p.birthday).length,
                    friendsKnown: true,
                    friends: people.filter(p => p.isFriend).length,
                };
                const result = action === 'crm-zalo-people'
                    ? { ...stats, people: people.slice(0, 500) }
                    : { ...crm.importMembers(people, 'default', 'dev-ui'), ...stats };
                return send(res, 200, { ok: true, result, state: STATE_STUB });
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
