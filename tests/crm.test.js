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

// ── Trường hồ sơ Zalo (v4): giới tính · ngày sinh · đã kết bạn ────────────

test('contact: lưu và đọc lại gender/birthday/isFriend', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const c = crm.upsertContact({
        displayName: 'Nguyễn Văn A', zaloUid: 'u1',
        gender: 0, birthday: '1990-05-17', isFriend: true, phone: '+84901234567',
    });
    assert.equal(c.gender, 'male', 'số 0 của Zalo được chuẩn hoá lúc ghi');
    assert.equal(c.birthday, '1990-05-17');
    assert.equal(c.is_friend, 1);
    assert.equal(c.phone, '0901234567', 'sđt chuẩn hoá về dạng 0…');
});

test('contact: sync lại bằng trường RỖNG không được xoá dữ liệu đã có', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.upsertContact({ displayName: 'A', zaloUid: 'u1', phone: '0901234567', birthday: '1990-05-17', gender: 1 });

    // Bot thứ hai chưa kết bạn nên Zalo giấu sđt/ngày sinh → hồ sơ trả về rỗng.
    const after = crm.upsertContact({ displayName: 'A', zaloUid: 'u1', phone: '', birthday: '', gender: '' });
    assert.equal(after.phone, '0901234567', 'rỗng = "lần này không biết", không phải "đã bị xoá"');
    assert.equal(after.birthday, '1990-05-17');
    assert.equal(after.gender, 'female');
});

test('importMembers mang theo sđt/ngày sinh/giới tính/bạn bè', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.importMembers([
        { uid: 'u1', name: 'An', phone: '0901234567', birthday: '1990-05-17', gender: 'male', isFriend: true },
        { uid: 'u2', name: 'Bình' },
    ], 'acc1');
    const an = crm.listContacts({ search: 'An' }).contacts[0];
    assert.equal(an.phone, '0901234567');
    assert.equal(an.birthday, '1990-05-17');
    assert.equal(an.gender, 'male');
    assert.equal(an.is_friend, 1);
    const binh = crm.listContacts({ search: 'Bình' }).contacts[0];
    assert.equal(binh.is_friend, 0, 'không truyền isFriend thì mặc định là chưa kết bạn');
});

test('importMembers: isFriend undefined (get-friends hỏng) KHÔNG xoá cờ đã có', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.importMembers([{ uid: 'u1', name: 'An', isFriend: true }], 'acc1');
    crm.importMembers([{ uid: 'u1', name: 'An' }], 'acc1');
    assert.equal(crm.listContacts({ search: 'An' }).contacts[0].is_friend, 1);
});

test('listContacts: lọc theo giới tính và theo đã-kết-bạn', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.upsertContact({ displayName: 'Anh A', zaloUid: 'u1', gender: 'male', isFriend: true });
    crm.upsertContact({ displayName: 'Chị B', zaloUid: 'u2', gender: 'female' });
    crm.upsertContact({ displayName: 'Ẩn danh', zaloUid: 'u3' });

    assert.equal(crm.listContacts({ gender: 'male' }).total, 1);
    assert.equal(crm.listContacts({ gender: 'female' }).total, 1);
    assert.equal(crm.listContacts({ friend: 'only' }).total, 1);
    assert.equal(crm.listContacts({ friend: 'none' }).total, 2, 'chưa kết bạn tính cả NULL lẫn 0');
    assert.equal(crm.listContacts({ gender: 'lạ' }).total, 3, 'giá trị lọc lạ thì bỏ qua, không lọc rỗng');
});

