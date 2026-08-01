/**
 * CRM API — handler thuần (không dính HTTP) để test không cần server.
 * index.js chỉ việc: const res = handleCrmAction(crmStore, action, payload)
 * rồi sendJson(res.status, res.body).
 *
 * Mọi lỗi validation trả 400 kèm message; không bao giờ throw ra ngoài.
 */

import { LEAD_STAGES } from './crm-store.js';

const ACTIONS = {
    // Contacts
    'crm-contacts-list': (crm, p) => crm.listContacts(p || {}),
    'crm-contact-get': (crm, p) => {
        const c = crm.getContact(required(p, 'id'));
        if (!c) throw new NotFound('contact không tồn tại');
        return c;
    },
    'crm-contact-save': (crm, p, actor) => crm.upsertContact(p || {}, actor),
    'crm-contact-tags': (crm, p, actor) => ({
        tags: crm.setContactTags(required(p, 'id'), p.tags || [], actor),
    }),
    'crm-contact-delete': (crm, p, actor) => ({ deleted: crm.deleteContact(required(p, 'id'), actor) }),
    'crm-contacts-import': (crm, p, actor) => crm.importMembers(p?.members || [], p?.accountId || 'default', actor),
    // Nối khách hàng ↔ nhóm Zalo. Replace toàn bộ, để bỏ tick một nhóm trên UI là bỏ liên kết thật.
    'crm-contact-groups': (crm, p, actor) => ({
        groups: crm.setContactGroups(required(p, 'id'), p.groups || [], actor),
    }),
    'crm-contacts-by-group': (crm, p) => ({
        contacts: crm.listContactsByGroup(required(p, 'groupId'), p.limit),
    }),

    // Nhãn (danh mục có màu + emoji)
    'crm-tags': (crm) => ({ tags: crm.listTags() }),
    'crm-tag-save': (crm, p, actor) => crm.upsertTag(p || {}, actor),
    'crm-tag-delete': (crm, p, actor) => crm.deleteTag(required(p, 'name'), actor),
    // Nhận sẵn mảng `labels` thay vì tự gọi Zalo: index.js lo phần lấy dữ liệu (đa tài khoản,
    // cần zca), file này vẫn thuần để test không cần server.
    'crm-tags-sync-apply': (crm, p, actor) => crm.syncZaloLabels(p?.labels || [], actor, { prune: p?.prune !== false }),

    // Thao tác hàng loạt
    'crm-contacts-tag': (crm, p, actor) => crm.tagContacts(
        p?.ids || [], required(p, 'tag'), p?.add !== false, actor),
    'crm-contacts-delete': (crm, p, actor) => crm.deleteContacts(p?.ids || [], actor),

    // Leads
    'crm-pipeline': (crm) => crm.pipeline(),
    'crm-lead-get': (crm, p) => {
        const l = crm.getLead(required(p, 'id'));
        if (!l) throw new NotFound('lead không tồn tại');
        return l;
    },
    'crm-lead-create': (crm, p, actor) => crm.createLead(p || {}, actor),
    'crm-lead-update': (crm, p, actor) => crm.updateLead(required(p, 'id'), p, actor),
    'crm-lead-move': (crm, p, actor) => crm.moveLeadStage(
        required(p, 'id'), required(p, 'stage'), actor, { lossReason: p.lossReason }),
    'crm-lead-undo': (crm, p, actor) => crm.undoLeadStage(required(p, 'id'), actor),
    'crm-lead-delete': (crm, p, actor) => ({ deleted: crm.deleteLead(required(p, 'id'), actor) }),

    // Tasks
    'crm-tasks-list': (crm, p) => ({ tasks: crm.listTasks(p || {}) }),
    'crm-task-create': (crm, p, actor) => crm.createTask(p || {}, actor),
    'crm-task-done': (crm, p, actor) => crm.setTaskDone(required(p, 'id'), p.done !== false, actor),
    'crm-task-delete': (crm, p, actor) => ({ deleted: crm.deleteTask(required(p, 'id'), actor) }),

    // Meta
    'crm-stats': (crm) => crm.stats(),
    'crm-audit': (crm, p) => ({ logs: crm.listAudit(p?.limit || 50) }),
    'crm-stages': () => ({ stages: LEAD_STAGES }),
};

export const CRM_ACTIONS = Object.freeze(Object.keys(ACTIONS));

class NotFound extends Error { }

function required(p, key) {
    const v = p?.[key];
    if (v == null || v === '') {
        const e = new Error(`thiếu tham số: ${key}`);
        e.badRequest = true;
        throw e;
    }
    return v;
}

/**
 * @param {import('./crm-store.js').CrmStore|null} crmStore null nếu storage không phải sqlite
 * @param {string} action tên action (crm-*)
 * @param {object} payload body JSON từ client
 * @param {string} [actor] định danh người thao tác (từ auth dashboard)
 * @returns {{ status: number, body: object }}
 */
export function handleCrmAction(crmStore, action, payload, actor = 'dashboard') {
    const fn = ACTIONS[action];
    if (!fn) return { status: 404, body: { ok: false, error: `unknown action: ${action}` } };
    if (!crmStore) {
        return { status: 503, body: { ok: false, error: 'CRM cần SQLite (Node >= 22.5). Storage hiện tại: in-memory.' } };
    }
    try {
        const data = fn(crmStore, payload, actor);
        return { status: 200, body: { ok: true, data } };
    } catch (e) {
        if (e instanceof NotFound) return { status: 404, body: { ok: false, error: e.message } };
        const status = e.badRequest || /bắt buộc|không hợp lệ|không tồn tại|phải/.test(e.message) ? 400 : 500;
        return { status, body: { ok: false, error: e.message } };
    }
}
