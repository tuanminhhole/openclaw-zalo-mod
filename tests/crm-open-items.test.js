import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/database.js';
import { CrmStore } from '../src/crm/crm-store.js';
import { handleCrmAction } from '../src/crm/crm-api.js';

const quiet = { info: () => {}, warn: () => {} };

function makeCrm(now) {
    const store = openStore(':memory:', { logger: quiet });
    return { crm: new CrmStore(store.db, now ? { now: () => now } : {}), close: () => store.close() };
}

// ── CrmStore.reconcileGroupOpenItems — lớp I/O mỏng bọc quanh reconcileOpenItems ────────────────

test('reconcileGroupOpenItems: việc mới → ghi DB đúng cột, đọc lại được qua listTasks', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const r = crm.reconcileGroupOpenItems('g1', '2026-08-18', [
        { what: 'Gửi bổ sung giấy tờ', who: 'An', due: '19/08', state: 'pending', evidence: '09:15' },
    ]);
    assert.deepEqual(r, { inserted: 1, updated: 0, closed: 0, skipped: [], revived: 0 });
    const rows = crm.listTasks({ filter: 'all' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'ai');
    assert.equal(rows[0].status, 'todo');
    assert.equal(rows[0].review_state, 'pending');
    assert.equal(rows[0].dedupe_key, 'gui-bo-sung-giay-to');
    assert.equal(rows[0].assignee, 'An');
});

test('reconcileGroupOpenItems: gọi lại ngày sau với cùng việc → update, không insert đôi', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Gọi lại khách', state: 'pending' }]);
    const r2 = crm.reconcileGroupOpenItems('g1', '2026-08-19', [{ what: 'Gọi lại khách', state: 'pending' }]);
    assert.deepEqual(r2, { inserted: 0, updated: 1, closed: 0, skipped: [], revived: 0 });
    const rows = crm.listTasks({ filter: 'all' });
    assert.equal(rows.length, 1, 'không nhân đôi task cho cùng dedupe_key');
    assert.equal(rows[0].last_seen_date, '2026-08-19');
    assert.equal(rows[0].first_seen_date, '2026-08-18', 'first_seen_date giữ nguyên mốc ban đầu');
});

test('reconcileGroupOpenItems: state=done ở lần gọi sau → đóng task, done_at có giá trị', (t) => {
    const { crm, close } = makeCrm(999);
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Chốt phí hợp quy', state: 'pending' }]);
    crm.reconcileGroupOpenItems('g1', '2026-08-19', [{ what: 'Chốt phí hợp quy', state: 'done' }]);
    const rows = crm.listTasks({ filter: 'all' });
    assert.equal(rows[0].status, 'done');
    assert.equal(rows[0].done_at, 999);
});

test('reconcileGroupOpenItems: trùng dedupe_key với việc GÕ TAY → AI không tự thêm, trả về skipped', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.createTask({ title: 'Trả 200.000đ dư ship', groupId: 'g1' });
    const r = crm.reconcileGroupOpenItems('g1', '2026-08-19', [{ what: 'Trả 200.000đ dư ship', state: 'pending' }]);
    assert.equal(r.inserted, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(crm.listTasks({ filter: 'all' }).length, 1, 'vẫn chỉ có đúng task gõ tay ban đầu');
});

test('createTask: hai việc GÕ TAY trùng tên trong cùng nhóm KHÔNG được lỗi — dedupe_key chỉ để đối soát AI', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const a = crm.createTask({ title: 'Gọi lại khách', groupId: 'g1' });
    const b = crm.createTask({ title: 'Gọi lại khách', groupId: 'g1' });
    assert.notEqual(a.id, b.id);
    assert.equal(a.dedupe_key, 'goi-lai-khach', 'bản ghi đầu giữ dedupe_key bình thường');
    assert.equal(b.dedupe_key, null, 'bản ghi trùng slug thứ hai không được có dedupe_key trùng UNIQUE index');
    assert.equal(crm.listTasks({ filter: 'all' }).length, 2, 'cả hai việc đều được tạo, không mất cái nào');
});

test('reconcileGroupOpenItems: thiếu groupId → ném lỗi rõ; items rỗng → no-op an toàn', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    assert.throws(() => crm.reconcileGroupOpenItems('', '2026-08-19', [{ what: 'x' }]), /groupId/);
    assert.deepEqual(crm.reconcileGroupOpenItems('g1', '2026-08-19', []), { inserted: 0, updated: 0, closed: 0, skipped: [], revived: 0 });
});

