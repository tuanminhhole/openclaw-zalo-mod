import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const source = readFileSync(new URL('index.js', root), 'utf8');

// Bối cảnh (30/08/2026, bot "Em Mơ"): tag `@Em Mơ Trợ Lí helu` thì bot trả lời, nhưng gọi tên trần
// `Em mơ ơi` thì chỉ thả tim. Đo được: zalo-connect ĐÃ cho qua cổng của nó (wasNamed=true,
// skip=false), rồi `isMessageMentioningBot` của zalo-mod chặn lại vì nó chỉ tìm `@ + tên`.
// Không có log nào ở chặng này ⇒ nhìn từ ngoài y hệt "bot câm".
//
// Tính năng dashboard hứa là: chế độ Im lặng, bot trả lời khi được @nhắc HOẶC khi tin **gọi đúng
// tên bot**. Nên hai tầng phải cùng ngữ nghĩa: khớp không dấu + có ranh giới từ.

// Lấy đúng hàm thật trong index.js ra chạy — không chép lại, để test không lệch khỏi bản thật.
function extract(name) {
    const m = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(m, `không tìm thấy function ${name} trong index.js`);
    return new Function(`${m[0]}; return ${name};`)();
}
const isAddressedByBareName = extract('isAddressedByBareName');
const foldText = extract('foldText');
const fold = (s) => foldText(String(s).toLowerCase());

test('gọi tên trần (không có @) phải được tính là đang gọi bot', () => {
    // Đúng các câu thật đã trượt trong nhóm Test bot Thuy Le.
    assert.equal(isAddressedByBareName(fold('Em mơ ơi'), fold('Em Mơ')), true);
    assert.equal(isAddressedByBareName(fold('mơ ơi test1'), fold('Mơ ơi')), true);
    assert.equal(isAddressedByBareName(fold('mơ ơi mấy h r?'), fold('Mơ ơi')), true);
    assert.equal(isAddressedByBareName(fold('em mo oi cho hoi'), fold('Em Mơ')), true, 'gõ không dấu vẫn phải khớp');
});

test('có ranh giới từ — tên không được khớp lọt vào giữa từ khác', () => {
    assert.equal(isAddressedByBareName(fold('embedded text'), fold('em')), false, 'tên nằm trong "embedded"');
    assert.equal(isAddressedByBareName(fold('memory'), fold('em')), false);
});

test('tên dưới 2 ký tự bị bỏ — quá ngắn thì khớp nhầm nhiều hơn trúng', () => {
    assert.equal(isAddressedByBareName(fold('a b c'), 'a'), false);
    assert.equal(isAddressedByBareName(fold('bất kỳ'), ''), false);
});

test('CẢNH BÁO: tên 2 ký tự như "mơ" vẫn khớp từ thường ngày — đừng đưa vào danh sách', () => {
    // Không phải lỗi: có ranh giới từ nên "mơ" trong "mơ ước" VẪN là một từ riêng.
    // Vì vậy danh sách tên gọi phải là cụm ("Mơ ơi", "Em Mơ"), không được để "Mơ" trần.
    assert.equal(isAddressedByBareName(fold('anh mơ ước điều gì'), fold('Mơ')), true);
    // Còn với danh sách đang dùng thật thì hai câu này KHÔNG được đụng vào bot:
    for (const name of ['Em Mơ', 'Mơ ơi', 'Em Mơ Trợ Lí', 'Em Mơ Trợ Lý']) {
        assert.equal(isAddressedByBareName(fold('anh mơ ước điều gì'), fold(name)), false, name);
        assert.equal(isAddressedByBareName(fold('mua quả mơ về ngâm'), fold(name)), false, name);
    }
});

test('Lí và Lý là hai chuỗi khác nhau — bỏ dấu KHÔNG gộp i/y', () => {
    assert.equal(isAddressedByBareName(fold('@Em Mơ Trợ Lý alo'), fold('Em Mơ Trợ Lí')), false);
    assert.equal(isAddressedByBareName(fold('@Em Mơ Trợ Lý alo'), fold('Em Mơ Trợ Lý')), true);
});

test('vòng kiểm tên trong isMessageMentioningBot phải gọi nhánh tên trần', () => {
    const m = source.match(/\/\/ Check all known bot names\/aliases[\s\S]*?\n {4}\}/);
    assert.ok(m, 'không tìm thấy vòng kiểm tên');
    assert.match(m[0], /isAddressedByBareName\(foldedContent, folded\)/, 'thiếu nhánh gọi tên trần');
    assert.match(m[0], /content\.includes\(`@\$\{name\}`\)/, 'vẫn phải giữ nhánh @tên cũ');
});
