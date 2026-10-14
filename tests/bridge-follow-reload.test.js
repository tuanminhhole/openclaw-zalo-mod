import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenclawAdapter } from '../src/integration/openclaw-adapter.js';

// vps_asa 14/10/2026: zalo-connect bị cài lại khi gateway đang chạy, bridge service đổi object,
// listener của zalo-mod treo trên service cũ nên khung chat ngừng ghi tin.
function fakeService() {
    const handlers = new Set();
    return {
        handlers,
        subscribeInbound(cb) { handlers.add(cb); return () => handlers.delete(cb); },
        subscribeHistory(cb) { handlers.add(cb); return () => handlers.delete(cb); },
        subscribeTyping(cb) { handlers.add(cb); return () => handlers.delete(cb); },
        emit(ev) { for (const h of handlers) h(ev); },
    };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('đăng ký lại vào bridge service mới sau khi zalo-connect bị thay nóng', async () => {
    let svc = fakeService();
    const adapter = createOpenclawAdapter({ logger: { info() {}, warn() {} }, getZaloConnectService: () => svc, bridgeFollowMs: 10 });
    const got = [];
    const off = adapter.subscribeInbound((ev) => got.push(ev));
    svc.emit('a');
    const oldSvc = svc;
    svc = fakeService(); // bản zalo-connect mới gán service mới
    await wait(40);
    svc.emit('b');
    assert.deepEqual(got, ['a', 'b'], 'tin từ service mới vẫn tới');
    assert.equal(oldSvc.handlers.size, 0, 'đã huỷ đăng ký ở service cũ, không giữ rác');
    assert.equal(svc.handlers.size, 1, 'chỉ một listener trên service mới, không ghi trùng');
    off();
    assert.equal(svc.handlers.size, 0, 'huỷ đăng ký dọn sạch');
});

test('zalo-mod nạp trước zalo-connect: tự bắt bridge khi nó xuất hiện', async () => {
    let svc = null;
    const adapter = createOpenclawAdapter({ logger: { info() {}, warn() {} }, getZaloConnectService: () => svc, bridgeFollowMs: 10 });
    const got = [];
    const off = adapter.subscribeInbound((ev) => got.push(ev));
    svc = fakeService();
    await wait(40);
    svc.emit('x');
    assert.deepEqual(got, ['x']);
    off();
});

test('history/typing: runtime chưa hỗ trợ vẫn trả null như trước', () => {
    const adapter = createOpenclawAdapter({ logger: { info() {}, warn() {} }, getZaloConnectService: () => ({}), bridgeFollowMs: 0 });
    assert.equal(adapter.subscribeHistory(() => {}), null);
    assert.equal(adapter.subscribeTyping(() => {}), null);
});
