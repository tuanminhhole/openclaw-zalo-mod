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
    assert.deepEqual(r, { inserted: 1, updated: 0, closed: 0, skipped: [] });
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
    assert.deepEqual(r2, { inserted: 0, updated: 1, closed: 0, skipped: [] });
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
    assert.deepEqual(crm.reconcileGroupOpenItems('g1', '2026-08-19', []), { inserted: 0, updated: 0, closed: 0, skipped: [] });
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

test('rejectTask: xoá hẳn việc đang chờ xác nhận; không cho từ chối việc đã duyệt', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc AI', state: 'pending' }]);
    const id = crm.listTasks({ filter: 'all' })[0].id;
    assert.deepEqual(crm.rejectTask(id), { deleted: true });
    assert.equal(crm.getTask(id), null);

    crm.reconcileGroupOpenItems('g1', '2026-08-18', [{ what: 'Việc AI 2', state: 'pending' }]);
    const id2 = crm.listTasks({ filter: 'all' })[0].id;
    crm.approveTask(id2);
    assert.throws(() => crm.rejectTask(id2), /chờ xác nhận/);
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
