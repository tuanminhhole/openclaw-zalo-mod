import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversationBuffer } from '../src/context/conversation-buffer.js';

// Sự cố 27/08/2026 (khung chat bot BS Tuấn): ảnh gửi trực tiếp hiện thành đúng một dòng chữ
// "[Media attachment]". Dữ liệu bị đánh rơi qua BA chặng nối tiếp, mỗi chặng mất một phần:
//   1. zalo-mod-engine.captureInbound() destructure thiếu `attachments`
//   2. ConversationBuffer.record() giữ attachment nhưng CẮT trường `url`
//   3. ConversationBuffer._persist() không truyền `mediaUrls` xuống SQLite
// Vá một chặng là chưa đủ — nên test đi hết chuỗi, tới tận bản ghi cuối cùng.
// Khó đoán ở chỗ: tin KÉO VỀ bằng Sync đi đường khác (`insertMessages`) nên vẫn có ảnh,
// chỉ tin bắt TRỰC TIẾP mới mất — nhìn dashboard thấy lúc có lúc không.

function bufferVoiDau() {
    const ghi = [];
    const buffer = new ConversationBuffer({ storage: { insertMessage: (rec) => ghi.push(rec) } });
    return { buffer, ghi };
}

const ANH = 'https://f64-zpg-r.zdn.vn/959996444363849703/337a2f2eed936ccd3582.jpg';

test('ảnh gửi trực tiếp: link đi tới tận bản ghi SQLite (mediaUrls)', () => {
    const { buffer, ghi } = bufferVoiDau();

    buffer.record({
        accountId: 'acc', conversationId: 'group:123', messageId: 'm1',
        senderId: '9', senderName: 'Bs Tuấn', text: '[Media attachment]', timestamp: 1,
        attachments: [{ kind: 'image', filename: 'a.jpg', mime: 'image/jpeg', size: 10, url: ANH }],
    });

    assert.equal(ghi.length, 1);
    assert.deepEqual(ghi[0].mediaUrls, [ANH], 'mediaUrls phải xuống tới storage.insertMessage');
});

test('record() giữ nguyên url trong attachments (chặng hay bị cắt nhất)', () => {
    const { buffer } = bufferVoiDau();
    const rec = buffer.record({
        accountId: 'acc', conversationId: 'dm:1', messageId: 'm2',
        senderId: '9', senderName: 'X', text: '', timestamp: 2,
        attachments: [{ kind: 'image', filename: 'b.png', mime: 'image/png', size: 5, url: ANH }],
    });
    assert.equal(rec.attachments[0].url, ANH);
});

test('tin không có tệp: mediaUrls rỗng, không sinh rác', () => {
    const { buffer, ghi } = bufferVoiDau();
    buffer.record({
        accountId: 'acc', conversationId: 'dm:1', messageId: 'm3',
        senderId: '9', senderName: 'X', text: 'chào cô', timestamp: 3,
    });
    assert.deepEqual(ghi[0].mediaUrls, []);
});

test('attachment thiếu url (tệp chưa có link) thì bị loại, không đẩy undefined xuống DB', () => {
    const { buffer, ghi } = bufferVoiDau();
    buffer.record({
        accountId: 'acc', conversationId: 'dm:1', messageId: 'm4',
        senderId: '9', senderName: 'X', text: '', timestamp: 4,
        attachments: [{ kind: 'file', filename: 'c.pdf' }, { kind: 'image', url: ANH }],
    });
    assert.deepEqual(ghi[0].mediaUrls, [ANH]);
});
