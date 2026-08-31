import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const source = readFileSync(new URL('index.js', root), 'utf8');

// Bối cảnh (30/08/2026, bot "Em Mơ"): Kent lưu tên gọi trong hộp thoại "Chế độ Im lặng", bot vẫn
// không trả lời khi gọi tên vừa lưu. Đo được:
//     settings.json  08:57  {"default":["Mơ ơi","Em Mơ","trợ lý mơ","trợ lí mơ"]}   ← nút Lưu CÓ ăn
//     config.json    08:10  ["Em Mơ","Mơ ơi","Em Mơ Trợ Lí","Em Mơ Trợ Lý"]         ← kho khác hẳn
// Nút Lưu chạy đúng; lỗi là TÊN GỌI NẰM Ở HAI KHO và `isMessageMentioningBot` chỉ đọc một.
//
// Hệ quả rất khó chẩn: zalo-connect đọc kho đúng (qua bridge replay) nên CHO QUA cổng của nó, rồi
// zalo-mod chặn lại ở cổng sau — nhìn từ ngoài y hệt "đã lưu mà bot câm", và không có log nào.

function extractFn(name) {
    const m = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n {4}\\}|function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(m, `không tìm thấy function ${name}`);
    return m[0];
}

test('bên GHI và bên ĐỌC tên gọi phải dùng CHUNG một khoá setting', () => {
    // Đây là bất biến thật: đổi tên khoá ở một bên là hỏng im lặng, không có lỗi nào bắn ra.
    const writer = extractFn('persistNameTriggers');
    const writerKey = writer.match(/setSetting\('global',\s*'([^']+)'/);
    assert.ok(writerKey, 'persistNameTriggers phải ghi qua setSetting(global, <khoá>)');

    const reader = extractFn('isMessageMentioningBot');
    assert.ok(
        reader.includes(writerKey[1]),
        `isMessageMentioningBot phải đọc đúng khoá "${writerKey[1]}" mà persistNameTriggers ghi`,
    );
});

test('isMessageMentioningBot phải đọc settings.json, không chỉ config.json', () => {
    const reader = extractFn('isMessageMentioningBot');
    assert.match(reader, /settings\.json/, 'thiếu thì mọi tên lưu từ dashboard đều vô hình với cổng này');
    assert.match(reader, /config\.json/, 'vẫn phải giữ đường config.json cũ');
});

test('replay sang zalo-connect đọc cùng kho với dashboard', () => {
    // zalo-connect nhận tên gọi qua replayNameTriggers → readTriggerMap. Nếu hai đường này lệch kho
    // thì tầng 1 và tầng 3 sẽ bất đồng, đúng cái đã xảy ra.
    const replay = extractFn('replayNameTriggers');
    assert.match(replay, /readTriggerMap\(\)/, 'replay phải đọc từ đúng trigger map đã lưu');
    const writerKey = extractFn('persistNameTriggers').match(/setSetting\('global',\s*'([^']+)'/)[1];
    const mapReader = source.match(/function readTriggerMap\(\)[\s\S]*?\n {8}\}/);
    assert.ok(mapReader, 'không tìm thấy readTriggerMap');
    assert.ok(mapReader[0].includes(writerKey), 'readTriggerMap phải đọc đúng khoá persistNameTriggers ghi');
});

test('tên lấy từ dashboard được CỘNG THÊM, không thay thế tên trong config', () => {
    const reader = extractFn('isMessageMentioningBot');
    assert.match(
        reader,
        /searchNames = \[\.\.\.searchNames, \.\.\.saved\.map\(String\)\]/,
        'phải gộp cả hai nguồn — thay thế sẽ làm mất botName/zaloDisplayNames',
    );
});
