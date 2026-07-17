import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/database.js';
import { CrmStore, LEAD_STAGES } from '../src/crm/crm-store.js';
import { handleCrmAction, CRM_ACTIONS } from '../src/crm/crm-api.js';

const quiet = { info: () => {}, warn: () => {} };

function makeCrm() {
    const store = openStore(':memory:', { logger: quiet });
    return { crm: new CrmStore(store.db), close: () => store.close() };
}

// ── Contacts ──────────────────────────────────────────────────────────────

test('contact: tạo, đọc, cập nhật, tags, xoá', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const c = crm.upsertContact({ displayName: 'Nguyen Van A', zaloUid: 'uid-1', phone: '0901234567', source: 'zalo-group' });
    assert.ok(c.id);
    assert.equal(c.display_name, 'Nguyen Van A');
    assert.deepEqual(c.tags, []);

    // update theo id — không đổi field không truyền
    const c2 = crm.upsertContact({ id: c.id, displayName: 'Nguyen Van A (VIP)' });
    assert.equal(c2.id, c.id);
    assert.equal(c2.phone, '0901234567');
    assert.equal(c2.display_name, 'Nguyen Van A (VIP)');

    const tags = crm.setContactTags(c.id, ['khách sỉ', 'Hot', 'khách sỉ']);
    assert.deepEqual(tags.sort(), ['Hot', 'khách sỉ']);
    assert.deepEqual(crm.getContact(c.id).tags.sort(), ['Hot', 'khách sỉ']);

    assert.equal(crm.deleteContact(c.id), true);
    assert.equal(crm.getContact(c.id), null);
    assert.equal(crm.deleteContact(c.id), false, 'xoá lần 2 trả false');
});

test('contact: thiếu displayName thì ném lỗi', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    assert.throws(() => crm.upsertContact({ zaloUid: 'x' }), /displayName/);
});

test('contact idempotent theo (account, zaloUid): sync lại không nhân đôi', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const a = crm.upsertContact({ displayName: 'A', zaloUid: 'uid-1', accountId: 'acc1' });
    const b = crm.upsertContact({ displayName: 'A đổi tên', zaloUid: 'uid-1', accountId: 'acc1' });
    assert.equal(a.id, b.id);
    // cùng uid nhưng account khác → contact riêng
    const other = crm.upsertContact({ displayName: 'A', zaloUid: 'uid-1', accountId: 'acc2' });
    assert.notEqual(other.id, a.id);
    assert.equal(crm.listContacts({}).total, 2);
});

test('importMembers: đếm created/updated đúng, replay không nhân đôi', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const members = [
        { uid: 'u1', name: 'An', avatar: 'http://a/1.jpg' },
        { uid: 'u2', name: 'Binh' },
        { uid: '', name: 'thiếu uid — bỏ qua' },
    ];
    const r1 = crm.importMembers(members, 'acc1');
    assert.deepEqual({ created: r1.created, updated: r1.updated }, { created: 2, updated: 0 });
    const r2 = crm.importMembers(members, 'acc1');
    assert.deepEqual({ created: r2.created, updated: r2.updated }, { created: 0, updated: 2 });
    assert.equal(crm.listContacts({}).total, 2);
});

test('listContacts: search theo tên/phone, filter theo tag, phân trang', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    for (let i = 0; i < 60; i++) {
        crm.upsertContact({ displayName: `Khách ${i}`, zaloUid: `u${i}`, phone: `09000000${String(i).padStart(2, '0')}` });
    }
    const vip = crm.upsertContact({ displayName: 'Chị Bảy VIP', zaloUid: 'vip-1', phone: '0912345678' });
    crm.setContactTags(vip.id, ['vip']);

    assert.equal(crm.listContacts({ search: 'Bảy' }).total, 1);
    assert.equal(crm.listContacts({ search: '0912345678' }).total, 1);
    assert.equal(crm.listContacts({ tag: 'vip' }).total, 1);
    const page = crm.listContacts({ limit: 50 });
    assert.equal(page.contacts.length, 50);
    assert.equal(page.total, 61);
    const page2 = crm.listContacts({ limit: 50, offset: 50 });
    assert.equal(page2.contacts.length, 11);
});

// ── Leads ─────────────────────────────────────────────────────────────────

test('lead: pipeline mặc định New → ... → Won/Lost, move + history + undo', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    assert.deepEqual([...LEAD_STAGES], ['new', 'contacted', 'qualified', 'quoted', 'won', 'lost']);

    const lead = crm.createLead({ title: 'Đơn 100 thùng', value: 25_000_000 });
    assert.equal(lead.stage, 'new');
    crm.moveLeadStage(lead.id, 'contacted', 'kent');
    const moved = crm.moveLeadStage(lead.id, 'qualified', 'kent');
    assert.equal(moved.stage, 'qualified');

    // undo → về contacted
    const undone = crm.undoLeadStage(lead.id, 'kent');
    assert.equal(undone.stage, 'contacted');

    // move sang lost kèm lý do
    const lost = crm.moveLeadStage(lead.id, 'lost', 'kent', { lossReason: 'giá cao' });
    assert.equal(lost.stage, 'lost');
    assert.equal(lost.loss_reason, 'giá cao');
});

test('lead: validation — stage lạ, value âm, contact ma, đổi stage qua updateLead bị chặn', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    assert.throws(() => crm.createLead({ title: 'x', stage: 'bogus' }), /stage không hợp lệ/);
    assert.throws(() => crm.createLead({ title: 'x', value: -5 }), /value/);
    assert.throws(() => crm.createLead({ title: 'x', contactId: 'ma' }), /contact không tồn tại/);
    assert.throws(() => crm.createLead({}), /title/);
    const lead = crm.createLead({ title: 'ok' });
    assert.throws(() => crm.updateLead(lead.id, { stage: 'won' }), /moveLeadStage/);
});