// ── Kanban board + duyệt/từ chối/đổi trạng thái ─────────────────────────────────────────────────

test('listOpenItemsBoard: việc AI mới vào cột "pending_review", việc gõ tay vào "todo"', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.createTask({ title: 'Việc tay', groupId: 'g1' });
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc AI', state: 'pending' }]);
    const board = crm.listOpenItemsBoard('g1');
    assert.equal(board.pending_review.length, 1);
    assert.equal(board.pending_review[0].title, 'Việc AI');
    assert.equal(board.todo.length, 1);
    assert.equal(board.todo[0].title, 'Việc tay');
});

test('approveTask: CHỈ bỏ review_state, không đổi gì khác (P4)', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [
        { what: 'Việc AI', who: 'An', due: '19/08', state: 'pending', evidence: '09:15' },
    ]);
    const before = crm.listTasks({ filter: 'all' })[0];
    const approved = crm.approveTask(before.id);
    assert.equal(approved.review_state, null, 'chỉ field này được đổi');
    // Mọi field khác giữ nguyên byte-for-byte so với trước khi duyệt.
    for (const key of ['title', 'status', 'source', 'dedupe_key', 'group_id', 'assignee', 'note',
        'evidence', 'first_seen_date', 'last_seen_date', 'done_at', 'due_at', 'created_at']) {
        assert.equal(approved[key], before[key], `field "${key}" không được đổi khi duyệt`);
    }
    const board = crm.listOpenItemsBoard('g1');
    assert.equal(board.pending_review.length, 0);
    assert.equal(board.todo.length, 1);
});

test('rejectTask (P14): BIA MỘ — không DELETE, chỉ đổi review_state, dedupe_key vẫn còn; không cho từ chối việc đã duyệt', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc AI', state: 'pending' }]);
    const before = crm.listTasks({ filter: 'all' })[0];
    const rejected = crm.rejectTask(before.id);
    assert.equal(rejected.review_state, 'rejected');
    assert.equal(rejected.dedupe_key, before.dedupe_key, 'dedupe_key phải giữ nguyên — mất nó là hôm sau AI tạo lại y hệt');
    assert.notEqual(crm.getTask(before.id), null, 'dòng KHÔNG được xoá');
    assert.equal(crm.listTasks({ filter: 'all' }).length, 1, 'vẫn còn 1 dòng trong DB, không mất');

    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc AI 2', state: 'pending' }]);
    const id2 = crm.listTasks({ filter: 'all' }).find(r => r.title === 'Việc AI 2').id;
    crm.approveTask(id2);
    assert.throws(() => crm.rejectTask(id2), /chờ xác nhận/);
});

// ── P14: bia mộ ẩn khỏi kanban + backlog, reconcile bỏ qua khi còn hiệu lực, cho quay lại sau 30 ngày

test('rejectTask (P14): việc bị từ chối biến mất khỏi kanban VÀ khỏi backlog', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc bị từ chối' }, { what: 'Việc còn lại' }]);
    const rows = crm.listTasks({ filter: 'all' });
    const target = rows.find(r => r.title === 'Việc bị từ chối');
    crm.rejectTask(target.id);

    const board = crm.listOpenItemsBoard('g1');
    for (const col of Object.values(board)) assert.ok(!col.some(r => r.id === target.id), 'không được xuất hiện ở cột kanban nào');
    assert.equal(board.pending_review.length, 1, 'việc còn lại vẫn hiện bình thường');

    const backlog = crm.listBacklog(['g1']);
    assert.ok(!backlog.some(r => r.id === target.id), 'không được xuất hiện trong backlog báo cáo');
    assert.equal(backlog.length, 1);
});

test('reconcileOpenItems qua reconcileGroupOpenItems (P14): việc bị từ chối < 30 ngày, thấy lại → BỎ QUA, không tạo lại/update', (t) => {
    const NOW = new Date('2026-08-19T00:00:00Z').getTime();
    const { crm, close } = makeCrm(NOW);
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-19', [{ what: 'Việc nhạy cảm' }]);
    const id = crm.listTasks({ filter: 'all' })[0].id;
    crm.rejectTask(id); // updated_at = NOW (2026-08-19)

    const r = crm.reconcileGroupOpenItems('g1', '2026-09-01', [{ what: 'Việc nhạy cảm' }]); // 13 ngày sau
    assert.deepEqual(r, { inserted: 0, updated: 0, closed: 0, skipped: [{
        dedupeKey: 'viec-nhay-cam', what: 'Việc nhạy cảm',
        reason: 'đã bị từ chối 13 ngày trước — bia mộ còn hiệu lực (30 ngày), AI không tự tạo lại',
    }], revived: 0 });
    const after = crm.getTask(id);
    assert.equal(after.review_state, 'rejected', 'vẫn là bia mộ, không bị đụng');
    assert.equal(crm.listTasks({ filter: 'all' }).length, 1, 'không tạo thêm dòng nào');
});