test('listContacts: sinh nhật sắp tới — sắp theo ngày gần nhất, vòng qua giao thừa', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.upsertContact({ displayName: 'Sinh nhật 02/01', zaloUid: 'u1', birthday: '1990-01-02' });
    crm.upsertContact({ displayName: 'Sinh nhật 31/12', zaloUid: 'u2', birthday: '1991-12-31' });
    crm.upsertContact({ displayName: 'Sinh nhật tháng 6', zaloUid: 'u3', birthday: '1992-06-15' });
    crm.upsertContact({ displayName: 'Không rõ ngày sinh', zaloUid: 'u4' });

    // Đứng ở 30/12: 31/12 là 1 ngày nữa, 02/01 là 3 ngày nữa — phải vòng sang năm sau, không âm.
    const today = new Date(2026, 11, 30);
    const soon = crm.listContacts({ birthdayWithin: 7, today });
    assert.deepEqual(soon.contacts.map(c => c.display_name), ['Sinh nhật 31/12', 'Sinh nhật 02/01']);
    assert.deepEqual(soon.contacts.map(c => c.birthdayInDays), [1, 3]);
    assert.equal(soon.total, 2, 'người không có ngày sinh không lọt vào');

    assert.equal(crm.listContacts({ birthdayWithin: 0, today }).total, 0);
    assert.equal(crm.listContacts({ birthdayWithin: 400, today }).total, 3);
});

test('listContacts: lọc sinh nhật cộng dồn được với lọc khác, và phân trang đúng', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    crm.upsertContact({ displayName: 'Nam sinh 02/01', zaloUid: 'u1', birthday: '1990-01-02', gender: 'male' });
    crm.upsertContact({ displayName: 'Nữ sinh 03/01', zaloUid: 'u2', birthday: '1990-01-03', gender: 'female' });
    const today = new Date(2026, 11, 30);
    assert.equal(crm.listContacts({ birthdayWithin: 30, gender: 'male', today }).total, 1);
    const page = crm.listContacts({ birthdayWithin: 30, limit: 1, today });
    assert.equal(page.contacts.length, 1);
    assert.equal(page.total, 2, 'total là tổng đã lọc, không phải số bản ghi trên trang');
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

// ── Nối khách hàng ↔ nhóm Zalo ────────────────────────────────────────────
// Vì sao CRM v2 vô dụng với owner: không có đường nào trỏ tới NHÓM Zalo, nên khách hàng đứng rời
// khỏi thứ duy nhất bot đang quan sát. Và form chỉ gõ tay nên contact mới không có `zalo_uid` →
// không bao giờ nối lại được.

test('nhóm: nối, đọc lại, và replace bỏ được nhóm đã nối sai', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const c = crm.upsertContact({ displayName: 'Chị Lê', zaloUid: 'uid-le' });

    crm.setContactGroups(c.id, [
        { groupId: 'g1', name: 'ASA 7570' },
        { groupId: 'g2', name: 'ASACHINA ZALO' },
    ]);
    assert.deepEqual(crm.getContact(c.id).groups.map(g => g.groupId).sort(), ['g1', 'g2']);

    // Replace, KHÔNG merge — bỏ tick trên UI phải bỏ liên kết thật.
    crm.setContactGroups(c.id, [{ groupId: 'g2', name: 'ASACHINA ZALO' }]);
    assert.deepEqual(crm.getContact(c.id).groups.map(g => g.groupId), ['g2']);

    crm.setContactGroups(c.id, []);
    assert.deepEqual(crm.getContact(c.id).groups, []);
});

test('nhóm: groupId rỗng bị bỏ, chuỗi thuần cũng nhận được', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const c = crm.upsertContact({ displayName: 'X' });
    crm.setContactGroups(c.id, ['g9', '', null, { groupId: '  ', name: 'rác' }, { groupId: 'g8', name: 'Tám' }]);
    assert.deepEqual(crm.getContact(c.id).groups.map(g => g.groupId).sort(), ['g8', 'g9']);
});

test('nhóm: khách không tồn tại thì báo lỗi, không ghi mồ côi', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    assert.throws(() => crm.setContactGroups('khong-co', [{ groupId: 'g1' }]), /không tồn tại/i);
});

test('listContactsByGroup: mở nhóm ra thấy ai trong đó đã là khách', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const a = crm.upsertContact({ displayName: 'A', zaloUid: 'u-a' });
    const b = crm.upsertContact({ displayName: 'B', zaloUid: 'u-b' });
    crm.upsertContact({ displayName: 'C', zaloUid: 'u-c' });
    crm.setContactGroups(a.id, [{ groupId: 'g1', name: 'Nhóm 1' }]);
    crm.setContactGroups(b.id, [{ groupId: 'g1', name: 'Nhóm 1' }, { groupId: 'g2', name: 'Nhóm 2' }]);
    assert.deepEqual(crm.listContactsByGroup('g1').map(c => c.display_name), ['A', 'B']);
    assert.deepEqual(crm.listContactsByGroup('g2').map(c => c.display_name), ['B']);
    assert.deepEqual(crm.listContactsByGroup('g-trong'), []);
});

