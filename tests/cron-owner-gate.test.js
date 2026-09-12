/**
 * Lượt CRON của owner phải được cấp tool - nếu không, lịch tự động vĩnh viễn vô dụng.
 *
 * Ca thật 15/09/2026 trên máy khách: lịch báo cáo doanh số 22:00 chạy bằng cron. Lượt cron không có
 * `requesterSenderId` (không ai nhắn cả) nên gate owner trả false, plugin đưa ra 0 tool, bot mất
 * `zalo_mod_action` và **bịa ra "API lấy lịch sử chat trả HTTP 404 ở cả 4 nhóm"** rồi gửi cho khách.
 * Dữ liệu vẫn đủ (9001 tin trong context.db) và gọi tay thì `ok=true` - chỉ đường cron là chết.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedOwnerContext, isOwnerScheduledRun } from '../src/agent/tool-surface.js';

const OWNERS = new Set(['2217625920592607252']);

test('cron của owner: không có người gửi thì vẫn được cấp tool', () => {
    const ctx = {
        requesterSenderId: undefined,
        senderIsOwner: undefined,
        sessionKey: 'agent:em-mo:cron:ab0523ea-3272-447f-b9ac-8fbfddd48869:run:479783c5-2cfa',
    };
    assert.equal(isOwnerScheduledRun(ctx), true);
    assert.equal(isTrustedOwnerContext(ctx, OWNERS), true, 'trước bản vá trả false, lịch 22:00 không bao giờ chạy nổi');
});

test('người lạ nhắn trong nhóm: vẫn chặn như cũ', () => {
    const ctx = {
        requesterSenderId: '3664720995031435529',
        senderIsOwner: false,
        sessionKey: 'agent:em-mo:zalo-connect:group:8719637058580372432',
    };
    assert.equal(isTrustedOwnerContext(ctx, OWNERS), false);
});

test('lượt cron KÈM người gửi không phải owner: vẫn chặn', () => {
    // Phần `!requesterSenderId` là cố ý: không mở cửa chỉ vì tên session có chữ cron.
    const ctx = {
        requesterSenderId: '3664720995031435529',
        senderIsOwner: false,
        sessionKey: 'agent:em-mo:cron:ab0523ea:run:479783c5',
    };
    assert.equal(isOwnerScheduledRun(ctx), false);
    assert.equal(isTrustedOwnerContext(ctx, OWNERS), false);
});

test('session thường không có người gửi: KHÔNG được cấp tool', () => {
    // Thiếu sender ở một phiên kênh là dữ liệu hỏng, không phải lịch tự động.
    const ctx = { requesterSenderId: '', senderIsOwner: undefined, sessionKey: 'agent:em-mo:zalo-connect:group:123' };
    assert.equal(isOwnerScheduledRun(ctx), false);
    assert.equal(isTrustedOwnerContext(ctx, OWNERS), false);
});

test('chữ "cron" nằm giữa tên nhóm không mở được cửa', () => {
    const ctx = { requesterSenderId: '', sessionKey: 'agent:em-mo:zalo-connect:group:my-cronies' };
    assert.equal(isOwnerScheduledRun(ctx), false);
});

test('owner nhắn trực tiếp và cờ senderIsOwner: giữ nguyên hành vi cũ', () => {
    assert.equal(isTrustedOwnerContext({ requesterSenderId: '2217625920592607252' }, OWNERS), true);
    assert.equal(isTrustedOwnerContext({ senderIsOwner: true, requesterSenderId: 'x' }, OWNERS), true);
});

test('tầng 2: lượt cron phải qua được cả guard lúc THỰC THI, không chỉ lúc cấp tool', async () => {
    // Bản vá đầu chỉ mở gate ở factory. Trên máy khách, tool được cấp nhưng mọi lời gọi vẫn chết ở
    // `guard` ("requester=unknown không phải owner") vì guard dựng lại context THIẾU sessionKey.
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/agent/tool-surface.js', import.meta.url), 'utf8'));
    const at = src.indexOf('return function zaloModToolFactory');
    const factory = src.slice(at, at + 1800);
    assert.match(factory, /isOwnerScheduledRun\(toolContext\)/, 'factory phải tính cờ lượt-cron');
    assert.match(
        factory,
        /buildTools\(requesterSenderId,\s*toolContext\?\.senderIsOwner === true \|\| ownerScheduled\)/,
        'cờ đó phải đi xuống buildTools, nếu không guard sẽ chặn lại đúng thứ vừa mở',
    );
});