test('reconcileOpenItems qua reconcileGroupOpenItems (P14): bia mộ > 30 ngày → cho quay lại "Chờ xác nhận", KHÔNG tự duyệt', (t) => {
    const NOW = new Date('2026-08-19T00:00:00Z').getTime();
    const { crm, close } = makeCrm(NOW);
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-19', [{ what: 'Việc quay lại' }]);
    const id = crm.listTasks({ filter: 'all' })[0].id;
    crm.rejectTask(id); // updated_at = 2026-08-19

    const r = crm.reconcileGroupOpenItems('g1', '2026-09-20', [{ what: 'Việc quay lại' }]); // 32 ngày sau
    assert.deepEqual(r, { inserted: 0, updated: 0, closed: 0, skipped: [], revived: 1 });
    const after = crm.getTask(id);
    assert.equal(after.review_state, 'pending', 'phải quay về Chờ xác nhận, không tự động duyệt');
    assert.equal(after.last_seen_date, '2026-09-20');
    assert.equal(crm.listTasks({ filter: 'all' }).length, 1, 'không tạo dòng mới — dùng lại đúng dòng cũ (giữ dedupe_key)');
});

test('setTaskStatus: đổi cột kanban bằng tay, done thì set done_at, đổi khỏi done thì xoá done_at', (t) => {
    const { crm, close } = makeCrm(555);
    t.after(close);
    const task = crm.createTask({ title: 'A', groupId: 'g1' });
    crm.setTaskStatus(task.id, 'blocked');
    assert.equal(crm.getTask(task.id).status, 'blocked');
    assert.equal(crm.getTask(task.id).done_at, null);
    crm.setTaskStatus(task.id, 'done');
    assert.equal(crm.getTask(task.id).done_at, 555);
    crm.setTaskStatus(task.id, 'todo');
    assert.equal(crm.getTask(task.id).done_at, null, 'quay lại todo thì done_at phải xoá');
    assert.throws(() => crm.setTaskStatus(task.id, 'huỷ'), /không hợp lệ/);
});

// ── approveAndMoveTask (P12) — kéo card "Chờ xác nhận" sang cột khác = duyệt + đổi status ────────

test('approveAndMoveTask: bỏ review_state VÀ đổi status trong một lần gọi', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc AI', state: 'pending' }]);
    const id = crm.listTasks({ filter: 'all' })[0].id;
    const moved = crm.approveAndMoveTask(id, 'doing');
    assert.equal(moved.review_state, null, 'phải đã được duyệt');
    assert.equal(moved.status, 'doing', 'phải đã đổi cột');
    const board = crm.listOpenItemsBoard('g1');
    assert.equal(board.pending_review.length, 0);
    assert.equal(board.doing.length, 1);
});

test('approveAndMoveTask: đổi sang done thì set done_at; status không hợp lệ thì ném lỗi, không đụng gì', (t) => {
    const { crm, close } = makeCrm(777);
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc AI', state: 'pending' }]);
    const id = crm.listTasks({ filter: 'all' })[0].id;
    const moved = crm.approveAndMoveTask(id, 'done');
    assert.equal(moved.done_at, 777);
    assert.throws(() => crm.approveAndMoveTask(id, 'pending_review'), /không hợp lệ/,
        'không được nhận status=pending_review — cột đó không phải đích thả hợp lệ');
});

test('approveAndMoveTask: KHÔNG đụng `source` — gọi trên việc source=manual (dù thực tế manual không pending) vẫn giữ nguyên source', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const task = crm.createTask({ title: 'Việc tay', groupId: 'g1' });
    assert.equal(task.source, 'manual');
    const moved = crm.approveAndMoveTask(task.id, 'doing');
    assert.equal(moved.source, 'manual', 'source không bao giờ bị đổi bởi approveAndMoveTask');
    assert.equal(moved.status, 'doing');
});