test('listContacts: lọc theo nhóm và theo đã-nối-Zalo hay chưa', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const linked = crm.upsertContact({ displayName: 'Có uid', zaloUid: 'u-1' });
    crm.upsertContact({ displayName: 'Gõ tay' }); // không uid → không mở được lịch sử chat
    crm.setContactGroups(linked.id, [{ groupId: 'g1', name: 'Nhóm 1' }]);

    assert.deepEqual(crm.listContacts({ groupId: 'g1' }).contacts.map(c => c.display_name), ['Có uid']);
    assert.deepEqual(crm.listContacts({ linked: 'only' }).contacts.map(c => c.display_name), ['Có uid']);
    assert.deepEqual(crm.listContacts({ linked: 'none' }).contacts.map(c => c.display_name), ['Gõ tay']);
    assert.equal(crm.listContacts({}).total, 2);
});

test('importMembers nối luôn nhóm, và import lại KHÔNG mất nhóm cũ', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const r1 = crm.importMembers([
        { uid: 'u-1', name: 'Người Một', groups: [{ groupId: 'g1', name: 'Nhóm 1' }] },
    ]);
    assert.equal(r1.created, 1);
    const c = crm.listContacts({}).contacts[0];
    assert.deepEqual(c.groups.map(g => g.groupId), ['g1']);

    // Import lần hai từ nhóm KHÁC: phải gộp, không xoá g1.
    const r2 = crm.importMembers([
        { uid: 'u-1', name: 'Người Một', groups: [{ groupId: 'g2', name: 'Nhóm 2' }] },
    ]);
    assert.equal(r2.updated, 1);
    assert.equal(r2.created, 0, 'cùng uid thì không nhân đôi');
    assert.deepEqual(crm.getContact(c.id).groups.map(g => g.groupId).sort(), ['g1', 'g2']);
});

test('lead và task gắn được nhóm Zalo, sửa và bỏ gắn được', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const lead = crm.createLead({ title: 'Đơn Mai Anh', groupId: 'g7' });
    assert.equal(lead.group_id, 'g7');
    assert.equal(crm.updateLead(lead.id, { groupId: 'g8' }).group_id, 'g8');
    assert.equal(crm.updateLead(lead.id, { groupId: '' }).group_id, null, 'bỏ gắn nhóm được');
    assert.equal(crm.updateLead(lead.id, { title: 'Đổi tên' }).group_id, null, 'không truyền groupId thì giữ nguyên');

    const task = crm.createTask({ title: 'Gọi khách', groupId: 'g7' });
    assert.equal(task.group_id, 'g7');
    assert.equal(crm.createTask({ title: 'Không nhóm' }).group_id, null);
});

test('API: crm-contact-groups và crm-contacts-by-group đi qua handler', (t) => {
    const { crm, close } = makeCrm();
    t.after(close);
    const c = crm.upsertContact({ displayName: 'Qua API', zaloUid: 'u-api' });
    const r = handleCrmAction(crm, 'crm-contact-groups', { id: c.id, groups: [{ groupId: 'g1', name: 'Nhóm 1' }] }, 'owner');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.groups.map(g => g.groupId), ['g1']);
    const list = handleCrmAction(crm, 'crm-contacts-by-group', { groupId: 'g1' }, 'owner');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.contacts.map(x => x.display_name), ['Qua API']);
    assert.ok(CRM_ACTIONS.includes('crm-contact-groups'));

    // Khách không tồn tại là lỗi NHẬP LIỆU → phải 400, không phải 500.
    const bad = handleCrmAction(crm, 'crm-contact-groups', { id: 'khong-co', groups: [] }, 'owner');
    assert.equal(bad.status, 400);
});
