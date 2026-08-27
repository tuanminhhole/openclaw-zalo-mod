import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { docKhoMedia, ghepLaiMedia } from '../src/storage/media-backfill.js';

// Ảnh cũ đã mất link VẪN CÒN trên đĩa (OpenClaw tự tải về `.openclaw/media/`), tên tệp mang mốc
// thời gian. Ghép lại theo thời gian cứu được phần lớn — nhưng chỉ khi ghép 1-1, vì gán nhầm ảnh
// của người này sang tin của người khác trong khung chat CRM là hỏng nặng hơn thiếu ảnh.

function khoTam(files) {
    const home = mkdtempSync(join(tmpdir(), 'zm-media-'));
    for (const [kind, name] of files) {
        const dir = join(home, '.openclaw', 'media', kind);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), 'x');
    }
    return home;
}
const storeGia = (rows) => {
    const daGhi = new Map();
    return {
        daGhi,
        messagesWithoutMedia: () => rows,
        setMessageMedia: (id, urls) => { daGhi.set(id, urls); return true; },
    };
};
const MOC = Date.parse('2026-08-21T12:03:47Z');

test('ghép 1-1 theo mốc thời gian trong tên tệp', () => {
    const home = khoTam([['inbound', '2026-08-21T12-03-47-zalo-aaa.jpg']]);
    const store = storeGia([{ id: 'm1', sent_at: MOC + 1200, from_self: 0 }]);
    const kq = ghepLaiMedia(store, home);
    assert.equal(kq.ghep, 1);
    assert.deepEqual(store.daGhi.get('m1'), ['/media/inbound/2026-08-21T12-03-47-zalo-aaa.jpg']);
});

test('NHẬP NHẰNG (2 tệp cùng cửa sổ) thì BỎ QUA, tuyệt đối không đoán', () => {
    const home = khoTam([
        ['inbound', '2026-08-21T12-03-47-zalo-aaa.jpg'],
        ['inbound', '2026-08-21T12-03-49-zalo-bbb.jpg'],
    ]);
    const store = storeGia([{ id: 'm2', sent_at: MOC + 1000, from_self: 0 }]);
    const kq = ghepLaiMedia(store, home);
    assert.equal(kq.ghep, 0);
    assert.equal(kq.boQuaNhapNhang, 1);
    assert.equal(store.daGhi.size, 0, 'không được ghi gì khi còn nhập nhằng');
});

test('tin của bot lấy ảnh ở outbound, không vơ nhầm ảnh inbound cùng giây', () => {
    const home = khoTam([
        ['inbound', '2026-08-21T12-03-47-zalo-khach.jpg'],
        ['outbound', '2026-08-21T12-03-47-zalo-bot.jpg'],
    ]);
    const store = storeGia([{ id: 'm3', sent_at: MOC, from_self: 1 }]);
    ghepLaiMedia(store, home);
    assert.deepEqual(store.daGhi.get('m3'), ['/media/outbound/2026-08-21T12-03-47-zalo-bot.jpg']);
});

test('ngoài cửa sổ dung sai thì không ghép', () => {
    const home = khoTam([['inbound', '2026-08-21T12-03-47-zalo-aaa.jpg']]);
    const store = storeGia([{ id: 'm4', sent_at: MOC + 60000, from_self: 0 }]);
    const kq = ghepLaiMedia(store, home);
    assert.equal(kq.ghep, 0);
    assert.equal(kq.khongCo, 1);
});

test('dryRun đếm được nhưng không ghi gì', () => {
    const home = khoTam([['inbound', '2026-08-21T12-03-47-zalo-aaa.jpg']]);
    const store = storeGia([{ id: 'm5', sent_at: MOC, from_self: 0 }]);
    const kq = ghepLaiMedia(store, home, { dryRun: true });
    assert.equal(kq.ghep, 1);
    assert.equal(store.daGhi.size, 0);
});

test('bỏ qua tệp lạ không mang mốc thời gian', () => {
    const home = khoTam([['inbound', 'i.pdf'], ['inbound', '2026-08-21T12-03-47-zalo-aaa.jpg']]);
    assert.equal(docKhoMedia(home).length, 1);
});
