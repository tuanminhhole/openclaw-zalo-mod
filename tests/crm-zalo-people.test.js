import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    birthdayDayMonth,
    buildZaloPeople,
    daysUntilBirthday,
    normalizeGender,
    normalizePhone,
} from '../src/crm/zalo-people.js';

// ── Chuẩn hoá từng trường ─────────────────────────────────────────────────

test('sđt: +84/84/khoảng trắng đều về dạng 0…', () => {
    assert.equal(normalizePhone('+84901234567'), '0901234567');
    assert.equal(normalizePhone('84901234567'), '0901234567');
    assert.equal(normalizePhone('0901 234 567'), '0901234567');
    assert.equal(normalizePhone('090.123.4567'), '0901234567');
    assert.equal(normalizePhone(''), '');
    assert.equal(normalizePhone(null), '');
    // `84` ngắn không phải mã vùng — đừng cắt bừa thành `0`
    assert.equal(normalizePhone('8412'), '8412');
});

test('giới tính: số 0/1 của Zalo, chuỗi, và kiểu lạ thì null chứ không đoán', () => {
    assert.equal(normalizeGender(0), 'male');
    assert.equal(normalizeGender('0'), 'male');
    assert.equal(normalizeGender(1), 'female');
    assert.equal(normalizeGender('Nữ'), 'female');
    assert.equal(normalizeGender('male'), 'male');
    assert.equal(normalizeGender(7), null);
    assert.equal(normalizeGender(''), null);
    assert.equal(normalizeGender(undefined), null);
});

test('ngày sinh: parse ISO và DD/MM, bỏ năm, kiểu lạ thì null', () => {
    assert.deepEqual(birthdayDayMonth('1990-05-17'), { day: 17, month: 5 });
    assert.deepEqual(birthdayDayMonth('1990-05-17T00:00:00Z'), { day: 17, month: 5 });
    assert.deepEqual(birthdayDayMonth('17/05/1990'), { day: 17, month: 5 });
    assert.deepEqual(birthdayDayMonth('17-05'), { day: 17, month: 5 });
    // Số sau > 12 thì chắc chắn nó mới là ngày → hoán lại
    assert.deepEqual(birthdayDayMonth('05/17/1990'), { day: 17, month: 5 });
    // Nhập nhằng: cả hai <= 12 → theo quy ước VN là DD/MM
    assert.deepEqual(birthdayDayMonth('05/06/1990'), { day: 5, month: 6 });
    assert.equal(birthdayDayMonth('không rõ'), null);
    assert.equal(birthdayDayMonth(''), null);
    assert.equal(birthdayDayMonth('1990-13-40'), null);
});

test('sinh nhật sắp tới: đếm đúng, vòng qua giao thừa, và 29/02 năm thường', () => {
    const jun10 = new Date(2026, 5, 10);
    assert.equal(daysUntilBirthday({ day: 10, month: 6 }, jun10), 0, 'đúng hôm nay');
    assert.equal(daysUntilBirthday({ day: 13, month: 6 }, jun10), 3);
    // Sinh nhật đã qua trong năm → nhìn sang năm sau, không ra số âm
    assert.ok(daysUntilBirthday({ day: 1, month: 1 }, jun10) > 180);

    // Vòng qua giao thừa: 30/12 nhìn tới 02/01 phải là 3 ngày
    assert.equal(daysUntilBirthday({ day: 2, month: 1 }, new Date(2026, 11, 30)), 3);

    // 29/02 trong năm không nhuận rơi về 01/03 thay vì biến mất
    assert.equal(daysUntilBirthday({ day: 29, month: 2 }, new Date(2026, 1, 27)), 2);
    assert.equal(daysUntilBirthday(null, jun10), null);
});

// ── Gộp nguồn ─────────────────────────────────────────────────────────────

const GROUPS = { g1: 'Nhóm ASA', g2: 'Nhóm Khách' };
const nameOf = (id) => GROUPS[id] || id;

