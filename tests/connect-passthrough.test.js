import assert from 'node:assert/strict';
import test from 'node:test';
import {
    classifyConnectAction, connectTargetCount, listConnectActions,
    CONNECT_READ_ACTIONS, CONNECT_WRITE_ACTIONS, CONNECT_DESTRUCTIVE_ACTIONS,
} from '../src/agent/connect-actions.js';
import { requiredTierForAction, assertActionAllowed } from '../src/licensing/entitlements.js';
import { AGENT_SAFE_ACTIONS, AGENT_DESTRUCTIVE_ACTIONS, classifyAction } from '../src/agent/tool-surface.js';
import { readFileSync } from 'node:fs';

const FREE = { tier: 'free', plan: 'free', isPro: false };
const PRO = { tier: 'pro', plan: 'personal', isPro: true };

// ── Deny-by-default ───────────────────────────────────────────────────────────────────────────
test('action lạ bị chặn, và lý do nói rõ là CHƯA XẾP HẠNG (không phải sai tên)', () => {
    const v = classifyConnectAction('mot-action-khong-ton-tai');
    assert.equal(v.allowed, false);
    assert.match(v.reason, /chưa được xếp hạng/i);
});

test('API mới của zalo-connect không tự lọt ra cho bot', () => {
    // Kịch bản thật: zalo-connect bản sau thêm action mới; nếu mặc định là cho phép thì bot có ngay
    // quyền dùng mà không ai đọc qua. Phải có người xếp hạng trước.
    for (const unseen of ['send-money', 'export-all-contacts', 'delete-account']) {
        assert.equal(classifyConnectAction(unseen).allowed, false, `${unseen} phải bị chặn`);
    }
});

test('tên rỗng bị chặn', () => {
    assert.equal(classifyConnectAction('').allowed, false);
    assert.equal(classifyConnectAction(null).allowed, false);
});

// ── Ba mức ────────────────────────────────────────────────────────────────────────────────────
test('đọc và ghi được phép; các action owner hỏi nhiều nhất đều nằm trong write', () => {
    assert.equal(classifyConnectAction('get-group-info').kind, 'read');
    for (const a of ['rename-group', 'change-group-avatar', 'update-group-settings', 'add-group-admin']) {
        const v = classifyConnectAction(a);
        assert.equal(v.allowed, true, `${a} phải cho phép`);
        assert.equal(v.kind, 'write');
    }
});

test('action không hoàn tác được mặc định TẮT, bật bằng allowDestructive', () => {
    for (const a of ['disperse-group', 'change-group-owner', 'invite-to-groups', 'unfriend']) {
        assert.equal(classifyConnectAction(a).allowed, false, `${a} phải tắt mặc định`);
        assert.match(classifyConnectAction(a).reason, /allowDestructive|dashboard/);
        assert.equal(classifyConnectAction(a, { allowDestructive: true }).allowed, true);
        assert.equal(classifyConnectAction(a, { allowDestructive: true }).kind, 'destructive');
    }
});

test('không action nào nằm ở hai mức cùng lúc', () => {
    const seen = new Map();
    for (const [kind, list] of [['read', CONNECT_READ_ACTIONS], ['write', CONNECT_WRITE_ACTIONS], ['destructive', CONNECT_DESTRUCTIVE_ACTIONS]]) {
        for (const a of list) {
            assert.equal(seen.has(a), false, `${a} bị xếp cả ở ${seen.get(a)} và ${kind}`);
            seen.set(a, kind);
        }
    }
});

test('list-actions không tiết lộ nhóm destructive khi chưa bật', () => {
    const locked = listConnectActions({ allowDestructive: false });
    assert.deepEqual(locked.destructive, []);
    assert.ok(locked.destructiveLocked.length > 0, 'vẫn cho bot BIẾT là có nhóm bị khoá để nó giải thích với owner');
    assert.ok(listConnectActions({ allowDestructive: true }).destructive.length > 0);
});