test('handleCrmAction crm-task-approve-move: đi đúng qua CrmStore', () => {
    const store = openStore(':memory:', { logger: quiet });
    const crm = new CrmStore(store.db);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc AI', state: 'pending' }]);
    const id = crm.listTasks({ filter: 'all' })[0].id;
    const res = handleCrmAction(crm, 'crm-task-approve-move', { id, status: 'doing' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.review_state, null);
    assert.equal(res.body.data.status, 'doing');
    store.close();
});

// ── approvePendingByGroup (P13) — duyệt nhanh theo nhóm đang lọc trên kanban ─────────────────────

test('approvePendingByGroup: chỉ duyệt việc pending của ĐÚNG nhóm đó, nhóm khác không đổi một dòng nào', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [
        { what: 'Việc A1' }, { what: 'Việc A2' },
    ]);
    crm.reconcileGroupOpenItems('g2', '2026-08-18', [{ what: 'Việc B1' }]);
    const before = crm.listTasks({ filter: 'all' });
    const r = crm.approvePendingByGroup('g1');
    assert.deepEqual(r, { approved: 2 });
    const after = crm.listTasks({ filter: 'all' });
    for (const row of after) {
        if (row.group_id === 'g1') assert.equal(row.review_state, null, 'g1 phải đã duyệt hết');
        if (row.group_id === 'g2') {
            const beforeRow = before.find(b => b.id === row.id);
            assert.deepEqual(row, beforeRow, 'g2 không được đổi bất kỳ field nào');
        }
    }
});

test('approvePendingByGroup: KHÔNG đổi status — việc rơi sang "Cần làm" đúng như duyệt từng cái', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc A' }]);
    crm.approvePendingByGroup('g1');
    const board = crm.listOpenItemsBoard('g1');
    assert.equal(board.pending_review.length, 0);
    assert.equal(board.todo.length, 1, 'duyệt xong phải nằm ở "Cần làm", không tự nhảy cột khác');
});

test('approvePendingByGroup: không đụng việc source=manual (chúng không pending)', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const manual = crm.createTask({ title: 'Việc tay', groupId: 'g1' });
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc AI' }]);
    crm.approvePendingByGroup('g1');
    const after = crm.getTask(manual.id);
    assert.equal(after.source, 'manual');
    assert.equal(after.status, manual.status, 'việc tay không bị chạm khi duyệt theo nhóm');
});

test('approvePendingByGroup: không có việc pending nào → trả approved:0, không ghi audit vô ích', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const r = crm.approvePendingByGroup('nhom-trong');
    assert.deepEqual(r, { approved: 0 });
});

test('approvePendingByGroup: có ghi audit log', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc A' }, { what: 'Việc B' }]);
    crm.approvePendingByGroup('g1', 'owner-x');
    const logs = crm.listAudit(10);
    const log = logs.find(l => l.action === 'task.approve-group');
    assert.ok(log, 'phải có dòng audit cho task.approve-group');
    assert.equal(log.actor, 'owner-x');
    assert.equal(log.target, 'g1');
    assert.match(log.detail, /2 việc/);
});

test('handleCrmAction crm-tasks-approve-group: đi đúng qua CrmStore, thiếu groupId thì 400', () => {
    const store = openStore(':memory:', { logger: quiet });
    const crm = new CrmStore(store.db);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc A' }]);
    const res = handleCrmAction(crm, 'crm-tasks-approve-group', { groupId: 'g1' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { approved: 1 });

    const missing = handleCrmAction(crm, 'crm-tasks-approve-group', {});
    assert.equal(missing.status, 400);
    store.close();
});

// ── handleCrmAction — đúng dây dẫn action → CrmStore, không lộ lỗi 500 cho input sai ─────────────

test('crm-tasks-board / crm-task-approve / crm-task-reject / crm-task-status đi đúng qua handleCrmAction', () => {
    const store = openStore(':memory:', { logger: quiet });
    const crm = new CrmStore(store.db);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc AI', state: 'pending' }]);
    const id = crm.listTasks({ filter: 'all' })[0].id;

    const board = handleCrmAction(crm, 'crm-tasks-board', { groupId: 'g1' });
    assert.equal(board.status, 200);
    assert.equal(board.body.data.columns.pending_review.length, 1);

    const approve = handleCrmAction(crm, 'crm-task-approve', { id });
    assert.equal(approve.status, 200);

    const status = handleCrmAction(crm, 'crm-task-status', { id, status: 'blocked' });
    assert.equal(status.status, 200);
    assert.equal(status.body.data.status, 'blocked');

    const rejectMissing = handleCrmAction(crm, 'crm-task-reject', { id: 'không-tồn-tại' });
    assert.equal(rejectMissing.status, 400, 'lỗi "không tồn tại" phải là 400, không phải 500');
    store.close();
});