test('gộp: một người ở hai nhóm ra MỘT bản ghi kèm cả hai nhóm', () => {
    const people = buildZaloPeople({
        memberDir: { g1: { u1: 'Nguyen Van A' }, g2: { u1: 'Nguyen Van A' } },
        groupNameOf: nameOf,
    });
    assert.equal(people.length, 1);
    assert.deepEqual(people[0].groups, [
        { groupId: 'g1', name: 'Nhóm ASA' },
        { groupId: 'g2', name: 'Nhóm Khách' },
    ]);
});

test('gộp: hồ sơ cache bơm sđt/ngày sinh/giới tính, và tên hồ sơ thắng tên trong nhóm', () => {
    const people = buildZaloPeople({
        memberDir: { g1: { u1: 'A (tên cũ trong nhóm)' } },
        profileCache: {
            u1: { displayName: 'Nguyễn Văn A', avatar: 'http://a.jpg', sdob: '1990-05-17', phoneNumber: '+84901234567', gender: 0 },
        },
        groupNameOf: nameOf,
    });
    assert.equal(people[0].name, 'Nguyễn Văn A', 'hồ sơ đồng bộ mới hơn tên chép trong nhóm');
    assert.equal(people[0].phone, '0901234567');
    assert.equal(people[0].birthday, '1990-05-17');
    assert.equal(people[0].gender, 'male');
    assert.equal(people[0].avatar, 'http://a.jpg');
});

test('gộp: không có hồ sơ thì vẫn ra người, chỉ là trống trường', () => {
    const people = buildZaloPeople({ memberDir: { g1: { u1: 'Chị Bảy' } }, groupNameOf: nameOf });
    assert.equal(people.length, 1);
    assert.equal(people[0].phone, '');
    assert.equal(people[0].birthday, '');
    assert.equal(people[0].gender, null);
});

test('gộp: uid có hậu tố _0 là CÙNG một người', () => {
    const people = buildZaloPeople({
        memberDir: { g1: { 'u1_0': 'Nguyen Van A' }, g2: { u1: 'Nguyen Van A' } },
        groupNameOf: nameOf,
    });
    assert.equal(people.length, 1);
    assert.equal(people[0].uid, 'u1');
    assert.equal(people[0].groups.length, 2);
});

test('gộp: người không có tên ở đâu cả thì bị bỏ', () => {
    const people = buildZaloPeople({ memberDir: { g1: { u1: '', u2: 'Có tên' } }, groupNameOf: nameOf });
    assert.deepEqual(people.map(p => p.uid), ['u2']);
});

test('gộp: bạn bè KHÔNG ở nhóm nào vẫn vào danh sách, nguồn là zalo-friend', () => {
    const people = buildZaloPeople({
        memberDir: { g1: { u1: 'Trong nhóm' } },
        profileCache: { u9: { displayName: 'Bạn nhắn riêng' } },
        friendIds: ['u9'],
        groupNameOf: nameOf,
    });
    const friend = people.find(p => p.uid === 'u9');
    assert.ok(friend, 'bạn bè chỉ nhắn riêng vẫn là khách hàng thật');
    assert.equal(friend.source, 'zalo-friend');
    assert.deepEqual(friend.groups, []);
    assert.equal(friend.isFriend, true);
});

test('gộp: friendIds null = KHÔNG BIẾT (isFriend undefined), khác hẳn danh sách rỗng = không phải bạn', () => {
    const base = { memberDir: { g1: { u1: 'A' } }, groupNameOf: nameOf };

    const unknown = buildZaloPeople({ ...base });
    assert.equal(unknown[0].isFriend, undefined,
        'get-friends hỏng thì không được kết luận là "không phải bạn" — sẽ xoá cờ đã có');

    const known = buildZaloPeople({ ...base, friendIds: [] });
    assert.equal(known[0].isFriend, false);

    const yes = buildZaloPeople({ ...base, friendIds: ['u1_0'] });
    assert.equal(yes[0].isFriend, true, 'so uid sau khi bỏ hậu tố _0');
});

test('gộp: dữ liệu vào rỗng/hỏng thì trả mảng rỗng, không ném', () => {
    assert.deepEqual(buildZaloPeople(), []);
    assert.deepEqual(buildZaloPeople({ memberDir: null }), []);
    assert.deepEqual(buildZaloPeople({ memberDir: { g1: 'không phải object' } }), []);
});