// ── Luật gói: passthrough KHÔNG được thành đường lách ────────────────────────────────────────
// Đây là điểm dễ hỏng nhất: lời gọi thật nằm trong payload.params, nên nếu chỉ đếm ở tầng ngoài thì
// mọi thứ tụt xuống free và owner Free chỉ cần nhờ bot là làm được thao tác hàng loạt của gói PRO.
test('đếm được nhiều đích nằm BÊN TRONG params', () => {
    assert.equal(connectTargetCount({ threadId: 'a' }), 0, 'một đích đơn lẻ không phải hàng loạt');
    assert.equal(connectTargetCount({ threadIds: ['a', 'b', 'c'] }), 3);
    assert.equal(connectTargetCount({ userIds: 'a, b' }), 2, 'dạng CSV cũng phải đếm');
    assert.equal(connectTargetCount({ groupIds: ['a'] }), 1);
});

test('một thao tác lẻ qua passthrough: Free làm được', () => {
    const payload = { action: 'rename-group', params: { groupId: 'g1', name: 'Tên mới' } };
    assert.equal(requiredTierForAction('zalo-api', payload), 'free');
    assert.doesNotThrow(() => assertActionAllowed('zalo-api', payload, FREE));
});

test('nhiều đích qua passthrough: Free bị chặn, PRO qua', () => {
    const payload = { action: 'send', params: { threadIds: ['g1', 'g2', 'g3'], message: 'hi' } };
    assert.equal(requiredTierForAction('zalo-api', payload), 'pro');
    assert.throws(() => assertActionAllowed('zalo-api', payload, FREE), /PRO|TEAM/);
    assert.doesNotThrow(() => assertActionAllowed('zalo-api', payload, PRO));
});

test('params.all = true cũng là hàng loạt', () => {
    const payload = { action: 'send', params: { all: true, message: 'hi' } };
    assert.equal(requiredTierForAction('zalo-api', payload), 'pro');
    assert.throws(() => assertActionAllowed('zalo-api', payload, FREE), /PRO|TEAM/);
});

test('nhiều profile vẫn là TEAM, kể cả qua passthrough', () => {
    const payload = { action: 'send', profile: 'all', params: { threadId: 'g1' } };
    assert.equal(requiredTierForAction('zalo-api', payload), 'team');
    assert.throws(() => assertActionAllowed('zalo-api', payload, PRO), /TEAM/);
});

test('luật cũ của dashboard không bị đổi', () => {
    assert.equal(requiredTierForAction('scan-members', { groupId: 'g1' }), 'free');
    assert.equal(requiredTierForAction('bulk-toggle-setting', { groupIds: ['a', 'b'] }), 'pro');
    assert.equal(requiredTierForAction('send-messages', { targets: ['a'] }), 'pro');
});

// ── Bot phải TẠO/SỬA được lịch báo cáo ────────────────────────────────────────────────────────
// Bug thật gặp trên production: owner nhờ bot đổi giờ lịch, bot trả lời "phần điều khiển hiện tại
// chưa nhận lệnh cập nhật, sếp vào dashboard đổi giúp". Hai nguyên nhân, phải sửa cả hai:
//   1. `report-job-save` KHÔNG có trong allowlist → bot đọc được lịch mà không ghi được.
//   2. Handler THAY toàn bộ job, nên bot gửi {id, time} là mất `groups` rồi ném lỗi.
test('bot được phép đọc, tạo/sửa, xem trước và gửi thử lịch báo cáo', () => {
    for (const a of ['report-jobs', 'report-job-save', 'report-digest-preview', 'report-job-run']) {
        assert.ok(AGENT_SAFE_ACTIONS.includes(a), `${a} phải nằm trong allowlist`);
        assert.equal(classifyAction(a).allowed, true);
    }
});