test('pipeline(): nhóm theo stage + tổng value, kèm tên contact', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const c = crm.upsertContact({ displayName: 'Anh Tư', zaloUid: 'u-tu' });
    crm.createLead({ title: 'L1', value: 100, contactId: c.id });
    crm.createLead({ title: 'L2', value: 200 });
    const l3 = crm.createLead({ title: 'L3', value: 50 });
    crm.moveLeadStage(l3.id, 'won');

    const p = crm.pipeline();
    assert.equal(p.count, 3);
    assert.equal(p.byStage.new.length, 2);
    assert.equal(p.byStage.won.length, 1);
    assert.equal(p.totals.new, 300);
    assert.equal(p.totals.won, 50);
    const withContact = p.byStage.new.find(l => l.title === 'L1');
    assert.equal(withContact.contactName, 'Anh Tư');
});

// ── Tasks ─────────────────────────────────────────────────────────────────

test('task: tạo, done/reopen, overdue flag, filter', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const now = Date.now();
    crm.createTask({ title: 'Gọi lại khách', dueAt: now - 60_000 });      // quá hạn
    const t2 = crm.createTask({ title: 'Gửi báo giá', dueAt: now + 3600_000 });
    crm.createTask({ title: 'Không hạn' });

    const open = crm.listTasks({ filter: 'open' });
    assert.equal(open.length, 3);
    const overdue = crm.listTasks({ filter: 'overdue' });
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].title, 'Gọi lại khách');
    assert.equal(overdue[0].overdue, true);

    crm.setTaskDone(t2.id, true);
    assert.equal(crm.listTasks({ filter: 'done' }).length, 1);
    crm.setTaskDone(t2.id, false);
    assert.equal(crm.listTasks({ filter: 'done' }).length, 0);
    assert.throws(() => crm.listTasks({ filter: 'bogus' }), /filter/);
});

test('task link contact/lead: validate tồn tại, xoá contact/lead thì unlink không mất task', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    assert.throws(() => crm.createTask({ title: 'x', contactId: 'ma' }), /contact/);
    const c = crm.upsertContact({ displayName: 'A', zaloUid: 'u1' });
    const lead = crm.createLead({ title: 'L', contactId: c.id });
    const task = crm.createTask({ title: 'Follow', contactId: c.id, leadId: lead.id });
    assert.equal(crm.listTasks({ contactId: c.id }).length, 1);

    crm.deleteContact(c.id);
    crm.deleteLead(lead.id);
    const after = crm.getTask(task.id);
    assert.ok(after, 'task vẫn còn');
    assert.equal(after.contact_id, null);
    assert.equal(after.lead_id, null);
});

test('stats() cho Overview', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.upsertContact({ displayName: 'A', zaloUid: 'u1' });
    const l = crm.createLead({ title: 'L', value: 500 });
    crm.moveLeadStage(l.id, 'qualified');
    crm.createTask({ title: 'quá hạn', dueAt: Date.now() - 1000 });
    const st = crm.stats();
    assert.equal(st.contacts, 1);
    assert.equal(st.leads.qualified.n, 1);
    assert.equal(st.leads.qualified.total, 500);
    assert.equal(st.tasksOverdue, 1);
});

test('audit log ghi mọi mutation', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const c = crm.upsertContact({ displayName: 'A', zaloUid: 'u1' }, 'kent');
    const l = crm.createLead({ title: 'L' }, 'kent');
    crm.moveLeadStage(l.id, 'won', 'kent');
    crm.deleteContact(c.id, 'kent');
    const logs = crm.listAudit(10);
    const actions = logs.map(x => x.action);
    assert.ok(actions.includes('contact.create'));
    assert.ok(actions.includes('lead.create'));
    assert.ok(actions.includes('lead.move'));
    assert.ok(actions.includes('contact.delete'));
    assert.ok(logs.every(x => x.actor === 'kent'));
});

// ── API handler ───────────────────────────────────────────────────────────

test('handleCrmAction: happy path + lỗi 400/404/503 + action lạ', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const saved = handleCrmAction(crm, 'crm-contact-save', { displayName: 'API Contact', zaloUid: 'api-1' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.ok, true);
    const id = saved.body.data.id;

    assert.equal(handleCrmAction(crm, 'crm-contact-get', { id }).status, 200);
    assert.equal(handleCrmAction(crm, 'crm-contact-get', { id: 'ma' }).status, 404);
    assert.equal(handleCrmAction(crm, 'crm-contact-get', {}).status, 400);
    assert.equal(handleCrmAction(crm, 'crm-lead-create', {}).status, 400, 'thiếu title');
    assert.equal(handleCrmAction(crm, 'crm-bogus', {}).status, 404);
    assert.equal(handleCrmAction(null, 'crm-stats', {}).status, 503, 'CRM tắt khi không có SQLite');

    // luồng lead qua API: create → move → undo
    const lead = handleCrmAction(crm, 'crm-lead-create', { title: 'Đơn API', value: 10 }).body.data;
    const movedRes = handleCrmAction(crm, 'crm-lead-move', { id: lead.id, stage: 'contacted' });
    assert.equal(movedRes.body.data.stage, 'contacted');
    const undoRes = handleCrmAction(crm, 'crm-lead-undo', { id: lead.id });
    assert.equal(undoRes.body.data.stage, 'new');
    assert.equal(handleCrmAction(crm, 'crm-lead-move', { id: lead.id, stage: 'sai' }).status, 400);

    assert.ok(CRM_ACTIONS.length >= 15);
});
