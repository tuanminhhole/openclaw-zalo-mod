import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const source = readFileSync(new URL('index.js', root), 'utf8');

// Bối cảnh (02/09/2026, bot "Trợ Lý Cô Minh Thư"): store có 30 nhóm, dashboard chỉ hiện 29,
// bot trả lời "đã đồng bộ 30 nhóm" — owner tưởng đồng bộ sai. Thủ phạm: dedupe-theo-tên của
// dashboard (thiết kế cho multi-bot: cùng tên = cùng nhóm vật lý) nuốt mất một trong hai nhóm
// THẬT trùng tên "Tài Liệu"/"tài liệu" của CÙNG MỘT bot. Luật đúng: chỉ gộp khi hai bản ghi
// đến từ bot khác nhau.

test('dedupe theo tên phải TÁCH khi hai bản ghi cùng một bot', () => {
    const m = source.match(/const _exProfs = parseProfiles\(existing\.profile\);[\s\S]*?if \(_sharesBot\) \{[\s\S]*?byName\.set\(`id:\$\{group\.groupId\}`, seed\(group\)\);[\s\S]*?continue;[\s\S]*?\}/);
    assert.ok(m, 'thiếu nhánh tách nhóm trùng tên của cùng một bot — UI sẽ nuốt mất nhóm');
});

test('bảng chân trị _sharesBot đúng với biểu thức đang dùng', () => {
    // Trích đúng biểu thức trong index.js ra chạy, kèm parseProfiles thật.
    const pm = source.match(/function parseProfiles\([\s\S]*?\n {8}\}/) || source.match(/function parseProfiles\([\s\S]*?\n\}/);
    assert.ok(pm, 'không tìm thấy parseProfiles');
    const em = source.match(/const _exProfs = parseProfiles\(existing\.profile\);\s*const _gProfs = parseProfiles\(group\.profile\);\s*const _sharesBot = ([\s\S]*?);/);
    assert.ok(em, 'không tìm thấy biểu thức _sharesBot');
    const decide = new Function('existing', 'group', `${pm[0]};
        const _exProfs = parseProfiles(existing.profile);
        const _gProfs = parseProfiles(group.profile);
        return ${em[1]};`);
    // Ca thật: cùng bot default, 2 nhóm trùng tên → PHẢI tách (sharesBot=true).
    assert.equal(decide({ profile: 'default' }, { profile: 'default' }), true);
    // Hai bot khác nhau thấy cùng nhóm vật lý → gộp như thiết kế cũ.
    assert.equal(decide({ profile: 'default' }, { profile: 'phu' }), false);
    // Bản gộp nhiều bot + bản mới của một bot đã nằm trong đó → vẫn là cùng bot → tách.
    assert.equal(decide({ profile: 'default,phu' }, { profile: 'default' }), true);
    // Cả hai rỗng (dữ liệu cũ không ghi profile) → coi là cùng bot default → tách, đừng nuốt.
    assert.equal(decide({ profile: '' }, { profile: '' }), true);
});