// Phanh cho việc xoá lịch là bước XÁC NHẬN HAI NHỊP trong zalo_mod_reports, KHÔNG phải cờ
// allowDestructive. Cờ đó mở kèm remove-user/block-member/leave-group — bắt owner mở cả chùm đó
// chỉ để xoá một lịch báo cáo là đổi phanh nhỏ lấy rủi ro lớn.
test('xoá lịch không bị khoá sau allowDestructive — phanh là bước xác nhận, không phải cờ chùm', () => {
    assert.ok(AGENT_SAFE_ACTIONS.includes('report-job-delete'));
    assert.equal(classifyAction('report-job-delete').allowed, true);
    for (const a of ['remove-user', 'block-member', 'leave-group']) {
        assert.ok(AGENT_DESTRUCTIVE_ACTIONS.includes(a), `${a} phải vẫn nằm sau cờ allowDestructive`);
        assert.equal(classifyAction(a).allowed, false);
    }
});

test('save merge lên bản hiện có nên sửa một phần không làm mất groups', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf("action === 'report-job-save'"), src.indexOf("action === 'report-job-delete'"));
    assert.match(block, /\.\.\.current, \.\.\.incoming/, 'phải merge incoming lên current');
    assert.match(block, /deliver: \{ \.\.\.current\.deliver, \.\.\.\(incoming\.deliver \|\| \{\}\) \}/,
        'deliver phải merge sâu, không thì bật ownerDm là mất eachGroup/groups');
    assert.match(block, /find\(j => j\.id ===/, 'phải tìm bản hiện có theo id');
});

test('lịch báo cáo cho một tập nhóm vẫn theo luật gói như dashboard', () => {
    // Tạo/sửa lịch là một thao tác trên MỘT lịch, không phải fan-out nhiều đích → Free làm được.
    assert.equal(requiredTierForAction('report-job-save', { job: { groups: ['a', 'b', 'c'] } }), 'free');
});

// ── Action đọc không được nhận payload kiểu ghi ───────────────────────────────────────────────
// Bug thật: bot được nhờ đổi giờ đã gọi `report-jobs { id, time }` rồi `report-digest-preview
// { time, deliver }`. Cả hai bỏ qua field lạ và trả ok:true → bot báo với owner "đã đổi xong" trong khi
// lịch không đổi. Bot không bịa — chính API nói dối trước.
test('action chỉ-đọc từ chối payload kiểu ghi, kèm chỉ dẫn sang report-job-save', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(src, /function rejectMutationPayload/, 'phải có hàm chặn');
    assert.match(src, /rejectMutationPayload\('report-jobs', payload\)/, 'report-jobs phải chặn');
    assert.match(src, /rejectMutationPayload\('report-digest-preview', payload\)/, 'preview phải chặn');
    // MUTATION_HINT_KEYS khai báo TRƯỚC hàm nên phải cắt từ đó, không thì bỏ sót đúng danh sách cần kiểm.
    const fn = src.slice(src.indexOf('const MUTATION_HINT_KEYS'), src.indexOf("if (action === 'report-jobs')"));
    for (const k of ['id', 'time', 'enabled', 'deliver', 'operation', 'kind']) {
        assert.match(fn, new RegExp(`'${k}'`), `phải bắt field ${k} — bot thật đã gửi nó`);
    }
    assert.match(fn, /report-job-save/, 'lỗi phải chỉ đúng action cần dùng, không chỉ nói "sai"');
});

test('save nhận TÊN nhóm, tên lạ/nhập nhằng thì báo lỗi thay vì ghi bừa', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf("action === 'report-job-save'"), src.indexOf("action === 'report-job-delete'"));
    assert.match(block, /resolveGroupTargets\(list, knownGroups\)/, 'phải dùng resolver tên nhóm sẵn có');
    assert.match(block, /Không tìm thấy nhóm/, 'tên lạ phải báo lỗi');
    assert.match(block, /nhập nhằng/, 'tên nhập nhằng phải báo lỗi kèm ứng viên');
    assert.match(block, /job\.deliver\.groups = resolveNames/, 'deliver.groups cũng phải resolve — bot thật gửi tên vào đây');
});
