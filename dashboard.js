const sections = [...document.querySelectorAll('.section')];
const navButtons = [...document.querySelectorAll('[data-section]')];
const drawer = document.querySelector('.drawer');
const backdrop = document.querySelector('.drawer-backdrop');
const toast = document.getElementById('toast');
const modalBackdrop = document.getElementById('modalBackdrop');
const modalTitle = document.getElementById('modalTitle');
const modalDesc = document.getElementById('modalDesc');
const modalBody = document.getElementById('modalBody');
const modalCancel = document.getElementById('modalCancel');
const modalConfirm = document.getElementById('modalConfirm');
const token = window.ZALO_DASHBOARD_TOKEN || '';
const pluginVersion = '2.27.0';
let state = null;
let activeGroupId = '';
let lang = localStorage.getItem('zaloDashboardLang') || 'vi';
let modalResolve = null;
let activeActionButton = null;
const selectedGroups = new Set();
const selectedMembers = new Set();
let currentGroupFilter = 'all';
let currentMemberFilter = 'all';
let selectedGroupBotFilter = 'all';
let selectedMemberBotFilter = 'all';
let selectedBotFilter = 'all';
let currentMembersPage = 1;
const membersPerPage = 30;
let membersTableColumns = {
  avatar: true,
  name: true,
  birth: true,
  phone: true,
  actions: true
};
try {
  const savedCols = localStorage.getItem('membersTableColumns');
  if (savedCols) {
    membersTableColumns = JSON.parse(savedCols);
  }
} catch (e) { }
const fetchedPendingMembers = {};
const fetchedBlockedMembers = {};
let currentDetailGroupId = '';
let currentDetailPayload = null;
document.documentElement.dataset.theme = localStorage.getItem('zaloDashboardTheme') || 'light';
if (localStorage.getItem('zaloReduceMotion') === '1') document.documentElement.setAttribute('data-reduce-motion', '');
window.toggleLicenseVisibility = function () {
  const input = document.getElementById('licenseInput');
  const open = document.getElementById('eyeOpenIcon');
  const closed = document.getElementById('eyeClosedIcon');
  if (input && input.type === 'password') {
    input.type = 'text';
    if (open) open.style.display = 'none';
    if (closed) closed.style.display = 'block';
  } else if (input) {
    input.type = 'password';
    if (open) open.style.display = 'block';
    if (closed) closed.style.display = 'none';
  }
};
window.toggleUpgradeVisibility = function () {
  const input = document.getElementById('upgradeInput');
  const open = document.getElementById('eyeUpgradeOpenIcon');
  const closed = document.getElementById('eyeUpgradeClosedIcon');
  if (input && input.type === 'password') {
    input.type = 'text';
    if (open) open.style.display = 'none';
    if (closed) closed.style.display = 'block';
  } else if (input) {
    input.type = 'password';
    if (open) open.style.display = 'block';
    if (closed) closed.style.display = 'none';
  }
};
function formatLicenseKey(key) {
  if (!key) return '';
  if (key.length <= 80) return key;
  return key.slice(0, 48) + '....' + key.slice(-32);
}
window.toggleKeyVisibility = function () {
  const keyVal = document.getElementById('maskedKeyVal');
  const copyBtn = document.getElementById('btnCopyKey');
  if (keyVal) {
    if (keyVal.textContent.startsWith('•')) {
      keyVal.textContent = formatLicenseKey(state?.license?.key || '');
      if (copyBtn) copyBtn.style.display = 'inline-flex';
    } else {
      keyVal.textContent = '••••••••••••••••';
      if (copyBtn) copyBtn.style.display = 'none';
    }
  }
};
window.showInlineUpgradeInput = function () {
  const upgradeRow = document.getElementById('licenseUpgradeRow');
  if (upgradeRow) {
    upgradeRow.style.display = 'flex';
    const input = document.getElementById('upgradeInput');
    if (input) {
      input.value = '';
      input.focus();
    }
  }
};
window.hideInlineUpgradeInput = function () {
  const upgradeRow = document.getElementById('licenseUpgradeRow');
  if (upgradeRow) {
    upgradeRow.style.display = 'none';
  }
};
window.handleUpgradeLicense = async function () {
  const key = document.getElementById('upgradeInput').value.trim();
  if (!key) {
    showToast(t('Vui lòng nhập key nâng cấp!', 'Please enter an upgrade key!'), 'warning');
    return;
  }
  const button = document.getElementById('btnUpgradeActivate');
  setButtonLoading(button, true);
  try {
    const data = await api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'activate-license', payload: { key } }),
    });
    const result = data.result || {};
    if (result.valid) {
      showToast(t('Nâng cấp gói bản quyền PRO thành công!', 'PRO license upgraded successfully!'), 'success');
      await loadState();
    } else {
      showToast(result.error || t('Kích hoạt thất bại. Vui lòng kiểm tra lại key!', 'Activation failed. Please check your key!'), 'error');
    }
  } catch (e) {
    showToast(e.message || t('Lỗi kết nối server!', 'Server connection error!'), 'error');
  } finally {
    setButtonLoading(button, false);
  }
};
window.handleRefreshLicense = async function () {
  const button = document.getElementById('btnRefreshLicense');
  if (button) setButtonLoading(button, true);
  try {
    showToast(t('Đang đồng bộ bản quyền từ máy chủ...', 'Syncing license from server...'), 'info');
    const data = await api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'refresh-license' }),
    });
    if (data.ok && data.result?.ok) {
      showToast(t('Đồng bộ bản quyền thành công!', 'License synced successfully!'), 'success');
      await loadState();
    } else {
      showToast(data.error || data.result?.error || t('Đồng bộ thất bại. Vui lòng thử lại!', 'Sync failed. Please try again!'), 'error');
    }
  } catch (e) {
    showToast(e.message || t('Lỗi kết nối server!', 'Server connection error!'), 'error');
  } finally {
    if (button) setButtonLoading(button, false);
  }
};
function setSection(id) {
  sections.forEach(section => section.classList.toggle('active', section.id === id));
  navButtons.forEach(button => button.classList.toggle('active', button.dataset.section === id));
  drawer.classList.remove('open');
  backdrop.classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (id === 'permissions') renderPermissions();
  if (id === 'journal') renderJournal();
  if (id === 'reports') renderReports();
  if (id === 'reportlog') renderReportLog();
  if (id === 'settings') renderSettings();
  if (id === 'chat') renderChat();
  if (id === 'contacts') renderCrmContacts();
  if (id === 'leads') renderCrmLeads();
  if (id === 'tasks') renderCrmTasks();
}
// Re-render whichever on-demand section is currently active (these render on
// tab-open via setSection, not inside renderState). Called when the selected bot
// changes so bot-scoped pages (Permissions, Journal, CRM…) refresh immediately.
function refreshActiveOnDemandSection() {
  const active = [...sections].find(s => s.classList.contains('active'));
  switch (active?.id) {
    case 'permissions': renderPermissions(); break;
    case 'journal': renderJournal(); break;
    case 'reports': renderReports(); break;
    case 'reportlog': renderReportLog(); break;
    case 'settings': renderSettings(); break;
    case 'chat': renderChat(); break;
    case 'contacts': renderCrmContacts(); break;
    case 'leads': renderCrmLeads(); break;
    case 'tasks': renderCrmTasks(); break;
  }
}
function toastIcon(tone) {
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none"><path d="M20 7 9 18l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8h.01M11 12h1v4h1m-1 5a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 4 3 20h18L12 4Zm0 5v5m0 3h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none"><path d="m15 9-6 6m0-6 6 6" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" stroke="currentColor" stroke-width="2.2"/></svg>',
  };
  return icons[tone] || icons.info;
}
function showToast(message, tone = 'info') {
  toast.innerHTML = `
        <div class="toast-content">
          <span class="toast-icon" aria-hidden="true">${toastIcon(tone)}</span>
          <span class="toast-text">${esc(repairText(message))}</span>
          <button class="toast-close" type="button" aria-label="Close toast" onclick="this.closest('.toast').classList.remove('show')">
            <svg viewBox="0 0 24 24" fill="none"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      `;
  toast.className = `toast ${tone}`;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 4200);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function repairText(value) {
  const input = String(value ?? '');
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 255) return input;
  }
  if (!/[ÃÂÄÆ]/.test(input)) return input;
  try {
    const bytes = Uint8Array.from(input, ch => ch.charCodeAt(0) & 255);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return decoded && decoded !== input ? decoded : input;
  } catch {
    return input;
  }
}
function t(vi, en) {
  return lang === 'en' ? en : vi;
}
function setButtonLoading(button, loading) {
  if (!button) return;
  button.classList.toggle('is-loading', loading);
  button.toggleAttribute('aria-busy', loading);
  if (loading) button.disabled = true;
  else if (button.dataset.wasDisabled !== 'true') button.disabled = false;
}
function compactResult(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return t(`${result.length} mục`, `${result.length} items`);
  if (typeof result !== 'object') return String(result);
  if (result.sent) return t(`Đã gửi tới ${result.targetId || 'target'}`, `Sent to ${result.targetId || 'target'}`);
  if (result.count != null) return t(`${result.count} mục`, `${result.count} items`);
  if (result.message) return String(result.message);
  const keys = ['targetId', 'groupId', 'userId', 'ok', 'success', 'updated', 'approved', 'removed', 'blocked'].filter(key => result[key] != null);
  return keys.slice(0, 3).map(key => `${key}: ${result[key]}`).join(' · ');
}
function actionToast(action, result, fallback) {
  const summary = compactResult(result);
  const actionName = action.replace(/-/g, ' ');
  return summary ? `${fallback} · ${summary}` : `${fallback} · ${actionName}`;
}
function syncChromeState() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const langToggle = document.getElementById('langToggle');
  if (langToggle) {
    langToggle.classList.toggle('is-en', lang === 'en');
    langToggle.setAttribute('aria-pressed', String(lang === 'en'));
  }
  document.getElementById('langVi')?.classList.toggle('active', lang === 'vi');
  document.getElementById('langEn')?.classList.toggle('active', lang === 'en');
}
function setText(selector, vi, en) {
  const node = document.querySelector(selector);
  if (node) {
    const text = t(vi, en);
    const svg = node.querySelector('svg');
    if (svg) {
      Array.from(node.childNodes).forEach(child => {
        if (child !== svg) node.removeChild(child);
      });
      node.appendChild(document.createTextNode(text));
    } else {
      node.textContent = text;
    }
  }
}
function setHtml(selector, vi, en) {
  const node = document.querySelector(selector);
  if (node) {
    node.innerHTML = t(vi, en);
  }
}
// Nhãn menu gán theo data-section, KHÔNG theo thứ tự.
//
// Trước đây dùng setAllText() với một mảng theo vị trí, nên chỉ cần thêm một nút vào sidebar là toàn
// bộ nhãn phía sau lệch đi một bậc — "Nhật ký" hiện ra kèm con là "Bạn bè"/"Tin nhắn". Gán theo khoá
// thì thêm/bớt/đổi chỗ mục menu bao nhiêu cũng không sai.
const NAV_LABELS = {
  overview: ['Tổng quan', 'Overview'],
  groups: ['Nhóm', 'Groups'],
  members: ['Thành viên', 'Members'],
  journal: ['Theo nhóm', 'By group'],
  reports: ['Lịch báo cáo', 'Schedules'],
  reportlog: ['Lịch sử báo cáo', 'Report log'],
  // Nhãn ĐIỀU HƯỚNG, không phải tiêu đề trang: từ khi có "Khung chat" nằm cùng nhóm "Tin nhắn",
  // để mục cũ tên "Tin nhắn" thì hai anh em trùng tên và không ai biết bấm cái nào.
  messages: ['Gửi hàng loạt', 'Bulk send'],
  templates: ['Template', 'Templates'],
  permissions: ['Phân quyền', 'Permissions'],
  chat: ['Khung chat', 'Chat'],
  contacts: ['Liên hệ', 'Contacts'],
  leads: ['Pipeline', 'Pipeline'],
  tasks: ['Công việc', 'Tasks'],
  upgrade: ['Nâng cấp', 'Upgrade'],
  settings: ['Cài đặt', 'Settings'],
};
/** Nhãn của nút mở/đóng nhóm menu — khoá theo id của .nav-group vì nút này không có data-section. */
const NAV_GROUP_LABELS = {
  navGroupJournal: ['Nhật ký', 'Journal'],
  navGroupCrm: ['CRM', 'CRM'],
  navGroupUtilities: ['Tiện ích', 'Utilities'],
};
function applyNavLabels(scopeSelector) {
  document.querySelectorAll(`${scopeSelector} button > span.nav-label`).forEach(span => {
    const btn = span.parentElement;
    const key = btn.getAttribute('data-section');
    const pair = key
      ? NAV_LABELS[key]
      : NAV_GROUP_LABELS[btn.closest('.nav-group')?.id || ''];
    if (pair) span.textContent = t(pair[0], pair[1]);
  });
}
function setAllText(selector, pairs) {
  document.querySelectorAll(selector).forEach((node, index) => {
    const pair = pairs[index];
    if (pair) {
      const text = t(pair[0], pair[1]);
      const svg = node.querySelector('svg');
      if (svg) {
        Array.from(node.childNodes).forEach(child => {
          if (child !== svg) node.removeChild(child);
        });
        node.appendChild(document.createTextNode(text));
      } else {
        node.textContent = text;
      }
    }
  });
}
function setAttr(selector, attr, vi, en) {
  const node = document.querySelector(selector);
  if (node) node.setAttribute(attr, t(vi, en));
}
function setSelectOptions(select, pairs) {
  if (!select) return;
  [...select.options].forEach((option, index) => {
    const pair = pairs[index];
    if (pair) option.textContent = t(pair[0], pair[1]);
  });
}
function applyI18n() {
  document.documentElement.lang = lang;
  syncChromeState();
  // Permissions section header + nav label
  setText('#permissions .page-head h2', 'Phân quyền', 'Permissions');
  setText('#permissions .page-head p', 'Kiểm soát ai được nhắn riêng (DM) với bot, bot hoạt động ở nhóm nào, và ai được dùng lệnh /note & /memory.', 'Control who can DM the bot, which groups the bot serves, and who can run /note & /memory.');
  document.querySelectorAll('[data-section="permissions"] .nav-label').forEach(n => { n.textContent = t('Phân quyền', 'Permissions'); });
  // Journal section header (group-select label render động trong renderJournalBody)
  setText('#journal .page-head h2', 'Nhật ký nhóm', 'Group journal');
  setText('#journal .page-head p', 'Tóm tắt chat theo ngày, note, memory, chat thô và lịch báo cáo tự động của từng nhóm.', 'Daily chat summary, notes, memory, raw chat and each group\'s auto-report schedule.');
  // Settings section header
  setText('#settings .page-head h2', 'Cài đặt', 'Settings');
  setText('#settings .page-head p', 'Tùy chỉnh ngôn ngữ, giao diện và xem thông tin thiết bị/phiên bản để tiện kích hoạt và hỗ trợ.', 'Customize language, appearance and view device/version info for activation and support.');
  setAttr('#search', 'placeholder', 'Tìm group, member, userId, API...', 'Search group, member, userId, API...');
  setAttr('[data-open-menu]', 'aria-label', 'More menu', 'Open more menu');
  setAttr('#themeToggle', 'aria-label', 'Theme switch', 'Switch theme');
  setAttr('#langToggle', 'aria-label', 'Đổi ngôn ngữ', 'Switch language');

  setText('[data-i18n="dropdownPlanLabel"]', 'Gói:', 'Plan:');
  setText('[data-i18n="dropdownExpiryLabel"]', 'Hạn dùng:', 'Expires:');

  setText('.brand h1', 'Zalo Owner', 'Zalo Owner');
  setText('.brand p', 'Quản trị Bot Zalo', 'Zalo Bot Management');
  applyNavLabels('[data-nav]');
  applyNavLabels('[data-drawer-nav]');
  setAllText('[data-bottom-nav] button > span', [
    ['Trang chủ', 'Home'],
    ['Nhóm', 'Groups'],
    ['Thành viên', 'Members'],
    ['Tin nhắn', 'Inbox'],
    ['Lệnh & Rules', 'Rules'],
    ['Thêm', 'More'],
  ]);
  setText('.sidebar-card strong', 'Chế độ vận hành', 'Operation mode');
  setText('.sidebar-card span', 'Dashboard gọi API thật khi ZCA khả dụng. Action rủi ro cao luôn cần xác nhận và được ghi audit log.', 'The dashboard calls real APIs when ZCA is available. High-risk actions require confirmation and are written to the audit log.');
  setText('.plugin-meta > span', 'Được làm ❤️ bởi tuanminhole', 'Made with ❤️ by tuanminhole');
  setText('#overview .page-head h2', 'Tổng quan vận hành', 'Operations Overview');
  setText('#overview .page-head p', 'Theo dõi group, pending member, friend request và các action quan trọng trong một màn hình gọn cho owner.', 'Monitor groups, pending members, friend requests, and important owner actions in one compact screen.');
  setAllText('#overview .actions .btn', [['Sync Account', 'Sync Account'], ['Nâng cấp', 'Upgrade'], ['Danh mục API', 'API Directory']]);
  setAllText('#overview .metric span', [['Nhóm quản lý', 'Managed Groups'], ['Member đang chờ duyệt', 'Pending Members'], ['Friend requests', 'Friend Requests'], ['Action rủi ro cao', 'High-risk Actions']]);
  setAllText('#overview .metric .trend', [['+3 group từ session', '+3 groups from session'], ['12 cần review hôm nay', '12 need review today'], ['8 request mới', '8 new requests'], ['Cần xác nhận 2 bước', 'Requires two-step confirmation']]);
  setText('#overview .panel-head h3', 'Group cần chú ý', 'Groups Needing Attention');
  setText('#overview .panel-head p', 'Ưu tiên group có pending, spam hoặc member bị cảnh cáo.', 'Prioritize groups with pending members, spam signals, or warned members.');
  setText('#overview [data-section-target="groups"]', 'Xem tất cả', 'View all');
  setAllText('#overview thead th', [['Group', 'Group'], ['Thành viên', 'Members'], ['Cảnh báo', 'Violations'], ['Mode', 'Mode'], ['Action', 'Action']]);
  setText('#overview .layout .card:nth-child(2) .panel-head h3', 'Action log', 'Action Log');
  setText('#overview .layout .card:nth-child(2) .panel-head p', 'Audit log gần nhất.', 'Latest audit log.');
  setText('#groups .page-head h2', 'Nhóm', 'Groups');
  setText('#groups .page-head p', 'Quản lý danh sách group, link mời, admin, setting và trạng thái plugin theo từng group.', 'Manage group lists, invite links, admins, settings, and plugin state per group.');
  setAllText('#groups .actions .btn', [['Import session', 'Import session'], ['Create group', 'Create group']]);
  setAllText('#groups .segmented button', [['All', 'All'], ['Silent', 'Silent'], ['Welcome', 'Welcome'], ['Muted', 'Muted'], ['Spam', 'Spam']]);
  setAllText('#groups thead th', [['Group', 'Group'], ['Member', 'Member'], ['Tính năng', 'Features'], ['Thao tác', 'Actions']]);
  setText('#members .page-head h2', 'Thành viên', 'Members');
  setText('#members .page-head p', 'Duyệt member mới, xem member list, block hoặc xóa member với confirmation rõ ràng.', 'Review new members, inspect member lists, block, or remove members with clear confirmation.');
  setAllText('#members .segmented button', [['Thành viên', 'All members'], ['Chờ duyệt', 'Pending'], ['Bị chặn', 'Blocked'], ['Admin', 'Admins']]);
  setText('#btnConfigureColumns .btn-text-lang', 'Cài đặt bảng', 'Table settings');
  setAttr('#btnConfigureColumns', 'title', 'Cài đặt hiển thị cột', 'Table Column Settings');
  setText('#members .panel-head h3', 'Member action', 'Member Action');
  setText('#members .panel-head p', 'Form thao tác một member hoặc bulk action.', 'Run one-member or bulk member actions.');
  setAllText('#members form label span', [['Group', 'Group'], ['User ID', 'User ID'], ['Action', 'Action']]);
  setAttr('#members form input', 'placeholder', 'Nhập userId hoặc chọn member', 'Enter userId or select a member');
  setSelectOptions(document.querySelectorAll('#members form select')[1], [
    ['Duyệt pending request', 'Approve pending request'],
    ['Từ chối pending request', 'Reject pending request'],
    ['Mời vào group', 'Invite to group'],
    ['Xóa khỏi group', 'Remove from group'],
    ['Block khỏi group', 'Block from group'],
  ]);
  setText('#members [data-action="member-form-action"]', 'Chạy action', 'Run action');
  setText('#contacts .page-head h2', 'Liên hệ', 'Contacts');
  setText('#contacts .page-head p',
    'Bạn bè và khách hàng chưa kết bạn, gộp chung một chỗ — nhãn Zalo, sinh nhật, nhóm, liên kết lead.',
    'Friends and not-yet-friend customers in one place — Zalo labels, birthdays, groups, lead links.');
  setText('#messages .page-head h2', 'Tin nhắn', 'Messages');
  setText('#messages .page-head p', 'Gửi template, thông báo, link hoặc tin nhắn hàng loạt có preview và rate limit.', 'Send templates, announcements, links, or bulk messages with preview and rate limiting.');
  setText('#messages .panel-head h3', 'Composer', 'Composer');
  setText('#messages .panel-head p', 'Gửi tin theo group hoặc user.', 'Send a message to a group or user.');
  setAllText('#messages form label span', [['Target', 'Target'], ['Message', 'Message']]);
  setAttr('#messages textarea', 'placeholder', 'Nhập nội dung cần gửi...', 'Enter message content...');
  setAllText('#messages .actions .btn', [['Preview', 'Preview'], ['Gửi tin', 'Send message']]);
  setAllText('#messages .layout .card:nth-child(2) .panel-head h3', [['Templates', 'Templates']]);
  setText('#messages .layout .card:nth-child(2) .panel-head p', 'Nội quy, welcome, cảnh báo, maintenance.', 'Rules, welcome notes, warnings, and maintenance notices.');
  setAllText('#messages .layout .card:nth-child(2) .item-title', [['Nội quy group', 'Group rules'], ['Cảnh báo spam link', 'Spam link warning'], ['Thông báo bảo trì bot', 'Bot maintenance notice']]);
  setAllText('#messages .layout .card:nth-child(2) .btn', [['Dùng', 'Use'], ['Dùng', 'Use'], ['Dùng', 'Use']]);
  setText('#api .page-head h2', 'Danh mục API', 'API Directory');
  setText('#api .page-head p', 'Catalog nhóm API ZCA thành workflow rõ ràng. Action nguy hiểm cần confirm và audit log.', 'Group ZCA APIs into clear workflows. Dangerous actions require confirmation and audit logging.');
  setAllText('#api .api-card h4', [['Group info', 'Group info'], ['Member ops', 'Member ops'], ['Bạn bè', 'Friends'], ['Messaging', 'Messaging'], ['Engagement', 'Engagement'], ['Settings', 'Settings']]);
  setAllText('#api .api-card p', [
    ['Đọc group, member, pending, blocked, invite link.', 'Read groups, members, pending lists, blocked lists, and invite links.'],
    ['Duyệt, mời, thêm, xóa, block member.', 'Approve, invite, add, remove, and block members.'],
    ['Quản lý request, danh bạ, alias, lời mời kết bạn.', 'Manage requests, contacts, aliases, and friend invitations.'],
    ['Gửi text, link, sticker, voice, video, forward.', 'Send text, links, stickers, voice, video, and forwards.'],
    ['Poll, note, reminder cho group.', 'Polls, notes, and reminders for groups.'],
    ['Mute, pin, hidden, account setting, group setting.', 'Mute, pin, hidden state, account settings, and group settings.'],
  ]);
  setText('#upgrade .page-head h2', 'Nâng cấp', 'Upgrade');
  setText('#upgrade .page-head p', 'Bạn vẫn dùng được UI miễn phí. Nâng cấp để mở khóa điều khiển nâng cao.', 'You can keep using the UI for free. Upgrade to unlock advanced control features.');
  setText('#upgrade .license-info p:nth-child(1) strong', 'Trạng thái kích hoạt:', 'Activation Status:');
  setText('#upgrade .license-info p:nth-child(2) strong', 'Device ID của bạn:', 'Your Device ID:');
  setText('#btnActivate', 'Xác thực', 'Verify');
  setText('#modalCancel', 'Hủy', 'Cancel');
  const footerContent = document.querySelector('.site-footer .footer-content');
  if (footerContent) {
    if (lang === 'vi') {
      footerContent.innerHTML = `
            <p class="footer-copyright" style="margin: 0; font-size: 11px; opacity: 0.6;">
              Copyright © 2026 <strong>Được làm ❤️ bởi tuanminhole</strong>. Phát hành theo MIT.
            </p>
            <p class="footer-donate-text" style="margin: 0; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 4px; flex-wrap: wrap; justify-content: center;">
              <span>Nếu công cụ này giúp ích cho bạn, hãy mời mình một ly cà phê nhé! <span class="heart-emoji">❤️</span></span>
              <button class="btn-donate" type="button" onclick="openDonateModal()">
                <svg class="donate-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px; vertical-align: middle;"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>
                <span>Mời Cafe</span>
              </button>
            </p>
          `;
    } else {
      footerContent.innerHTML = `
            <p class="footer-copyright" style="margin: 0; font-size: 11px; opacity: 0.6;">
              Copyright © 2026 <strong>Made with ❤️ by tuanminhole</strong>. Released under MIT.
            </p>
            <p class="footer-donate-text" style="margin: 0; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 4px; flex-wrap: wrap; justify-content: center;">
              <span>If this tool is helpful for you, buy me a coffee! <span class="heart-emoji">❤️</span></span>
              <button class="btn-donate" type="button" onclick="openDonateModal()">
                <svg class="donate-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px; vertical-align: middle;"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>
                <span>Buy Coffee</span>
              </button>
            </p>
          `;
    }
  }

  // Pricing Grid i18n
  setText('[data-i18n-badge="free"]', 'Free', 'Free');
  setText('[data-i18n-title="free"]', 'Gói Free', 'Free Plan');
  setText('[data-i18n-sub="free"]', 'Mở đầu trải nghiệm', 'Get started');
  setText('[data-i18n-feature="free-1"]', 'Dùng toàn bộ UI dashboard', 'Use full UI dashboard');
  setText('[data-i18n-feature="free-2"]', 'Xem dữ liệu group/member/log', 'View group, member & log data');
  setText('[data-i18n-feature="free-3"]', 'Thao tác từng group/member', 'Single group/member actions');
  setText('[data-i18n-btn="free"]', 'Trải nghiệm ngay', 'Try now');

  setText('[data-i18n-badge="personal"]', 'Cá nhân', 'Personal');
  setText('[data-i18n-title="personal"]', 'Gói Cá nhân', 'Personal Plan');
  setText('[data-i18n-sub="personal"]', 'hoặc 990.000đ / 12 tháng', 'or 990,000đ / 12 months');
  setText('[data-i18n-feature="personal-1"]', 'Nhiều group, hàng loạt và All', 'Multi-group, bulk and All actions');
  setText('[data-i18n-feature="personal-2"]', 'Tặng 30 ngày Pro khi cài lần đầu', '30-day Pro trial on first install');
  setText('[data-i18n-feature="personal-3"]', 'Dùng cho 1 owner account', 'Use for 1 owner account');
  setText('[data-i18n-btn="personal"]', 'Nâng cấp Cá nhân', 'Upgrade Personal');

  setText('[data-i18n-badge="team"]', 'Team', 'Team');
  setText('[data-i18n-title="team"]', 'Gói Team', 'Team Plan');
  setText('[data-i18n-sub="team"]', 'hoặc 2.990.000đ / 12 tháng', 'or 2,990,000đ / 12 months');
  setText('[data-i18n-feature="team-1"]', 'Thao tác nhiều bot cùng lúc', 'Operate multiple bots at once');
  setText('[data-i18n-feature="team-2"]', 'Ưu tiên hỗ trợ nhanh hơn', 'Priority faster support');
  setText('[data-i18n-feature="team-3"]', 'Bao gồm toàn bộ quyền Pro', 'Includes every Pro capability');
  setText('[data-i18n-btn="team"]', 'Đăng ký Team', 'Register Team');

  setText('[data-i18n-badge="lifetime"]', 'Vĩnh viễn', 'Lifetime');
  setText('[data-i18n-title="lifetime"]', 'Gói Lifetime', 'Lifetime Plan');
  setText('[data-i18n-sub="lifetime"]', 'Thanh toán một lần duy nhất', 'One-time payment only');
  setText('[data-i18n-feature="lifetime-1"]', 'Sử dụng vĩnh viễn trọn đời', 'Lifetime perpetual usage');
  setText('[data-i18n-feature="lifetime-2"]', 'Kích hoạt theo chính sách plugin', 'Activated per plugin policy');
  setText('[data-i18n-feature="lifetime-3"]', 'Phù hợp sử dụng lâu dài ổn định', 'Best for long-term stable use');
  setText('[data-i18n-btn="lifetime"]', 'Mua Lifetime', 'Buy Lifetime');

    setAllText('[data-i18n-period="month"]', [['/tháng', '/month']]);

  // --- Rules & Cmds Tab Translations ---
  setText('#templates .page-head h2', 'Quản lý Template', 'Manage Templates');
  setText('#templates .page-head p', 'Tùy chỉnh nội dung & gán lệnh slash cho từng template.', 'Customize content & bind a slash command for each template.');
  setText('[data-template-key="noi-quy"] strong', 'Nội quy nhóm', 'Group Rules');
  setText('[data-template-key="huong-dan"] strong', 'Hướng dẫn dùng bot', 'Bot Manual');
  setText('[data-template-key="menu"] strong', 'Menu lệnh', 'Slash Commands Menu');
  setText('#templates .cheatsheet h5', 'Biến có thể sử dụng (Click để chèn):', 'Available Variables (Click to Insert):');
  setHtml('[data-var="{groupName}"]', '<code>{groupName}</code> - Tên nhóm', '<code>{groupName}</code> - Group name');
  setAttr('[data-var="{groupName}"]', 'title', 'Tên nhóm chat Zalo', 'Zalo group name');
  setHtml('[data-var="{botName}"]', '<code>{botName}</code> - Tên bot', '<code>{botName}</code> - Bot name');
  setAttr('[data-var="{botName}"]', 'title', 'Tên bot', 'Bot name');
  setHtml('[data-var="{BOTNAME}"]', '<code>{BOTNAME}</code> - Tên bot viết hoa', '<code>{BOTNAME}</code> - Uppercase bot name');
  setAttr('[data-var="{BOTNAME}"]', 'title', 'Tên bot viết hoa', 'Uppercase bot name');
  setHtml('[data-var="{cmdPrefix}"]', '<code>{cmdPrefix}</code> - Prefix lệnh', '<code>{cmdPrefix}</code> - Command prefix');
  setAttr('[data-var="{cmdPrefix}"]', 'title', 'Prefix lệnh (ví dụ /williams-)', 'Command prefix (e.g. /williams-)');
  setHtml('[data-var="{customModes}"]', '<code>{customModes}</code> - Chế độ tính năng', '<code>{customModes}</code> - Custom modes');
  setAttr('[data-var="{customModes}"]', 'title', 'Danh sách slash commands chế độ tính năng', 'List of custom modes slash commands');
  setAttr('#template-textarea', 'placeholder', 'Nhập nội dung template...', 'Enter template content...');
  setText('#btn-preview-template', 'Xem trước', 'Preview');
  setText('#btn-save-template', 'Lưu cấu hình', 'Save Configuration');

  // Redraw lists

}
function closeModal(value) {
  modalBackdrop.classList.remove('open');
  currentDetailGroupId = '';
  currentDetailPayload = null;
  if (modalResolve) modalResolve(value);
  modalResolve = null;
}
function modalIcon(type) {
  const icons = {
    info: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8h.01M11 12h1v4h1m-1 5a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 4 3 20h18L12 4Zm0 5v5m0 3h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    danger: '<svg viewBox="0 0 24 24" fill="none"><path d="m15 9-6 6m0-6 6 6" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" stroke="currentColor" stroke-width="2.2"/></svg>',
  };
  return icons[type] || icons.info;
}
async function openDonateModal() {
  const oldCancelDisplay = modalCancel.style.display;
  modalCancel.style.display = 'none';
  const oldConfirmText = modalConfirm.textContent;
  modalConfirm.textContent = t('Đóng', 'Close');

  const donateBody = `
        <div class="donate-modal-content" style="display: flex; flex-direction: column; align-items: center; text-align: center; gap: 16px; padding: 10px 0;">
          <div style="background: white; padding: 12px; border-radius: 16px; border: 1.5px solid var(--line); display: inline-block; box-shadow: 0 10px 25px rgba(0,0,0,0.05); margin: 4px 0;">
            <img src="https://api.vietqr.io/image/970422-0962794917-MP4UJW0S.jpg?accountName=HO%20LE%20MINH%20TUAN" alt="Donate QR" style="width: 240px; height: 240px; object-fit: contain; border-radius: 8px; display: block;"/>
          </div>
          <div style="font-size: 13px; color: var(--text); display: flex; flex-direction: column; gap: 6px; background: var(--surface-2); padding: 12px 20px; border-radius: 12px; border: 1px solid var(--line); width: 100%; max-width: 320px;">
            <div style="display: flex; justify-content: space-between; gap: 12px;"><span style="color: var(--text-muted);">${t('Ngân hàng:', 'Bank:')}</span><strong style="color: var(--text);">MB Bank (Quân Đội)</strong></div>
            <div style="display: flex; justify-content: space-between; gap: 12px;"><span style="color: var(--text-muted);">${t('Số tài khoản:', 'Account:')}</span><strong style="color: var(--text); font-family: monospace; font-size: 14px;">0962794917</strong></div>
            <div style="display: flex; justify-content: space-between; gap: 12px;"><span style="color: var(--text-muted);">${t('Chủ tài khoản:', 'Name:')}</span><strong style="color: var(--text);">HO LE MINH TUAN</strong></div>
            </div>
          </div>
        </div>
      `;

  await openModal({
    title: t('Mời Tui Ly Cà Phê ☕️', 'Buy Me a Coffee ☕️'),
    desc: t('Sự đồng hành của bạn giúp dự án ngày càng hoàn thiện', 'Your support keeps this open-source project growing'),
    body: donateBody
  });

  modalCancel.style.display = oldCancelDisplay;
  modalConfirm.textContent = oldConfirmText;
}
function openModal({ title, desc, body, confirmText = 'OK', danger = false, tone = 'info' }) {
  modalTitle.innerHTML = `<div class="modal-title-row"><span class="modal-icon ${tone}" aria-hidden="true">${modalIcon(tone)}</span><span>${esc(repairText(title))}</span></div>`;
  modalDesc.textContent = desc || '';
  modalBody.innerHTML = body || '';
  modalConfirm.textContent = confirmText;
  modalConfirm.classList.toggle('danger', danger);
  modalConfirm.classList.toggle('primary', !danger);
  modalBackdrop.classList.add('open');
  if (title !== uiText('Chi tiết group', 'Group details')) {
    currentDetailGroupId = '';
    currentDetailPayload = null;
  }
  const first = modalBody.querySelector('input, textarea, select, button');
  setTimeout(() => first?.focus(), 60);
  return new Promise(resolve => { modalResolve = resolve; });
}
// Cảnh báo trước khi bật "Tự duyệt": bot phải là Phó/Trưởng nhóm. Lưu ý nhóm nhiều bot.
async function confirmPendingAutoWarning() {
  return await openModal({
    title: uiText('Bật tự động duyệt thành viên?', 'Enable auto-approve members?'),
    tone: 'warning',
    body: `<div class="modal-warn-body">
      <p class="modal-warn-lead">${uiText('Để bot tự duyệt yêu cầu tham gia, <b>tài khoản bot phải là Phó nhóm hoặc Trưởng nhóm</b>. Zalo chỉ cho phó/trưởng nhóm xem &amp; duyệt.', 'For the bot to auto-approve join requests, the <b>bot account must be a Deputy or Group Leader</b>. Zalo only lets deputies/leaders view &amp; approve.')}</p>
      <p class="modal-warn-note">${uiText('Nhóm nhiều bot: chỉ cần ít nhất một bot là phó/trưởng nhóm. Chưa cấp quyền thì bật vẫn bỏ qua an toàn.', 'Multi-bot groups: only one bot needs deputy/leader rights. Without it, the toggle just skips safely.')}</p>
    </div>`,
    confirmText: uiText('Đã hiểu, bật', 'Got it, enable'),
  });
}
// Modal khi bật Silent: diễn giải chế độ + hiển thị & sửa "tên gọi" (name triggers).
// Áp dụng theo TÀI KHOẢN (bot), không riêng nhóm — bot im lặng vẫn trả lời khi được
// @nhắc hoặc gọi đúng tên. Fetch danh sách hiện tại rồi cho user sửa, lưu qua bridge.
async function openSilentNameModal(accountId, botLabel) {
  const acct = String(accountId || 'default');
  const safeLabel = esc(botLabel || acct);
  let info = { displayName: null, triggers: [], effective: [], bridgeUnavailable: false };
  try {
    const res = await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'get-name-triggers', payload: { accountId: acct } }) });
    if (res && res.result) info = res.result;
  } catch { /* vẫn mở modal để user nhập; lưu sẽ thử lại */ }
  const auto = info.displayName
    ? `<code style="background:var(--surface-2);padding:2px 8px;border-radius:6px;font-size:12px;">${esc(info.displayName)}</code>`
    : `<em style="color:var(--text-muted);font-size:12px;">${t('(chưa lấy được tên Zalo — đăng nhập xong sẽ tự có)', '(Zalo name not fetched yet — appears after login)')}</em>`;
  const aliases = (info.triggers || []).join('\n');
  const bridgeWarn = info.bridgeUnavailable
    ? `<p class="modal-warn-note" style="color:#dc2626;">${t('⚠ Zalo Connect chưa sẵn sàng — vẫn lưu, sẽ áp dụng khi kết nối lại.', '⚠ Zalo Connect not ready — saved anyway, applied on reconnect.')}</p>`
    : '';
  const body = `<div class="modal-warn-body">
      <p class="modal-warn-lead">${t('Chế độ <b>Im lặng</b>: trong nhóm, bot chỉ trả lời khi được <b>@nhắc</b> hoặc khi tin nhắn <b>gọi đúng tên bot</b> — không chen ngang.', 'In <b>Silent</b> mode the bot replies only when <b>@mentioned</b> or when a message <b>calls its name</b> — it never chimes in.')}</p>
      <div style="display:flex;align-items:center;gap:8px;margin:12px 0 6px;font-size:13px;">
        <span style="color:var(--text-muted);">${t('Tên Zalo tự nhận', 'Auto Zalo name')}:</span>${auto}
      </div>
      <label style="display:block;font-size:13px;color:var(--text-muted);">
        <span style="display:block;margin-bottom:4px;">${t('Tên gọi để nhắc bot — mỗi dòng một tên (vd: mkt, mei)', 'Names used to address the bot — one per line (e.g. mkt, mei)')}</span>
        <textarea id="ntAliases" rows="4" style="width:100%;box-sizing:border-box;resize:vertical;" placeholder="mkt&#10;mei">${esc(aliases)}</textarea>
      </label>
      <p class="modal-warn-note">${t('Đây là <b>tên gọi</b> để nhắc bot <b>' + safeLabel + '</b> (ngoài @nhắc) — dùng chung cho bot ở mọi nhóm vì là tên của bot. <b>KHÔNG</b> phải bật Im lặng ở mọi nhóm: tắt/bật Im lặng vẫn <b>riêng từng nhóm</b>. Khớp không dấu, không phân biệt hoa/thường.', 'These are <b>names</b> for addressing bot <b>' + safeLabel + '</b> (besides @mention) — shared across all groups since they are the bot\'s identity. This does <b>NOT</b> turn Silent on everywhere: enabling/disabling Silent stays <b>per group</b>. Accent- and case-insensitive.')}</p>
      ${bridgeWarn}
    </div>`;
  const ok = await openModal({
    title: t('Chế độ Im lặng — tên gọi bot', 'Silent mode — bot names'),
    tone: 'info',
    body,
    confirmText: t('Lưu', 'Save'),
  });
  if (!ok) return;
  const raw = document.getElementById('ntAliases')?.value || '';
  const triggers = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  try {
    await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'set-name-triggers', payload: { accountId: acct, triggers } }) });
    showToast(t('Đã lưu tên gọi cho chế độ Im lặng', 'Silent-mode names saved'), 'success');
  } catch (e) {
    showToast(`${t('Lưu tên gọi lỗi', 'Failed to save names')} - ${e.message}`, 'error');
  }
}
async function api(path, options = {}) {
  let url = path;
  if (location.protocol === 'file:') {
    url = 'http://127.0.0.1:19790' + path;
  }
  let currentToken = token;
  if (!currentToken && location.protocol === 'file:') {
    currentToken = localStorage.getItem('zaloDashboardToken') || 'openclaw-zalo-mod';
  }
  const res = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${currentToken}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && location.protocol === 'file:') {
    const inputToken = prompt('Nhập Zalo Dashboard Token để xác thực (mặc định: openclaw-zalo-mod):');
    if (inputToken) {
      localStorage.setItem('zaloDashboardToken', inputToken.trim());
      location.reload();
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function loadState() {
  const isFirstLoad = !state;
  if (isFirstLoad) {
    // deliberate 750ms delay on first load so user can appreciate the premium sweep-shimmer loader
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  state = await api('/api/state');
  if (!activeGroupId && state.groups?.length) activeGroupId = state.groups[0].groupId;

  // Fetch friends list silently on start to populate cachedFriends & avatars!
  if (isFirstLoad) {
    api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'get-friends', payload: {} }) })
      .then(res => {
        if (res.ok && res.result) {
          const result = res.result;
          let friendsArray = [];
          if (Array.isArray(result)) {
            friendsArray = result;
          } else if (result && Array.isArray(result.friends)) {
            friendsArray = result.friends;
          } else if (result && typeof result === 'object') {
            friendsArray = Object.values(result).find(val => Array.isArray(val)) || [];
          }
          mergeProfilesAndSave(friendsArray);
          renderMembers();
        }
      })
      .catch(() => { });
  }

  renderState();
}
function renderLicense() {
  const licenseBox = document.querySelector('.upgrade-note.license-box');
  if (!state || !state.license) return;

  const lic = state.license;
  const isPro = !!lic.isPro;

  const headerBadge = document.getElementById('headerLicenseBadge');
  if (headerBadge) {
    headerBadge.style.display = 'inline-flex';
    if (isPro) {
      headerBadge.className = 'header-license-badge pro';
      let planName = lic.plan.toUpperCase();
      if (lic.isTrial) planName = t('Dùng thử Pro', 'Pro Trial');
      else if (lic.plan === 'personal') planName = t('Cá nhân Pro', 'Personal Pro');
      else if (lic.plan === 'team') planName = t('Team Pro', 'Team Pro');
      else if (lic.plan === 'lifetime') planName = t('Lifetime', 'Lifetime');

      headerBadge.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 13px; height: 13px; color: #10b981;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            <span>${planName}</span>
            <span style="font-size: 9px; opacity: 0.7; margin-left: 2px;">(${lic.expiry || ''})</span>
          `;
    } else {
      headerBadge.className = 'header-license-badge free';
      headerBadge.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 13px; height: 13px; color: var(--text-muted);"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            <span>FREE</span>
          `;
    }
  }

  const dropdownPlan = document.getElementById('dropdownPlan');
  const dropdownExpiry = document.getElementById('dropdownExpiry');
  if (dropdownPlan && dropdownExpiry) {
    if (isPro) {
      let planName = lic.plan.toUpperCase();
      if (lic.isTrial) planName = t('Dùng thử Pro', 'Pro Trial');
      else if (lic.plan === 'personal') planName = t('Cá nhân Pro', 'Personal Pro');
      else if (lic.plan === 'team') planName = t('Team Pro', 'Team Pro');
      else if (lic.plan === 'lifetime') planName = t('Lifetime', 'Lifetime');
      dropdownPlan.textContent = planName;
      dropdownExpiry.textContent = lic.expiry || '';
    } else {
      dropdownPlan.textContent = 'FREE';
      dropdownExpiry.textContent = t('Vĩnh viễn', 'Lifetime');
    }
  }

  if (!licenseBox) return;
  let html = '';

  if (isPro) {
    let planName = lic.plan.toUpperCase();
    if (lic.isTrial) planName = t('Dùng thử Pro', 'Pro Trial');
    else if (lic.plan === 'personal') planName = t('Cá nhân Pro', 'Personal Pro');
    else if (lic.plan === 'team') planName = t('Team Pro', 'Team Pro');
    else if (lic.plan === 'lifetime') planName = t('Lifetime Premium', 'Lifetime Premium');

    html = `
          <div class="license-info" style="display: flex; flex-direction: column; gap: 12px; width: 100%;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
              <div>
                <p style="margin: 0; font-size: 13px; color: var(--text-muted);">${t('Trạng thái kích hoạt:', 'Activation Status:')}</p>
                <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                  <span class="status-badge active" style="display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; background: rgba(0, 168, 255, 0.1); color: var(--primary); text-transform: uppercase;">${planName} (${t('Hạn: ', 'Exp: ') + lic.expiry})</span>
                  <button id="btnRefreshLicense" class="btn" onclick="handleRefreshLicense()" style="padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; height: 24px; line-height: 1;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 12px; height: 12px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                    ${t('Đồng bộ', 'Sync')}
                  </button>
                </div>
              </div>
              <div class="device-id-row" style="display: flex; flex-direction: column; align-items: flex-end;">
                <p style="margin: 0; font-size: 13px; color: var(--text-muted);">${t('Device ID của bạn:', 'Your Device ID:')}</p>
                <div style="display: flex; align-items: center; gap: 6px; margin-top: 4px;">
                  <code id="deviceIdVal" style="background: var(--bg-hover); padding: 4px 8px; border-radius: 6px; font-family: monospace; font-size: 13px; font-weight: 600;">${lic.deviceId || '----'}</code>
                  <button class="btn-copy" onclick="navigator.clipboard.writeText('${lic.deviceId || ''}'); showToast(t('Đã copy Device ID!', 'Device ID copied!'), 'success')" style="background: none; border: none; cursor: pointer; color: var(--text-muted); display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; transition: background 0.2s;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
                </div>
              </div>
            </div>
            
            <div class="license-body" style="display: flex; align-items: center; justify-content: space-between; width: 100%;" id="licenseDisplayRow">
              <div style="display: flex; align-items: center; gap: 10px; max-width: calc(100% - 150px); overflow: hidden;">
                <strong style="font-size: 14px; min-width: 120px; display: inline-block;">${t('Key kích hoạt:', 'Activation Key:')}</strong>
                <code id="maskedKeyVal" style="background: var(--bg-hover); padding: 4px 10px; border-radius: 6px; font-family: monospace; font-size: 13px; letter-spacing: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">••••••••••••••••</code>
                <button class="btn-toggle-key" onclick="toggleKeyVisibility()" style="background: none; border: none; cursor: pointer; color: var(--text-muted); display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; transition: background 0.2s;"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 15px; height: 15px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>
                <button class="btn-copy" id="btnCopyKey" onclick="navigator.clipboard.writeText(state?.license?.key || ''); showToast(t('Đã copy Key kích hoạt!', 'Activation Key copied!'), 'success')" style="background: none; border: none; cursor: pointer; color: var(--text-muted); display: none; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; transition: background 0.2s;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
              </div>
              <button class="btn" onclick="showInlineUpgradeInput()" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 600;"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>${t('Nâng cấp gói', 'Upgrade')}</button>
            </div>
            
            <div class="license-body" style="display: none; align-items: center; justify-content: space-between; width: 100%; border-top: 1px dashed var(--border); padding-top: 12px; gap: 12px;" id="licenseUpgradeRow">
              <div style="display: flex; align-items: center; flex: 1; gap: 10px;">
                <strong style="font-size: 14px; min-width: 120px; display: inline-block;">${t('Nâng cấp Key:', 'Upgrade Key:')}</strong>
                <div style="position: relative; display: flex; align-items: center; flex: 1; max-width: 320px;">
                  <input id="upgradeInput" type="password" placeholder="${t('Nhập key nâng cấp...', 'Enter upgrade key...')}" style="width: 100%; padding: 6px 36px 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-family: monospace; font-size: 13px;" />
                  <button id="toggleUpgradeVisibility" onclick="toggleUpgradeVisibility()" style="position: absolute; right: 8px; background: none; border: none; cursor: pointer; color: var(--text-muted); display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;">
                    <svg id="eyeUpgradeOpenIcon" class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 15px; height: 15px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    <svg id="eyeUpgradeClosedIcon" class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 15px; height: 15px; display: none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
                  </button>
                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <button id="btnUpgradeActivate" class="btn primary" onclick="handleUpgradeLicense()" style="padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 600;">${t('Xác thực', 'Verify')}</button>
                <button class="btn" onclick="hideInlineUpgradeInput()" style="padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 600;">${t('Hủy', 'Cancel')}</button>
              </div>
            </div>
          </div>
        `;
  } else {
    html = `
          <div class="license-info" style="display: flex; flex-direction: column; gap: 12px; width: 100%;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
              <div>
                <p style="margin: 0; font-size: 13px; color: var(--text-muted);">${t('Trạng thái kích hoạt:', 'Activation Status:')}</p>
                <span class="status-badge free" style="display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; background: rgba(220, 38, 38, 0.1); color: #dc2626; text-transform: uppercase; margin-top: 4px;">${t('Chưa kích hoạt (Free)', 'Not Activated (Free)')}</span>
              </div>
              <div class="device-id-row" style="display: flex; flex-direction: column; align-items: flex-end;">
                <p style="margin: 0; font-size: 13px; color: var(--text-muted);">${t('Device ID của bạn:', 'Your Device ID:')}</p>
                <div style="display: flex; align-items: center; gap: 6px; margin-top: 4px;">
                  <code id="deviceIdVal" style="background: var(--bg-hover); padding: 4px 8px; border-radius: 6px; font-family: monospace; font-size: 13px; font-weight: 600;">${lic.deviceId || '----'}</code>
                  <button class="btn-copy" onclick="navigator.clipboard.writeText('${lic.deviceId || ''}'); showToast(t('Đã copy Device ID!', 'Device ID copied!'), 'success')" style="background: none; border: none; cursor: pointer; color: var(--text-muted); display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; transition: background 0.2s;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
                </div>
              </div>
            </div>
            
            <div class="license-body" style="display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 12px;">
              <div style="display: flex; align-items: center; flex: 1; gap: 10px;">
                <strong style="font-size: 14px; min-width: 120px; display: inline-block;">${t('Kích hoạt:', 'Activate:')}</strong>
                <div style="position: relative; display: flex; align-items: center; flex: 1; max-width: 320px;">
                  <input id="licenseInput" type="password" placeholder="${t('Nhập key kích hoạt...', 'Enter key...')}" style="width: 100%; padding: 6px 36px 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-family: monospace; font-size: 13px;" />
                  <button id="toggleLicenseVisibility" onclick="toggleLicenseVisibility()" style="position: absolute; right: 8px; background: none; border: none; cursor: pointer; color: var(--text-muted); display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;">
                    <svg id="eyeOpenIcon" class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 15px; height: 15px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    <svg id="eyeClosedIcon" class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 15px; height: 15px; display: none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
                  </button>
                </div>
              </div>
              <button id="btnActivate" class="btn primary" onclick="handleActivateLicense()" style="padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 600;">${t('Xác thực', 'Verify')}</button>
            </div>
          </div>
        `;
  }

  licenseBox.innerHTML = html;

  navButtons.forEach(btn => {
    const sec = btn.dataset.section;
    if (['members', 'api', 'danger'].includes(sec)) {
      let lockIcon = btn.querySelector('.nav-lock-badge');
      if (!isPro) {
        if (!lockIcon) {
          lockIcon = document.createElement('span');
          lockIcon.className = 'nav-lock-badge';
          lockIcon.innerHTML = ' 🔒';
          lockIcon.style.marginLeft = 'auto';
          lockIcon.style.fontSize = '12px';
          btn.appendChild(lockIcon);
        }
      } else {
        if (lockIcon) lockIcon.remove();
      }
    }
  });

  ['members', 'api', 'danger'].forEach(secId => {
    const secEl = document.getElementById(secId);
    if (secEl) {
      let overlay = secEl.querySelector('.locked-overlay');
      if (!isPro) {
        secEl.classList.add('is-locked');
        secEl.style.position = 'relative';
        secEl.style.minHeight = '480px'; // Bảo đảm chiều cao tối thiểu cho section để hiển thị overlay trọn vẹn, tránh bị co rút flexbox
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.className = 'locked-overlay';
          overlay.innerHTML = `
                <svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
                <h3>${t('Tính năng chỉ dành cho bản quyền PRO', 'PRO Feature Only')}</h3>
                <p>${t('Vui lòng kích hoạt mã bản quyền khóa cấp PRO để mở khóa quản lý thành viên, danh sách bạn bè, danh mục API và các thiết lập nguy hiểm.', 'Please activate a PRO license key to unlock member management, friends list, API catalog, and advanced danger zone options.')}</p>
                <button class="btn primary" onclick="setSection('upgrade')">${t('Nâng cấp bản quyền', 'Upgrade License')}</button>
              `;
          secEl.appendChild(overlay);
        }
        overlay.style.display = 'flex';
      } else {
        secEl.classList.remove('is-locked');
        secEl.style.minHeight = '';
        if (overlay) overlay.style.display = 'none';
      }
    }
  });

  const banner = document.querySelector('.free-mode-banner');
  if (banner) {
    banner.style.display = isPro ? 'none' : 'flex';
  }

  let proBanner = document.querySelector('.pro-mode-banner');
  if (proBanner) proBanner.style.display = 'none';
}
async function handleActivateLicense() {
  const key = document.getElementById('licenseInput').value.trim();
  if (!key) {
    showToast(t('Vui lòng nhập key kích hoạt!', 'Please enter an activation key!'), 'warning');
    return;
  }
  const button = document.getElementById('btnActivate');
  setButtonLoading(button, true);
  try {
    const data = await api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'activate-license', payload: { key } }),
    });
    const result = data.result || {};
    if (result.valid) {
      showToast(t('Kích hoạt bản quyền PRO thành công!', 'PRO license activated successfully!'), 'success');
      await loadState();
    } else {
      showToast(result.error || t('Kích hoạt thất bại. Vui lòng kiểm tra lại key!', 'Activation failed. Please check your key!'), 'error');
    }
  } catch (e) {
    showToast(e.message || t('Lỗi kết nối server!', 'Server connection error!'), 'error');
  } finally {
    setButtonLoading(button, false);
  }
}
let paymentPollInterval = null;

async function handlePricingUpgrade(planGroup) {
  if (!planGroup || planGroup === 'free') {
    showToast(t('Bạn đang sử dụng gói Free!', 'You are currently on the Free plan!'), 'info');
    return;
  }

  if (paymentPollInterval) {
    clearInterval(paymentPollInterval);
    paymentPollInterval = null;
  }

  let title = '';
  let desc = '';
  let defaultPlanId = '';

  if (planGroup === 'personal') {
    title = t('Nâng cấp gói Cá nhân', 'Upgrade Personal Plan');
    desc = t('Mở khóa điều khiển nâng cao, dùng cho 1 owner account.', 'Unlock advanced controls, for 1 owner account.');
    defaultPlanId = 'personal-monthly';
  } else if (planGroup === 'team') {
    title = t('Nâng cấp gói Team', 'Upgrade Team Plan');
    desc = t('Dành cho nhiều thành viên, ưu tiên hỗ trợ nhanh hơn.', 'For multiple team operators, priority faster support.');
    defaultPlanId = 'team-monthly';
  } else if (planGroup === 'lifetime') {
    title = t('Mua gói Lifetime', 'Buy Lifetime Plan');
    desc = t('Sử dụng vĩnh viễn trọn đời, phù hợp sử dụng lâu dài.', 'Lifetime perpetual usage, best for long-term stable use.');
    defaultPlanId = 'lifetime';
  }

  let currentOrderId = '';
  let paymentSucceeded = false;

  const selectCycleHtml = planGroup === 'lifetime' ? '' : `
        <div style="margin-bottom: 20px; display: flex; flex-direction: column; align-items: center; gap: 8px; width: 100%;">
          <label style="font-size: 13px; font-weight: 600; color: var(--text); text-align: center; width: 100%;">${t('Chọn chu kỳ thanh toán:', 'Select Billing Cycle:')}</label>
          <div style="display: flex; gap: 10px; background: var(--surface-2); padding: 4px; border-radius: 8px; border: 1px solid var(--border); justify-content: center; max-width: 380px; width: 100%; margin: 0 auto;">
            <button id="btnCycleMonthly" class="btn" style="flex: 1; padding: 8px; font-size: 13px; font-weight: 600; border-radius: 6px; background: var(--primary); color: white;" onclick="changePaymentPlan('${planGroup}-monthly')">${t('1 Tháng', '1 Month')}</button>
            <button id="btnCycleYearly" class="btn" style="flex: 1; padding: 8px; font-size: 13px; font-weight: 600; border-radius: 6px; background: transparent; color: var(--text-muted);" onclick="changePaymentPlan('${planGroup}-yearly')">${t('12 Tháng (Tiết kiệm 20%)', '12 Months (Save 20%)')}</button>
          </div>
        </div>
      `;

  const bodyHtml = `
        <div class="payment-modal-container" style="display: flex; flex-direction: column; gap: 16px; min-width: 320px; max-width: 420px; margin: 0 auto; text-align: left;">
          ${selectCycleHtml}

          <div id="paymentLoadingArea" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 0; gap: 16px;">
            <div class="spinner" style="width: 32px; height: 32px; border: 3px solid var(--primary-soft); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite;"></div>
            <p style="margin: 0; font-size: 13px; color: var(--text-muted);">${t('Đang khởi tạo mã QR thanh toán...', 'Generating payment QR code...')}</p>
          </div>

          <div id="paymentDetailArea" style="display: none; flex-direction: column; align-items: center; gap: 16px;">
            <div style="background: white; padding: 12px; border-radius: 16px; border: 1.5px solid var(--border); display: inline-block; box-shadow: 0 10px 25px rgba(0,0,0,0.05); position: relative; overflow: hidden;" id="qrImageWrapper">
              <img id="paymentQrImg" src="" alt="Payment QR" style="width: 240px; height: 240px; object-fit: contain; border-radius: 8px; display: block;"/>
              <div id="qrSuccessOverlay" style="display: none; position: absolute; inset: 0; background: rgba(16, 185, 129, 0.95); flex-direction: column; align-items: center; justify-content: center; color: white; text-align: center; padding: 20px;">
                <div style="width: 60px; height: 60px; border-radius: 50%; background: white; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; box-shadow: 0 8px 20px rgba(0,0,0,0.15);">
                  <svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="4" style="width: 32px; height: 32px;"><polyline points="20 6 9 17 4 12"></polyline></svg>
                </div>
                <h4 style="margin: 0 0 6px 0; font-size: 16px; font-weight: 800;">${t('Thành công!', 'Success!')}</h4>
                <p style="margin: 0; font-size: 12px; opacity: 0.9;">${t('Hệ thống đã nhận được thanh toán của bạn!', 'We have received your payment!')}</p>
              </div>
            </div>

            <div style="font-size: 13px; color: var(--text); display: flex; flex-direction: column; gap: 6px; background: var(--surface-2); padding: 12px 20px; border-radius: 12px; border: 1px solid var(--border); width: 100%;">
              <div style="display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dashed var(--border); padding-bottom: 6px;"><span style="color: var(--text-muted);">${t('Gói dịch vụ:', 'Plan:')}</span><strong id="payPlanName" style="color: var(--text); text-align: right;">---</strong></div>
              <div style="display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dashed var(--border); padding-bottom: 6px;"><span style="color: var(--text-muted);">${t('Số tiền:', 'Amount:')}</span><strong id="payAmount" style="color: var(--primary); font-size: 14px;">---</strong></div>
              <div style="display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dashed var(--border); padding-bottom: 6px;"><span style="color: var(--text-muted);">${t('Ngân hàng:', 'Bank:')}</span><strong id="payBank" style="color: var(--text);">---</strong></div>
              <div style="display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dashed var(--border); padding-bottom: 6px;"><span style="color: var(--text-muted);">${t('Số tài khoản:', 'Account:')}</span><div style="display: flex; align-items: center; gap: 6px;"><strong id="payAccountVal" style="color: var(--text); font-family: monospace;">---</strong><button class="btn-copy" onclick="copyPaymentField('payAccountVal', '${t('Đã copy số tài khoản!', 'Account number copied!')}')" style="background: none; border: none; cursor: pointer; color: var(--text-muted);">Copy</button></div></div>
              <div style="display: flex; justify-content: space-between; gap: 12px;"><span style="color: var(--text-muted);">${t('Nội dung:', 'Memo:')}</span><div style="display: flex; align-items: center; gap: 6px;"><strong id="payMemoVal" style="color: #ea580c; font-family: monospace; font-size: 12px; text-align: right;">---</strong><button class="btn-copy" onclick="copyPaymentField('payMemoVal', '${t('Đã copy nội dung chuyển khoản!', 'Memo copied!')}')" style="background: none; border: none; cursor: pointer; color: var(--text-muted);">Copy</button></div></div>
            </div>

            <div style="display: flex; gap: 10px; width: 100%; align-items: center;">
              <div style="display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 12px; color: var(--text-muted); background: var(--surface-2); padding: 8px 16px; border-radius: 8px; flex: 1; border: 1px solid var(--border);" id="paymentStatusBox">
                <div class="spinner-small" style="width: 14px; height: 14px; border: 2px solid var(--primary-soft); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite;"></div>
                <span id="paymentStatusText">${t('Đang chờ thanh toán tự động...', 'Waiting for automatic payment...')}</span>
              </div>
            </div>
          </div>
        </div>
      `;

  if (!document.getElementById('spinAnimation')) {
    const style = document.createElement('style');
    style.id = 'spinAnimation';
    style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }

  const oldCancelDisplay = modalCancel.style.display;
  const oldCancelText = modalCancel.textContent;
  const oldCancelClass = modalCancel.className;

  modalCancel.style.display = 'inline-flex';
  modalCancel.textContent = t('Hủy thanh toán', 'Cancel payment');
  modalCancel.className = 'btn danger';

  async function cancelPaymentNow(reason = 'user') {
    if (!currentOrderId || paymentSucceeded) return false;
    const orderId = currentOrderId;
    currentOrderId = '';
    const btn = modalCancel || document.getElementById('btnCancelPayment');
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('Đang hủy...', 'Canceling...');
    }
    if (paymentPollInterval) {
      clearInterval(paymentPollInterval);
      paymentPollInterval = null;
    }
    try {
      await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'cancel-payment', payload: { orderId, reason } }) });
      showToast(t('Đã hủy giao dịch thanh toán.', 'Payment order canceled.'), 'info');
      return true;
    } catch (e) {
      console.warn('cancel-payment failed', e);
      showToast(t('Không thể hủy giao dịch, đơn sẽ tự hết hạn sau ít phút.', 'Could not cancel the order; it will expire automatically.'), 'warning');
      return false;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('Hủy thanh toán', 'Cancel payment');
      }
    }
  }

  window.copyPaymentField = function (elementId, toastMsg) {
    const txt = document.getElementById(elementId)?.textContent || '';
    navigator.clipboard.writeText(txt);
    showToast(toastMsg, 'success');
  };

  window.changePaymentPlan = async function (planId) {
    await cancelPaymentNow('change-plan');
    currentOrderId = '';
    const isMonthly = planId.endsWith('-monthly');
    const btnM = document.getElementById('btnCycleMonthly');
    const btnY = document.getElementById('btnCycleYearly');
    if (btnM && btnY) {
      btnM.style.background = isMonthly ? 'var(--primary)' : 'transparent';
      btnM.style.color = isMonthly ? 'white' : 'var(--text-muted)';
      btnY.style.background = isMonthly ? 'transparent' : 'var(--primary)';
      btnY.style.color = isMonthly ? 'var(--text-muted)' : 'white';
    }
    await loadPaymentQR(planId);
  };

  async function loadPaymentQR(planId) {
    if (paymentPollInterval) {
      clearInterval(paymentPollInterval);
      paymentPollInterval = null;
    }
    paymentSucceeded = false;

    const loadArea = document.getElementById('paymentLoadingArea');
    const detailArea = document.getElementById('paymentDetailArea');
    if (loadArea && detailArea) {
      loadArea.style.display = 'flex';
      detailArea.style.display = 'none';
    }

    try {
      const res = await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'create-payment', payload: { planId } }) });
      if (!(res.ok && res.result && res.result.ok)) {
        showToast(res.error || t('Không thể khởi tạo đơn thanh toán!', 'Failed to generate payment order!'), 'error');
        return;
      }

      const order = res.result.order;
      currentOrderId = order.orderId;
      document.getElementById('paymentQrImg').src = order.qrUrl || `https://img.vietqr.io/image/970422-0962794917-compact2.png?amount=${order.amount}&addInfo=${encodeURIComponent(order.memo || '')}&accountName=${encodeURIComponent(order.accountName || 'HO LE MINH TUAN')}`;
      document.getElementById('payPlanName').textContent = order.planName || '---';
      document.getElementById('payAmount').textContent = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(order.amount || 0);
      document.getElementById('payBank').textContent = order.bankName || 'MB Bank';
      document.getElementById('payAccountVal').textContent = order.accountNo || '0962794917';
      document.getElementById('payMemoVal').textContent = order.memo || '';

      if (loadArea && detailArea) {
        loadArea.style.display = 'none';
        detailArea.style.display = 'flex';
      }

      // Moved cancel button to modal footer, handled automatically on modal resolve

      paymentPollInterval = setInterval(async () => {
        try {
          const checkRes = await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'check-payment-status', payload: { orderId: currentOrderId } }) });
          if (checkRes.ok && checkRes.result && checkRes.result.paid) {
            paymentSucceeded = true;
            clearInterval(paymentPollInterval);
            paymentPollInterval = null;
            const successOverlay = document.getElementById('qrSuccessOverlay');
            if (successOverlay) successOverlay.style.display = 'flex';
            const statusBox = document.getElementById('paymentStatusBox');
            if (statusBox) {
              statusBox.style.background = 'rgba(16, 185, 129, 0.1)';
              statusBox.style.borderColor = 'rgba(16, 185, 129, 0.2)';
              statusBox.style.color = '#10b981';
              statusBox.innerHTML = `<strong>${t('Đã kích hoạt bản quyền PRO!', 'PRO License Activated!')}</strong>`;
            }
            showToast(t('Kích hoạt bản quyền PRO thành công!', 'PRO license activated successfully!'), 'success');
            setTimeout(() => closeModal(true), 2500);
          }
        } catch (e) {
          console.error('Error polling payment status:', e);
        }
      }, 3000);
    } catch (e) {
      showToast(e.message || t('Lỗi kết nối server!', 'Server connection error!'), 'error');
    }
  }

  setTimeout(() => loadPaymentQR(defaultPlanId), 100);
  const modalResult = await openModal({ title, desc, body: bodyHtml });

  if (paymentPollInterval) {
    clearInterval(paymentPollInterval);
    paymentPollInterval = null;
  }
  if (modalResult === false) await cancelPaymentNow('close');

  modalConfirm.textContent = oldConfirmText;
  modalConfirm.classList.remove('btn-outline');
  modalConfirm.classList.add('primary');
  modalCancel.style.display = oldCancelDisplay;
  modalCancel.textContent = oldCancelText;
  modalCancel.className = oldCancelClass;

  if (modalResult === true) await loadState();
}
async function runAction(action, payload = {}, label = 'Action completed') {
  const button = activeActionButton;
  setButtonLoading(button, true);
  try {
    const data = await api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ action, payload }),
    });
    if (data.state) state = data.state;
    renderState();
    refreshDetailModal();
    showToast(actionToast(action, data.result, label), 'success');
    return data.result;
  } catch (error) {
    showToast(`${t('Thao tác lỗi', 'Action failed')} - ${error.message}`, 'error');
    throw error;
  } finally {
    setButtonLoading(button, false);
  }
}
function renderState() {
  if (!state) return;

  // Render topbar bot filter
  const topbarBotFilter = document.getElementById('topbarBotFilter');
  if (topbarBotFilter && state.bots) {
    if (state.bots.length > 1) {
      if (!document.getElementById('topbarBotSelect')) {
        let selectHtml = `
          <div class="custom-select-container" id="topbarBotSelectContainer" style="flex: 1; min-width: 150px; max-width: 180px;">
            <div class="custom-select-trigger" id="topbarBotSelectTrigger" style="width: 100%; padding: 6px 10px; border-radius: 10px; font-size: 13px; height: 36px; align-items: center; gap: 8px;">
              <div class="custom-select-trigger-content" style="gap: 8px;">
                <div class="custom-select-avatar" id="selectedTopbarBotAvatar" style="width: 20px; height: 20px; font-size: 9px;">🤖</div>
                <span class="custom-select-name" id="selectedTopbarBotName" style="font-size: 13px;">${t('Tất cả bot', 'All bots')}</span>
                <span class="custom-select-badge" id="selectedTopbarBotBadge" style="display: none; font-size: 9px; padding: 1px 4px; margin-left: 2px;"></span>
              </div>
              <svg class="custom-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </div>
            <div class="custom-select-dropdown" id="topbarBotSelectDropdown" style="width: 100%; top: calc(100% + 4px); border-radius: 12px; padding: 8px; z-index: 1001;"></div>
          </div>
          <select id="topbarBotSelect" style="display: none;">
            <option value="all">${t('Tất cả bot', 'All bots')}</option>
            ${state.bots.map(bot => `<option value="${esc(bot.profile)}">${esc(repairText(bot.name))}</option>`).join('')}
          </select>
        `;
        topbarBotFilter.innerHTML = selectHtml;

        const topbarContainer = document.getElementById('topbarBotSelectContainer');
        const topbarTrigger = document.getElementById('topbarBotSelectTrigger');
        if (topbarTrigger && topbarContainer) {
          topbarTrigger.addEventListener('click', event => {
            event.stopPropagation();
            topbarContainer.classList.toggle('open');
            // Close other dropdowns
            const memberContainer = document.getElementById('membersBotSelectContainer');
            if (memberContainer) memberContainer.classList.remove('open');
            const groupContainer = document.getElementById('groupsBotSelectContainer');
            if (groupContainer) groupContainer.classList.remove('open');
          });
        }
      } else {
        document.getElementById('topbarBotSelect').value = selectedBotFilter;
      }

      // Populate options in Topbar Custom Dropdown
      const topbarDropdown = document.getElementById('topbarBotSelectDropdown');
      if (topbarDropdown) {
        const allBotsText = t('Tất cả bot', 'All bots');
        const allActive = selectedBotFilter === 'all';
        
        let optionsHtml = `
          <div class="custom-select-option-pill ${allActive ? 'active' : ''}" data-select-topbar-profile="all" style="padding: 6px 10px; border-radius: 8px; gap: 8px; font-size: 13px;">
            <div class="custom-select-avatar" style="width: 20px; height: 20px; font-size: 9px; background: linear-gradient(135deg, #64748b 0%, #334155 100%) ${allActive ? '!important' : ''}; color: white ${allActive ? '!important' : ''};">🤖</div>
            <span class="custom-select-name">${allBotsText}</span>
            <span class="custom-select-badge" style="font-size: 9px; padding: 1px 4px;">${state.bots.length} ${t('bot', 'bots')}</span>
          </div>
        `;

        state.bots.forEach(bot => {
          const isActive = selectedBotFilter === bot.profile;
          const initials = getBotInitials(bot);
          const theme = getBotTheme(bot);
          
          const cachedProfile = bot.userId ? (state.bot?.cachedProfiles?.[bot.userId] || (cachedFriends || []).find(f => String(f.userId) === String(bot.userId))) : null;
          const avatarUrl = bot.avatar || cachedProfile?.avatar || cachedProfile?.avatarUrl || '';
          
          const avatarContentHtml = avatarUrl
            ? `<img src="${esc(avatarUrl)}" alt="${esc(bot.name)}" onerror="const p=this.parentElement; this.remove(); if(p)p.textContent='${esc(initials)}'">`
            : esc(initials);

          optionsHtml += `
            <div class="custom-select-option-pill ${isActive ? 'active' : ''}" data-select-topbar-profile="${esc(bot.profile)}" style="padding: 6px 10px; border-radius: 8px; gap: 8px; font-size: 13px;">
              <div class="custom-select-avatar" style="width: 20px; height: 20px; font-size: 8px; background: ${theme.gradient} ${isActive ? '!important' : ''}; color: white ${isActive ? '!important' : ''};">
                ${avatarContentHtml}
              </div>
              <span class="custom-select-name">${esc(repairText(bot.name))}</span>
              <span class="custom-select-badge" style="font-size: 9px; padding: 1px 4px;">${esc(theme.badgeText)}</span>
            </div>
          `;
        });

        topbarDropdown.innerHTML = optionsHtml;

        // Update selected trigger contents for Topbar
        const activeBot = state.bots.find(b => b.profile === selectedBotFilter);
        const triggerAvatar = document.getElementById('selectedTopbarBotAvatar');
        const triggerName = document.getElementById('selectedTopbarBotName');
        const triggerBadge = document.getElementById('selectedTopbarBotBadge');

        if (triggerAvatar && triggerName && triggerBadge) {
          if (selectedBotFilter === 'all') {
            triggerAvatar.innerHTML = '🤖';
            triggerAvatar.style.background = 'linear-gradient(135deg, #64748b 0%, #334155 100%)';
            triggerName.textContent = allBotsText;
            triggerBadge.style.display = 'none';
          } else if (activeBot) {
            const initials = getBotInitials(activeBot);
            const theme = getBotTheme(activeBot);
            const cachedProfile = activeBot.userId ? (state.bot?.cachedProfiles?.[activeBot.userId] || (cachedFriends || []).find(f => String(f.userId) === String(activeBot.userId))) : null;
            const avatarUrl = activeBot.avatar || cachedProfile?.avatar || cachedProfile?.avatarUrl || '';

            const avatarContentHtml = avatarUrl
              ? `<img src="${esc(avatarUrl)}" alt="${esc(activeBot.name)}" onerror="const p=this.parentElement; this.remove(); if(p)p.textContent='${esc(initials)}'">`
              : esc(initials);

            triggerAvatar.innerHTML = avatarContentHtml;
            triggerAvatar.style.background = theme.gradient;
            triggerName.textContent = repairText(activeBot.name);
            triggerBadge.textContent = theme.badgeText;
            triggerBadge.style.display = 'inline-block';
            triggerBadge.className = `custom-select-badge ${theme.badgeClass}`;
          }
        }

        // Bind click handler to pills
        topbarDropdown.querySelectorAll('[data-select-topbar-profile]').forEach(pill => {
          pill.addEventListener('click', event => {
            event.stopPropagation();
            const profile = event.currentTarget.dataset.selectTopbarProfile;
            selectedBotFilter = profile;
            selectedGroupBotFilter = profile;
            selectedMemberBotFilter = profile;
            currentMembersPage = 1;

            const nativeSelect = document.getElementById('topbarBotSelect');
            if (nativeSelect) nativeSelect.value = profile;
            const groupSelect = document.getElementById('groupBotSelect');
            if (groupSelect) groupSelect.value = profile;
            const memberSelect = document.getElementById('memberBotSelect');
            if (memberSelect) memberSelect.value = profile;

            const topbarContainer = document.getElementById('topbarBotSelectContainer');
            if (topbarContainer) topbarContainer.classList.remove('open');

            renderState();
            refreshActiveOnDemandSection();
          });
        });
      }
    } else {
      topbarBotFilter.innerHTML = '';
    }
  }

  // Render mobile/tablet sub-topbar bot filter
  const mobileBotFilterBar = document.getElementById('mobileBotFilterBar');
  if (mobileBotFilterBar) {
    if (state.bots && state.bots.length > 1) {
      const allBotsText = t('Tất cả bot', 'All bots');
      const allActive = selectedBotFilter === 'all';
      
      let pillsHtml = `
        <div class="bot-pill ${allActive ? 'active' : ''}" data-mobile-profile="all">
          <div class="bot-pill-avatar">🤖</div>
          <span>${allBotsText}</span>
        </div>
      `;
      
      state.bots.forEach(bot => {
        const isActive = selectedBotFilter === bot.profile;
        const initials = getBotInitials(bot);
        const theme = getBotTheme(bot);
        const cachedProfile = bot.userId ? (state.bot?.cachedProfiles?.[bot.userId] || (cachedFriends || []).find(f => String(f.userId) === String(bot.userId))) : null;
        const avatarUrl = bot.avatar || cachedProfile?.avatar || cachedProfile?.avatarUrl || '';
        
        const avatarContentHtml = avatarUrl
          ? `<img src="${esc(avatarUrl)}" alt="${esc(bot.name)}" onerror="const p=this.parentElement; this.remove(); if(p)p.textContent='${esc(initials)}'">`
          : esc(initials);
          
        pillsHtml += `
          <div class="bot-pill ${isActive ? 'active' : ''}" data-mobile-profile="${esc(bot.profile)}">
            <div class="bot-pill-avatar" style="background: ${theme.gradient};">
              ${avatarContentHtml}
            </div>
            <span>${esc(repairText(bot.name))}</span>
          </div>
        `;
      });
      
      mobileBotFilterBar.innerHTML = pillsHtml;
      
      // Bind click handlers
      mobileBotFilterBar.querySelectorAll('[data-mobile-profile]').forEach(pill => {
        pill.addEventListener('click', event => {
          const profile = event.currentTarget.dataset.mobileProfile;
          selectedBotFilter = profile;
          selectedGroupBotFilter = profile;
          selectedMemberBotFilter = profile;
          currentMembersPage = 1;
          
          // Sync with other dropdowns/select elements
          const nativeSelect = document.getElementById('topbarBotSelect');
          if (nativeSelect) nativeSelect.value = profile;
          const groupSelect = document.getElementById('groupBotSelect');
          if (groupSelect) groupSelect.value = profile;
          const memberSelect = document.getElementById('memberBotSelect');
          if (memberSelect) memberSelect.value = profile;

          renderState();
          refreshActiveOnDemandSection();
        });
      });

      document.body.classList.toggle('has-sub-topbar', window.innerWidth <= 991);
    } else {
      mobileBotFilterBar.innerHTML = '';
      document.body.classList.remove('has-sub-topbar');
    }
  }

  // Sync and merge backend cached profiles into local frontend cache
  if (state.bot && state.bot.cachedProfiles) {
    if (!cachedFriends) cachedFriends = [];
    let changed = false;
    Object.values(state.bot.cachedProfiles).forEach(p => {
      const id = String(p.userId || '').replace(/_0$/, '');
      if (!id) return;
      const idx = cachedFriends.findIndex(f => String(f.userId) === id);
      if (idx !== -1) {
        if (p.displayName && (!cachedFriends[idx].displayName || cachedFriends[idx].displayName === id)) {
          cachedFriends[idx] = { ...cachedFriends[idx], ...p };
          changed = true;
        }
      } else {
        cachedFriends.push(p);
        changed = true;
      }
    });
    if (changed) {
      saveCachedFriendsToStorage();
    }
  }

  applyI18n();
  const ownerProfile = state.bot.ownerId ? (cachedFriends || []).find(f => String(f.userId) === String(state.bot.ownerId)) : null;

  const ownerDisplayName = state.bot.ownerName && state.bot.ownerName !== state.bot.ownerId && state.bot.ownerName !== 'Owner'
    ? state.bot.ownerName
    : (ownerProfile && ownerProfile.displayName ? ownerProfile.displayName : (state.bot.ownerName || 'Owner'));

  const ownerAvatarUrl = state.bot.ownerAvatar
    ? state.bot.ownerAvatar
    : (ownerProfile && ownerProfile.avatar ? ownerProfile.avatar : '');

  document.getElementById('ownerName').textContent = repairText(ownerDisplayName);
  document.getElementById('ownerRole').textContent = t('Owner', 'Owner');
  const currentVersion = state.pluginVersion || pluginVersion;
  document.getElementById('pluginVersion').textContent = `v${currentVersion}`;

  const avatarEl = document.querySelector('.owner-pill .avatar');
  if (avatarEl) {
    if (ownerAvatarUrl) {
      avatarEl.innerHTML = `<img src="${esc(ownerAvatarUrl)}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" onerror="this.parentElement.textContent='${esc(ownerDisplayName.slice(0, 1).toUpperCase())}'" />`;
    } else {
      avatarEl.textContent = ownerDisplayName.slice(0, 1).toUpperCase();
    }
  }
  syncChromeState();
  const metrics = document.querySelectorAll('.metric strong');
  if (metrics[0]) metrics[0].textContent = state.totals.groups;
  if (metrics[1]) metrics[1].textContent = countPendingHint();
  if (metrics[2]) metrics[2].textContent = state.totals.warnings;
  if (metrics[3]) metrics[3].textContent = state.totals.violations;

  const trends = document.querySelectorAll('.metric .trend');
  if (trends[0]) trends[0].innerHTML = `+${state.totals.groups || 0} ${t('group từ session', 'groups from session')}`;
  if (trends[1]) trends[1].innerHTML = `${countPendingHint()} ${t('cần review hôm nay', 'need review today')}`;
  if (trends[2]) trends[2].innerHTML = `${state.totals.warnings || 0} ${t('request mới', 'new requests')}`;
  if (trends[3]) trends[3].innerHTML = t('Cần xác nhận 2 bước', 'Requires two-step confirmation');

  renderOverviewGroups();

  // Clear redundant local bot filters since we now use the global topbar bot filter
  const groupFiltersContainer = document.getElementById('groupBotFilters');
  const memberFiltersContainer = document.getElementById('memberBotFilters');
  if (groupFiltersContainer) groupFiltersContainer.innerHTML = '';
  if (memberFiltersContainer) memberFiltersContainer.innerHTML = '';

  renderGroups();
  renderMembers();
  renderAudit();
  updateBulkBar();
  renderLicense();
  renderComposerTargets();
  renderTemplates();

  // Trang phân quyền chỉ render lúc mở tab. Nếu người dùng mở tab đó TRƯỚC khi
  // /api/state về thì lúc ấy chưa có state để biết đang cấu hình cho bot nào —
  // nạp lại ngay khi state có, nếu không trang sẽ đứng ở "Đang tải...".
  if (document.getElementById('permissions')?.classList.contains('active') && !permState.data) renderPermissions();
}
function countPendingHint() {
  return state.groups.reduce((sum, group) => sum + (group.pendingCount || 0), 0);
}
function status(value, onLabel, offLabel) {
  return `<span class="status ${value ? 'on' : 'off'}">${value ? onLabel : offLabel}</span>`;
}
function uiText(vi, en) {
  return t(vi, en);
}
// Một group có thể có nhiều bot → profile lưu dạng CSV "default,zuli_bot_le"
function profileList(profile) {
  return String(profile == null ? 'default' : profile).split(',').map(s => s.trim()).filter(Boolean);
}
function getBotBadge(profile) {
  const profiles = profileList(profile);
  if (profiles.length === 0) profiles.push('default');
  return profiles.map(p => {
    const bot = state.bots?.find(b => b.profile === p);
    const name = bot ? (bot.name || bot.id || p || 'default') : (p || 'default');
    // `bot.id`/`bot.name` từng được coi là luôn có. Một bot thiếu một trong hai là ném ngay tại đây,
    // mà hàm này nằm trong `renderState()` — nên cả trang ngừng cập nhật: đổi bot xong danh sách
    // không đổi, không báo lỗi gì. Mất khá lâu mới lần ra vì triệu chứng là "bộ lọc không chạy".
    const hay = `${bot?.id || ''} ${bot?.name || ''} ${p || ''}`.toLowerCase();
    const isWholesale = hay.includes('si') || hay.includes('2');
    const badgeClass = isWholesale ? 'si' : 'le';
    return `<span class="bot-badge badge-${badgeClass}">${esc(name)}</span>`;
  }).join(' ');
}
function getBotInitials(bot) {
  if (!bot) return '🤖';
  const nameLower = (bot.name || '').toLowerCase();
  const idLower = (bot.id || '').toLowerCase();
  const profileLower = (bot.profile || '').toLowerCase();
  
  if (nameLower.includes('si') || idLower.includes('si') || profileLower.includes('si')) return 'SỈ';
  if (nameLower.includes('le') || idLower.includes('le') || profileLower.includes('le')) return 'LẺ';
  
  const name = bot.name || bot.id || 'B';
  const parts = name.split(/[\s_.-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
function getBotTheme(bot) {
  if (!bot) return {
    gradient: 'linear-gradient(135deg, #64748b 0%, #334155 100%)',
    badgeText: '',
    badgeClass: 'neutral'
  };
  const nameLower = (bot.name || '').toLowerCase();
  const idLower = (bot.id || '').toLowerCase();
  const profileLower = (bot.profile || '').toLowerCase();
  
  if (nameLower.includes('si') || idLower.includes('si') || profileLower.includes('si') || nameLower.includes('wholesale')) {
    return {
      gradient: 'linear-gradient(135deg, #10b981 0%, #047857 100%)',
      badgeText: t('Sỉ', 'WS'),
      badgeClass: 'si'
    };
  }
  if (nameLower.includes('le') || idLower.includes('le') || profileLower.includes('le') || nameLower.includes('retail')) {
    return {
      gradient: 'linear-gradient(135deg, var(--primary) 0%, var(--primary-deep) 100%)',
      badgeText: t('Lẻ', 'Retail'),
      badgeClass: 'le'
    };
  }
  // Generic fallback: choose a color gradient using a simple hash of the bot's name/profile
  const hashStr = bot.name || bot.id || 'bot';
  let hash = 0;
  for (let i = 0; i < hashStr.length; i++) {
    hash = hashStr.charCodeAt(i) + ((hash << 5) - hash);
  }
  const gradients = [
    'linear-gradient(135deg, var(--primary) 0%, var(--primary-deep) 100%)',
    'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
    'linear-gradient(135deg, #f97316 0%, #c2410c 100%)',
    'linear-gradient(135deg, #ec4899 0%, #be185d 100%)'
  ];
  const absHash = Math.abs(hash);
  return {
    gradient: gradients[absHash % gradients.length],
    badgeText: t('Bot', 'Bot'),
    badgeClass: 'other'
  };
}
function groupRows(limit) {
  const visibleGroups = state.groups.filter(groupMatchesFilter);
  return visibleGroups.slice(0, limit || visibleGroups.length).map(group => `
        <tr>
          <td class="col-overview-group" data-label="${esc(t('Group', 'Group'))}">
            <div style="display: flex; align-items: center; gap: 4px;">
              <strong>${esc(repairText(group.name))}</strong>
              ${getBotBadge(group.profile)}
            </div>
            <small>${esc(group.groupId)}</small>
          </td>
          <td class="col-overview-members" data-label="${esc(t('Thành viên', 'Members'))}">${group.memberCount}</td>
          <td class="col-overview-violations" data-label="${esc(t('Cảnh báo', 'Violations'))}"><span class="status ${group.violationCount ? 'warn' : 'off'}">${group.violationCount} ${t('vi phạm', 'violations')}</span></td>
          <td class="col-overview-mode" data-label="${esc(t('Mode', 'Mode'))}">${status(botSettings(group).silent, 'Silent', 'Normal')} ${status(botSettings(group).welcome, 'Welcome', t('\u004b\u0068\u00f4\u006e\u0067 welcome', 'No welcome'))}</td>
          <td class="col-overview-actions" data-label="${esc(t('\u0048\u00e0\u006e\u0068 \u0111\u1ed9\u006e\u0067', 'Action'))}"><button class="btn" data-open-members="${esc(group.groupId)}"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; margin-right: 4px; vertical-align: middle;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>${t('Thành viên', 'Members')}</button></td>
        </tr>
      `).join('');
}
function renderGroupModePills(group) {
  const modes = Array.isArray(group.customModes) ? group.customModes : [];
  if (!modes.length) return '';
  return `<div class="mode-list">${modes.map(mode => `
        <div class="mode-pill ${mode.enabled ? 'on' : 'off'}">
          <span>${esc(repairText(mode.label))}</span>
          <small>${esc(repairText(mode.skill))}</small>
          <button class="btn" type="button" data-toggle-custom="${esc(group.groupId)}:${esc(mode.slug)}:${mode.enabled ? 'off' : 'on'}">${mode.enabled ? 'Off' : 'On'}</button>
          <button class="btn" type="button" data-edit-mode="${esc(group.groupId)}:${esc(mode.slug)}">${'Edit'}</button>
        </div>
      `).join('')}</div>`;
}
function renderOverviewGroups() {
  const tbody = document.querySelector('#overview tbody');
  if (!tbody) return;
  tbody.innerHTML = groupRows(5) || `<tr><td colspan="5">${t('Chưa có group. Hãy chạy Sync Account.', 'No groups yet. Run Sync Account.')}</td></tr>`;
}
function approvalHtml(group) {
  const pending = Number(group.pendingCount || 0);
  return `<div class="approval-stack"><span class="member-badge">${group.memberCount || 0} ${uiText('members', 'members')}</span><span class="status ${pending ? 'warn' : 'off'}">${pending} ${uiText('đang chờ', 'pending')}</span></div>`;
}
// Per-bot group state helpers. When a specific bot is selected in the top bar, show
// and toggle THAT bot's settings + groupId (each bot has its own per-account groupId,
// so state is independent). On "all bots" we fall back to the merged/aggregate row.
function selBotProfile() {
  return (selectedBotFilter && selectedBotFilter !== 'all') ? selectedBotFilter : '';
}
function botSettings(group) {
  const p = selBotProfile();
  return (p && group.settingsByProfile && group.settingsByProfile[p]) || group.settings || {};
}
function botGroupId(group) {
  const p = selBotProfile();
  return (p && group.groupIdByProfile && group.groupIdByProfile[p]) || group.groupId;
}
function featureToggle(group, key, label) {
  const on = !!botSettings(group)[key];
  const gid = botGroupId(group);
  return `<button class="feature-toggle ${on ? 'on' : 'off'}" type="button" data-toggle="${esc(gid)}:${key}:${!on}" data-toggle-profile="${esc(selBotProfile())}">${label}</button>`;
}
function hiddenGroupIds() {
  return new Set(); // Không hardcode — hiển thị tất cả groups từ ZCA
}
function groupPeople(group) {
  const memberMap = state.members?.[group.groupId] || {};
  const ownerId = String(group.creatorId || '');
  const adminIds = Array.isArray(group.admins) ? group.admins.map(String) : [];
  const ids = [...new Set([ownerId, ...adminIds].filter(Boolean))];
  return ids.map(id => {
    const raw = memberMap[id];
    const meta = avatarMeta(typeof raw === 'object' ? raw : { name: raw, id }, id);
    return {
      id,
      name: meta.name || repairText(raw?.name || raw || id),
      avatar: meta.src,
      role: id === ownerId ? uiText('Owner', 'Owner') : uiText('Admin', 'Admin'),
      owner: id === ownerId,
    };
  });
}
function personChip(person) {
  const initials = person.name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'U';
  const avatar = person.avatar || '';
  const avatarHtml = avatar
    ? `<span class="person-avatar"><img src="${esc(avatar)}" alt="${esc(person.name || 'avatar')}" onerror="const p=this.parentElement; this.remove(); if(p)p.textContent='${esc(initials)}'"></span>`
    : `<span class="person-avatar">${esc(initials)}</span>`;
  return `<button class="person-chip ${person.owner ? 'owner' : 'admin'}" type="button" data-copy-id="${esc(person.id)}" title="${esc(person.id)}">
        ${avatarHtml}
        <span>
          <span class="person-name">${esc(person.name)}</span><br>
          <span class="person-role">${esc(person.role)}</span>
        </span>
      </button>`;
}
function avatarMeta(source, fallbackLabel = '') {
  const raw = source && typeof source === 'object' ? source : {};
  const name = repairText(raw.name || raw.displayName || raw.userName || raw.nickName || raw.zaloName || fallbackLabel || raw.id || raw.uid || '');
  const src = String(
    raw.avatar || raw.avatarUrl || raw.avatar_url || raw.photo || raw.photoUrl || raw.picture || raw.pictureUrl || raw.thumb || raw.thumbUrl || raw.image || raw.imageUrl || raw.profilePic || raw.profileImage || raw.avatarData || raw.avatarSrc || raw.profile?.avatar || raw.profile?.avatarUrl || raw.info?.avatar || raw.info?.avatarUrl || raw.user?.avatar || raw.user?.avatarUrl || raw.userInfo?.avatar || raw.userInfo?.avatarUrl || ''
  ).trim();
  const initials = String(name || fallbackLabel || 'U').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'U';
  return { name, src, initials };
}
function groupMatchesFilter(group) {
  if (hiddenGroupIds().has(String(group.groupId))) return false;
  if (selectedBotFilter !== 'all' && !profileList(group.profile).includes(selectedBotFilter)) return false;
  if (currentGroupFilter === 'silent') return !!botSettings(group).silent;
  if (currentGroupFilter === 'welcome') return !!botSettings(group).welcome;
  if (currentGroupFilter === 'muted') return !!botSettings(group).muted;
  if (currentGroupFilter === 'spam') return Number(group.violationCount || 0) > 0;
  return true;
}
function renderGroups() {
  const tbody = document.querySelector('#groups tbody');
  if (!tbody) return;
  const visibleGroups = state.groups.filter(groupMatchesFilter);
  tbody.innerHTML = visibleGroups.map(group => `
        <tr>
          <td class="col-group" data-label="${esc(t('Group', 'Group'))}">
            <div class="group-title-line">
              <input class="group-select" type="checkbox" data-select-group="${esc(group.groupId)}" ${selectedGroups.has(group.groupId) ? 'checked' : ''} aria-label="Select group">
              <div class="group-meta">
                <div style="display: flex; align-items: center; gap: 4px;">
                  <button class="group-link-button" type="button" data-group-detail="${esc(group.groupId)}">${esc(repairText(group.name))}</button>
                  ${getBotBadge(group.profile)}
                </div>
                <small>${esc(group.groupId)}</small>
              </div>
            </div>
          </td>
          <td class="col-approval" data-label="${esc(uiText('Duyệt member', 'Approval'))}">${approvalHtml(group)}</td>
          <td class="col-features" data-label="${esc(uiText('Tính năng', 'Features'))}">
            <div class="feature-toggles">
              ${featureToggle(group, 'muted', 'Mute')}
              ${featureToggle(group, 'silent', 'Silent')}
              ${featureToggle(group, 'welcome', 'Welcome')}
              ${featureToggle(group, 'follow', 'Follow')}
              ${featureToggle(group, 'pendingAuto', uiText('Tự duyệt', 'Auto approve'))}
            </div>
          </td>
          <td class="col-actions" data-label="${esc(uiText('Thao tác', 'Actions'))}">
            <div class="icon-actions">
              <button class="icon-btn" type="button" data-scan-members="${esc(group.groupId)}" aria-label="${esc(uiText('Quét member', 'Scan members'))}" title="${esc(uiText('Quét member', 'Scan members'))}">
                <svg viewBox="0 0 24 24" fill="none"><path d="M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6M20 20h-6M20 20v-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9.5 12a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0Zm-3.5 7a6 6 0 0 1 12 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
              <button class="icon-btn" type="button" data-group-detail="${esc(group.groupId)}" aria-label="${esc(uiText('Chi tiết', 'Details'))}" title="${esc(uiText('Chi tiết', 'Details'))}">
                <svg viewBox="0 0 24 24" fill="none"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>
              </button>
              <button class="icon-btn" type="button" data-leave-group="${esc(group.groupId)}" aria-label="${esc(uiText('Rời nhóm', 'Leave group'))}" title="${esc(uiText('Rời nhóm', 'Leave group'))}">
                <svg viewBox="0 0 24 24" fill="none"><path d="M9 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-2" stroke="currentColor" stroke-width="2"/><path d="M14 12H3m0 0 3-3m-3 3 3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
          </td>
        </tr>
      `).join('') || `<tr><td colspan="4">No groups yet. Run Sync Account.</td></tr>`;
  document.querySelectorAll('[data-select-group]').forEach(input => {
    input.addEventListener('change', event => {
      const groupId = event.currentTarget.dataset.selectGroup;
      if (event.currentTarget.checked) selectedGroups.add(groupId);
      else selectedGroups.delete(groupId);
      updateBulkBar();
    });
  });
}
function updateBulkBar() {
  const node = document.getElementById('bulkCount');
  if (!node) return;
  node.textContent = `${selectedGroups.size} group selected`;
  const actions = document.getElementById('bulkActions');
  if (!actions || !state) return;
  const visibleGroups = state.groups.filter(groupMatchesFilter);
  const selectedVisible = visibleGroups.filter(group => selectedGroups.has(group.groupId));
  const allVisibleSelected = visibleGroups.length > 0 && selectedVisible.length === visibleGroups.length;
  const defs = [
    ['muted', 'Mute'],
    ['silent', 'Silent'],
    ['welcome', 'Welcome'],
    ['follow', 'Follow'],
    ['pendingAuto', 'Auto approve'],
  ];
  actions.innerHTML = `
        <button class="btn ${allVisibleSelected ? 'primary' : ''}" type="button" data-select-all-groups>${allVisibleSelected ? uiText('Bỏ chọn tất cả', 'Clear all') : uiText('Chọn tất cả', 'Select all')}</button>
        ${defs.map(([key, label]) => {
    const allOn = selectedVisible.length > 0 && selectedVisible.every(group => !!botSettings(group)[key]);
    return `<button class="feature-toggle ${allOn ? 'on' : 'off'}" type="button" data-bulk-feature="${key}:${!allOn}">${label}</button>`;
  }).join('')}
      `;
}
// ── Shared group dropdown (dùng chung Members + Nhật ký) ──────────────────
// Tái sử dụng UI .custom-select-* / avatarMeta / getBotBadge. Điền pill + trigger
// cho một custom-select bất kỳ dựa trên các id truyền vào.
function populateGroupDropdown({ groups, dropdownId, avatarId, nameId, badgeId, containerId, onSelect }) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;
  dropdown.innerHTML = groups.map(g => {
    const avatar = avatarMeta(g, g.name);
    const isActive = activeGroupId === g.groupId;
    return `
          <div class="custom-select-option-pill ${isActive ? 'active' : ''}" data-select-group-id="${esc(g.groupId)}">
            ${avatar.src
        ? `<div class="custom-select-avatar"><img src="${esc(avatar.src)}" alt="${esc(avatar.name || 'avatar')}" onerror="const p=this.parentElement; this.remove(); if(p)p.textContent='${esc(avatar.initials)}'"></div>`
        : `<div class="custom-select-avatar">${esc(avatar.initials)}</div>`}
            <span class="custom-select-name" style="display: flex; align-items: center; gap: 4px;">
              ${esc(repairText(g.name))}
              ${getBotBadge(g.profile)}
            </span>
            <span class="custom-select-badge">${g.memberCount} members</span>
          </div>
        `;
  }).join('');

  const activeGroup = groups.find(g => g.groupId === activeGroupId);
  if (activeGroup) {
    const avatar = avatarMeta(activeGroup, activeGroup.name);
    const avatarNode = avatarId && document.getElementById(avatarId);
    if (avatarNode) {
      avatarNode.innerHTML = avatar.src
        ? `<img src="${esc(avatar.src)}" alt="${esc(avatar.name || 'avatar')}" onerror="const p=this.parentElement; this.remove(); if(p)p.textContent='${esc(avatar.initials)}'">`
        : esc(avatar.initials);
    }
    const nameNode = nameId && document.getElementById(nameId);
    if (nameNode) nameNode.innerHTML = `${esc(repairText(activeGroup.name))} ${getBotBadge(activeGroup.profile)}`;
    const badgeNode = badgeId && document.getElementById(badgeId);
    if (badgeNode) badgeNode.textContent = `${activeGroup.memberCount} members`;
  }

  dropdown.querySelectorAll('[data-select-group-id]').forEach(pill => {
    pill.addEventListener('click', event => {
      event.stopPropagation();
      const gid = event.currentTarget.dataset.selectGroupId;
      activeGroupId = gid;
      if (containerId) document.getElementById(containerId)?.classList.remove('open');
      if (onSelect) onSelect(gid);
    });
  });
}

async function renderMembers() {
  const container = document.getElementById('membersTableWrapper') || document.querySelector('#members .mobile-stack');
  if (!container) return;

  const select = document.getElementById('membersGroupSelect');
  if (select && state) {
    let groups = state.groups || [];
    if (selectedMemberBotFilter !== 'all') {
      groups = groups.filter(g => profileList(g.profile).includes(selectedMemberBotFilter));
    }

    if (groups.length > 0 && !groups.some(g => g.groupId === activeGroupId)) {
      activeGroupId = groups[0].groupId;
    }

    const optionCount = select.options.length;
    if (optionCount !== groups.length) {
      select.innerHTML = groups.map(g => `
            <option value="${esc(g.groupId)}" ${activeGroupId === g.groupId ? 'selected' : ''}>
              ${esc(repairText(g.name))} (${g.memberCount} members)
            </option>
          `).join('');
    } else {
      select.value = activeGroupId;
    }

    // Custom Dropdown Populating (dùng helper chung)
    populateGroupDropdown({
      groups,
      dropdownId: 'membersGroupSelectDropdown',
      avatarId: 'selectedGroupAvatar',
      nameId: 'selectedGroupName',
      badgeId: 'selectedGroupBadge',
      containerId: 'membersGroupSelectContainer',
      onSelect: gid => {
        select.value = gid;
        currentMembersPage = 1;
        renderMembers();
      },
    });
  }

  if (!activeGroupId) {
    container.innerHTML = `<div style="padding:40px; text-align:center; color:var(--muted);">${t('Chưa có nhóm nào.', 'No groups found.')}</div>`;
    return;
  }

  const group = state && state.groups ? state.groups.find(g => g.groupId === activeGroupId) : null;
  const creatorId = group ? String(group.creatorId || '').replace(/_0$/, '') : '';
  const adminIds = group && Array.isArray(group.admins) ? group.admins.map(id => String(id).replace(/_0$/, '')) : [];
  let botUserId = state && state.bot && state.bot.botUserId ? String(state.bot.botUserId).replace(/_0$/, '') : '';

  const botNameRaw = state && state.bot && state.bot.name ? String(state.bot.name).trim().toLowerCase() : '';
  if (botNameRaw) {
    const groupMembersMap = (state && state.members && state.members[activeGroupId]) || {};
    for (const [uid, name] of Object.entries(groupMembersMap)) {
      const cleanUName = String(name).trim().toLowerCase();
      if (cleanUName && (cleanUName === botNameRaw || cleanUName.includes(botNameRaw) || botNameRaw.includes(cleanUName))) {
        botUserId = String(uid).replace(/_0$/, '');
        break;
      }
    }
  }
  const botCanKick = botUserId && (botUserId === creatorId || adminIds.includes(botUserId));

  let membersList = [];

  if (currentMemberFilter === 'pending') {
    if (fetchedPendingMembers[activeGroupId] === undefined) {
      container.innerHTML = `<div style="padding:40px; text-align:center; color:var(--muted);">${t('Đang tải danh sách chờ...', 'Loading pending list...')}</div>`;
      try {
        const res = await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'get-pending', payload: { groupId: activeGroupId } }) });
        if (res.ok && res.result) {
          fetchedPendingMembers[activeGroupId] = pendingMembersFromDetail(res.result);
        } else {
          fetchedPendingMembers[activeGroupId] = [];
        }
      } catch (e) {
        fetchedPendingMembers[activeGroupId] = [];
      }
    }
    membersList = fetchedPendingMembers[activeGroupId].map(m => ({
      userId: String(m.id).replace(/_0$/, ''),
      name: m.name,
      role: 'Pending'
    }));
  } else if (currentMemberFilter === 'blocked') {
    if (fetchedBlockedMembers[activeGroupId] === undefined) {
      container.innerHTML = `<div style="padding:40px; text-align:center; color:var(--muted);">${t('Đang tải danh sách chặn...', 'Loading blocked list...')}</div>`;
      try {
        const res = await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'get-blocked', payload: { groupId: activeGroupId } }) });
        let blockedList = [];
        if (res.ok && res.result) {
          const rawList = Array.isArray(res.result?.list || res.result) ? (res.result?.list || res.result) : [];
          blockedList = rawList.map(item => ({
            id: String(item?.userId || item?.uid || item?.id || item || '').replace(/_0$/, ''),
            name: repairText(item?.name || item?.displayName || item?.userName || item?.id || item || ''),
          })).filter(item => item.id);
        }
        fetchedBlockedMembers[activeGroupId] = blockedList;
      } catch (e) {
        fetchedBlockedMembers[activeGroupId] = [];
      }
    }
    membersList = fetchedBlockedMembers[activeGroupId].map(m => ({
      userId: String(m.id).replace(/_0$/, ''),
      name: m.name,
      role: 'Blocked'
    }));
  } else {
    const membersMap = (state && state.members && state.members[activeGroupId]) || {};

    Object.entries(membersMap).forEach(([userId, name]) => {
      const cleanUserId = String(userId).replace(/_0$/, '');
      const isCreator = cleanUserId === creatorId;
      const isAdmin = adminIds.includes(cleanUserId);
      const role = isCreator ? 'Owner' : isAdmin ? 'Admin' : 'Member';

      if (currentMemberFilter === 'admins' && !isCreator && !isAdmin) {
        return;
      }
      membersList.push({ userId: cleanUserId, name, role });
    });
  }

  let html = '';
  const missingProfileIds = [];
  if (!window.attemptedProfileIds) {
    try {
      const storedAttempts = localStorage.getItem('zalo_attempted_profiles');
      window.attemptedProfileIds = storedAttempts ? new Set(JSON.parse(storedAttempts)) : new Set();
    } catch (e) {
      window.attemptedProfileIds = new Set();
    }
  }

  // 1. Gather missing profiles across all members first
  membersList.forEach(m => {
    const profile = cachedFriends ? cachedFriends.find(f => String(f.userId) === String(m.userId)) : null;
    if (!profile && !window.attemptedProfileIds.has(String(m.userId))) {
      missingProfileIds.push(String(m.userId));
    }
  });

  // 2. Perform client-side search query filtering
  const searchQuery = (document.getElementById('search')?.value || '').trim().toLowerCase();
  let filteredMembersList = membersList;
  if (searchQuery) {
    filteredMembersList = membersList.filter(m => {
      const profile = cachedFriends ? cachedFriends.find(f => String(f.userId) === String(m.userId)) : null;
      const name = (profile?.displayName || m.name || '').toLowerCase();
      const userId = String(m.userId).toLowerCase();
      const phone = (profile?.phoneNumber || '').toLowerCase();
      const bday = (profile?.sdob || '').toLowerCase();
      return name.includes(searchQuery) || userId.includes(searchQuery) || phone.includes(searchQuery) || bday.includes(searchQuery);
    });
  }

  // Hide/show configure columns button based on active filters and list empty state
  const btnConfigureColumnsBtn = document.getElementById('btnConfigureColumns');
  if (btnConfigureColumnsBtn) {
    if (currentMemberFilter === 'pending' || currentMemberFilter === 'blocked' || !activeGroupId || filteredMembersList.length === 0) {
      btnConfigureColumnsBtn.style.display = 'none';
    } else {
      btnConfigureColumnsBtn.style.display = 'inline-flex';
    }
  }

  // 3. Paginate the filtered list
  const totalPages = Math.max(1, Math.ceil(filteredMembersList.length / membersPerPage));
  if (currentMembersPage > totalPages) {
    currentMembersPage = totalPages;
  }
  const startIndex = (currentMembersPage - 1) * membersPerPage;
  const pageMembers = filteredMembersList.slice(startIndex, startIndex + membersPerPage);

  // 4. Render the table representation
  if (filteredMembersList.length === 0) {
    html = `<div style="padding:40px; text-align:center; color:var(--muted);">${t('Không có thành viên nào phù hợp bộ lọc.', 'No members match the filter.')}</div>`;
  } else {
    html = `
          <div class="table-responsive" style="overflow-x: auto; background: var(--surface); border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,0.02);">
            <table class="premium-table" style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
              <thead>
                <tr style="background: var(--surface-2); border-bottom: 1px solid var(--border); height: 44px; color: var(--text-muted); font-weight: 600;">
                  <th style="padding: 10px 16px; width: 40px; vertical-align: middle; text-align: center;">
                    <input type="checkbox" id="selectAllMembersCheckbox" style="cursor: pointer; width: 15px; height: 15px; vertical-align: middle;">
                  </th>
                  ${membersTableColumns.avatar ? `<th style="padding: 10px 16px; width: 60px; text-align: center;">${t('Avatar', 'Avatar')}</th>` : ''}
                  ${membersTableColumns.name ? `<th style="padding: 10px 16px; text-align: left;">${t('Họ Tên / ID', 'Name / ID')}</th>` : ''}
                  ${membersTableColumns.birth ? `<th style="padding: 10px 16px; width: 120px; text-align: center;">${t('Ngày Sinh', 'Birthday')}</th>` : ''}
                  ${membersTableColumns.phone ? `<th style="padding: 10px 16px; width: 140px; text-align: center;">${t('Số Điện Thoại', 'Phone Number')}</th>` : ''}
                  ${membersTableColumns.actions ? `<th style="padding: 10px 16px; text-align: center; width: 320px; white-space: nowrap;">${t('Thao Tác', 'Actions')}</th>` : ''}
                </tr>
              </thead>
              <tbody style="divide-y: 1px solid var(--border);">
        `;

    pageMembers.forEach(m => {
      const profile = cachedFriends ? cachedFriends.find(f => String(f.userId) === String(m.userId)) : null;
      const avatarData = {
        avatar: profile && profile.avatar ? profile.avatar : '',
        name: profile && profile.displayName ? profile.displayName : m.name
      };
      const avatar = avatarMeta(avatarData, avatarData.name || m.userId);
      const displayName = avatarData.name;
      const key = `${activeGroupId}:${m.userId}`;
      const isSelected = selectedMembers.has(key);

      let phone = profile && profile.phoneNumber ? profile.phoneNumber : '';
      if (phone) {
        phone = String(phone).trim().replace(/[^+0-9]/g, '');
        if (phone.startsWith('+84')) {
          phone = '0' + phone.substring(3);
        } else if (phone.startsWith('84')) {
          phone = '0' + phone.substring(2);
        }
      }
      const dob = profile && (profile.sdob || profile.dob || profile.dobText) ? (profile.sdob || profile.dob || profile.dobText) : '';

      let actionButtons = '';
      if (m.role === 'Pending') {
        actionButtons = `
              <button class="btn" type="button" data-approve-pending-user="${esc(m.userId)}" style="padding: 4px 8px; font-size: 12px; margin-right: 4px; display: inline-flex; align-items: center; gap: 4px;">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                ${t('Duyệt', 'Approve')}
              </button>
              <button class="btn danger" type="button" data-reject-pending-user="${esc(m.userId)}" style="padding: 4px 8px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                ${t('Từ chối', 'Reject')}
              </button>
            `;
      } else if (m.role === 'Blocked') {
        actionButtons = `
              <button class="btn" type="button" data-unblock-pending-user="${esc(m.userId)}" style="padding: 4px 8px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>
                ${t('Bỏ chặn', 'Unblock')}
              </button>
            `;
      } else {
        const isOwner = m.role === 'Owner';
        const isFriend = profile && (profile.isFr === 1 || profile.isFriend === 1);
        const isPendingOutgoing = profile && profile.isFr === 2;
        const isPendingIncoming = profile && profile.isFr === 3;

        // 1. Chat button is visible for everyone
        actionButtons += `
              <button class="btn" type="button" data-dm="${esc(m.userId)}:${esc(displayName)}" style="padding: 4px 8px; font-size: 12px; margin-right: 4px; display: inline-flex; align-items: center; gap: 4px;">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                ${t('Nhắn tin', 'Chat')}
              </button>
            `;

        // 2. Add or Accept friend action based on relationship state
        if (isFriend) {
          // Already friends
        } else if (isPendingIncoming) {
          actionButtons += `
                <button class="btn" type="button" data-accept-friend="${esc(m.userId)}" style="padding: 4px 8px; font-size: 12px; margin-right: 4px; background:var(--primary); color:white; display: inline-flex; align-items: center; gap: 4px;">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  ${t('Đồng ý', 'Accept')}
                </button>
              `;
        } else if (isPendingOutgoing) {
          actionButtons += `
                <button class="btn" type="button" disabled style="padding: 4px 8px; font-size: 12px; margin-right: 4px; opacity:0.6; display: inline-flex; align-items: center; gap: 4px;">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                  ${t('Đã gửi', 'Sent')}
                </button>
              `;
        } else {
          actionButtons += `
                <button class="btn" type="button" data-friend="${esc(m.userId)}:${esc(displayName)}" style="padding: 4px 8px; font-size: 12px; margin-right: 4px; display: inline-flex; align-items: center; gap: 4px;">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                  ${t('Kết bạn', 'Add')}
                </button>
              `;
        }

        // 3. Kick button shown if bot has admin/creator rights and target is not owner
        if (!isOwner && botCanKick) {
          actionButtons += `
                <button class="btn danger" type="button" data-kick-member="${esc(m.userId)}" data-kick-name="${esc(displayName)}" style="padding: 4px 8px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                  ${t('Kick', 'Kick')}
                </button>
              `;
        }
      }

      html += `
            <tr class="${isSelected ? 'selected' : ''}" style="border-bottom: 1px solid var(--border); height: 52px; background: ${isSelected ? 'var(--primary-light)' : 'transparent'};">
              <td class="col-checkbox" style="padding: 10px 16px; vertical-align: middle; text-align: center;">
                <input type="checkbox" data-member-select="${esc(key)}" ${isSelected ? 'checked' : ''} style="cursor: pointer; width: 15px; height: 15px; vertical-align: middle;">
              </td>
              ${membersTableColumns.avatar ? `
                <td class="col-avatar" style="padding: 10px 16px; vertical-align: middle; text-align: center;">
                  <div style="display: inline-flex; justify-content: center; align-items: center;">
                    ${avatar.src ? `
                      <div class="member-avatar" style="border-radius: 8px; width: 36px; height: 36px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--surface-2);">
                        <img src="${esc(avatar.src)}" alt="${esc(avatar.name || 'avatar')}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px;" onerror="const p=this.parentElement; this.remove(); if(p)p.textContent='${esc(avatar.initials)}'"/>
                      </div>
                    ` : `
                      <div class="member-avatar" style="border-radius: 8px; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, var(--primary) 0%, var(--primary-deep) 100%); color: white; font-weight: 700; text-transform: uppercase; text-shadow: 0 1px 2px rgba(0,0,0,0.15);">${esc(avatar.initials)}</div>
                    `}
                  </div>
                </td>
              ` : ''}
              ${membersTableColumns.name ? `
                <td class="col-name" style="padding: 10px 16px; vertical-align: middle; text-align: left;">
                  <strong style="color: var(--text); font-size: 13.5px; display: block;">${esc(repairText(displayName))}</strong>
                  <span style="font-family: monospace; font-size: 11px; color: var(--text-muted); display: block; margin-top: 2px;">ID: ${esc(m.userId)} · <span class="role-badge" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; background: ${m.role === 'Owner' ? 'rgba(235, 94, 40, 0.1)' : m.role === 'Admin' ? 'rgba(58, 125, 68, 0.1)' : 'rgba(0, 0, 0, 0.05)'}; color: ${m.role === 'Owner' ? '#eb5e28' : m.role === 'Admin' ? '#3a7d44' : 'var(--text-muted)'};">${m.role}</span></span>
                </td>
              ` : ''}
              ${membersTableColumns.birth ? `
                <td class="col-birth" data-label="${esc(t('Ngày Sinh', 'Birthday'))}" style="padding: 10px 16px; vertical-align: middle; text-align: center; color: var(--text); font-weight: 500;">
                  ${dob ? `🎂 ${esc(dob)}` : `<span style="color: var(--text-muted); font-size: 12px;">--</span>`}
                </td>
              ` : ''}
              ${membersTableColumns.phone ? `
                <td class="col-phone" data-label="${esc(t('Số Điện Thoại', 'Phone Number'))}" style="padding: 10px 16px; vertical-align: middle; text-align: center; color: var(--text); font-weight: 500;">
                  ${phone ? `📞 ${esc(phone)}` : `<span style="color: var(--text-muted); font-size: 12px;">--</span>`}
                </td>
              ` : ''}
              ${membersTableColumns.actions ? `
                <td class="col-actions" style="padding: 10px 16px; vertical-align: middle; text-align: center; white-space: nowrap; width: 320px;">
                  <div style="display: inline-flex; gap: 4px; align-items: center; justify-content: center; width: 100%;">
                    ${actionButtons}
                  </div>
                </td>
              ` : ''}
            </tr>
          `;
    });

    html += `
              </tbody>
            </table>
            
            <!-- Pagination Controls -->
            <div class="pagination-container" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-top: 1px solid var(--border); background: var(--surface-2); border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; flex-wrap: wrap; gap: 12px;">
              <div style="font-size: 13px; color: var(--text-muted);">
                ${t('Hiển thị', 'Showing')} <strong>${startIndex + 1}</strong> - <strong>${Math.min(startIndex + pageMembers.length, filteredMembersList.length)}</strong> ${t('trên', 'of')} <strong>${filteredMembersList.length}</strong> ${t('thành viên', 'members')}
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <button class="btn" type="button" id="btnPrevMembersPage" ${currentMembersPage === 1 ? 'disabled' : ''} style="padding: 6px 12px; font-size: 13px; min-height: auto; border-radius: 8px;">
                  ${t('Trước', 'Prev')}
                </button>
                <span style="font-size: 13px; font-weight: 600; color: var(--text); padding: 0 4px;">
                  ${currentMembersPage} / ${totalPages}
                </span>
                <button class="btn" type="button" id="btnNextMembersPage" ${currentMembersPage >= totalPages ? 'disabled' : ''} style="padding: 6px 12px; font-size: 13px; min-height: auto; border-radius: 8px;">
                  ${t('Sau', 'Next')}
                </button>
              </div>
            </div>
          </div>
        `;
  }

  container.innerHTML = html;

  // Fetching missing profiles is now handled gracefully on the backend via the persistent sync queue!
  // This completely prevents client-side Zalo API rate-limiting issues.

  // Bind pagination and checkbox event listeners
  const btnNext = document.getElementById('btnNextMembersPage');
  if (btnNext) {
    btnNext.addEventListener('click', () => {
      currentMembersPage++;
      renderMembers();
    });
  }

  const btnPrev = document.getElementById('btnPrevMembersPage');
  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      currentMembersPage--;
      renderMembers();
    });
  }

  const selectAllCheckbox = document.getElementById('selectAllMembersCheckbox');
  if (selectAllCheckbox) {
    const pageKeys = pageMembers.map(m => `${activeGroupId}:${m.userId}`);
    const allSelected = pageKeys.length > 0 && pageKeys.every(k => selectedMembers.has(k));
    selectAllCheckbox.checked = allSelected;

    selectAllCheckbox.addEventListener('change', event => {
      const checked = event.target.checked;
      pageKeys.forEach(k => {
        if (checked) {
          selectedMembers.add(k);
        } else {
          selectedMembers.delete(k);
        }
      });
      renderMembers();
      updateMemberBulkBar(membersList.length);
    });
  }

  // Bind checkboxes individually
  container.querySelectorAll('[data-member-select]').forEach(cb => {
    cb.addEventListener('change', event => {
      const key = event.target.dataset.memberSelect;
      if (event.target.checked) {
        selectedMembers.add(key);
      } else {
        selectedMembers.delete(key);
      }
      updateMemberBulkBar(membersList.length);
    });
  });

  // Bind configure columns settings button
  const btnConfigure = document.getElementById('btnConfigureColumns');
  if (btnConfigure) {
    btnConfigure.onclick = async () => {
      const ok = await openModal({
        title: t('Cài đặt hiển thị cột', 'Table Column Settings'),
        desc: t('Chọn các cột bạn muốn hiển thị trong danh sách thành viên.', 'Choose the columns you want to display in the member list.'),
        body: `
              <div class="column-toggles-list" style="display:flex; flex-direction:column; gap:16px; margin: 12px 0;">
                <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
                  <span style="font-weight:600; color:var(--text);">${t('Ảnh đại diện', 'Avatar')}</span>
                  <label class="premium-switch">
                    <input type="checkbox" id="colToggleAvatar" ${membersTableColumns.avatar ? 'checked' : ''}>
                    <span class="premium-switch-slider"></span>
                  </label>
                </div>
                <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
                  <span style="font-weight:600; color:var(--text);">${t('Tên & ID thành viên', 'Name & ID')}</span>
                  <label class="premium-switch">
                    <input type="checkbox" id="colToggleName" ${membersTableColumns.name ? 'checked' : ''}>
                    <span class="premium-switch-slider"></span>
                  </label>
                </div>
                <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
                  <span style="font-weight:600; color:var(--text);">${t('Ngày sinh', 'Birthday')}</span>
                  <label class="premium-switch">
                    <input type="checkbox" id="colToggleBirth" ${membersTableColumns.birth ? 'checked' : ''}>
                    <span class="premium-switch-slider"></span>
                  </label>
                </div>
                <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
                  <span style="font-weight:600; color:var(--text);">${t('Số điện thoại', 'Phone Number')}</span>
                  <label class="premium-switch">
                    <input type="checkbox" id="colTogglePhone" ${membersTableColumns.phone ? 'checked' : ''}>
                    <span class="premium-switch-slider"></span>
                  </label>
                </div>
                <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
                  <span style="font-weight:600; color:var(--text);">${t('Hành động / Thao tác', 'Actions')}</span>
                  <label class="premium-switch">
                    <input type="checkbox" id="colToggleActions" ${membersTableColumns.actions ? 'checked' : ''}>
                    <span class="premium-switch-slider"></span>
                  </label>
                </div>
              </div>
            `,
        confirmText: t('Lưu thiết lập', 'Save settings')
      });

      if (ok) {
        membersTableColumns.avatar = !!document.getElementById('colToggleAvatar')?.checked;
        membersTableColumns.name = !!document.getElementById('colToggleName')?.checked;
        membersTableColumns.birth = !!document.getElementById('colToggleBirth')?.checked;
        membersTableColumns.phone = !!document.getElementById('colTogglePhone')?.checked;
        membersTableColumns.actions = !!document.getElementById('colToggleActions')?.checked;

        localStorage.setItem('membersTableColumns', JSON.stringify(membersTableColumns));
        showToast(t('Đã cập nhật hiển thị cột', 'Column settings updated'), 'success');
        renderMembers();
      }
    };
  }

  // Bind Inline Action: Chat/Message member
  container.querySelectorAll('[data-action="chat-member"]').forEach(btn => {
    btn.addEventListener('click', event => {
      const userId = event.currentTarget.dataset.userId;
      const userName = event.currentTarget.dataset.userName;
      setSection('messages');
      if (typeof setComposerTargetType === 'function') {
        setComposerTargetType('custom');
      }
      const selectType = document.getElementById('customComposerTargetType');
      if (selectType) selectType.value = 'user';
      const inputId = document.getElementById('customComposerTargetId');
      if (inputId) inputId.value = userId;
      showToast(t(`Đã sẵn sàng nhắn tin cho ${userName}`, `Ready to message ${userName}`), 'info');
    });
  });

  // Bind other action buttons
  container.querySelectorAll('[data-kick-member]').forEach(btn => {
    btn.addEventListener('click', async event => {
      const el = event.currentTarget;
      const userId = el.dataset.kickMember;
      const name = el.dataset.kickName || userId;
      // Modal xác nhận (thay cho confirm() của trình duyệt) — chú ý cao hơn, có tên rõ ràng.
      const ok = await openModal({
        title: uiText('Kick thành viên khỏi nhóm?', 'Kick member from group?'),
        tone: 'warning',
        body: `<div class="modal-warn-body">
          <p class="modal-warn-lead">${uiText('Sẽ xoá', 'Will remove')} <b>${esc(name)}</b> ${uiText('khỏi nhóm này. Thao tác xoá này không hoàn tác được.', 'from this group. This cannot be undone.')}</p>
          <p class="modal-warn-note">${uiText('Cần tài khoản bot là Phó/Trưởng nhóm mới kick được.', 'The bot account must be a Deputy/Leader to kick.')}</p>
        </div>`,
        confirmText: uiText('Kick', 'Kick'),
        danger: true,
      });
      if (!ok) return;
      try {
        // payload PHẢI lồng trong "payload" (endpoint đọc body.payload) — trước đây gửi phẳng nên kick không chạy.
        await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'remove-user', payload: { groupId: activeGroupId, userId } }) });
        showToast(t('Đã gửi yêu cầu kick', 'Kick request sent'), 'success');
        if (state.members[activeGroupId]) delete state.members[activeGroupId][userId];
        renderMembers();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  });

  container.querySelectorAll('[data-approve-pending-user]').forEach(btn => {
    btn.addEventListener('click', async event => {
      const userId = event.target.dataset.approvePendingUser;
      try {
        await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'review-pending', payload: { groupId: activeGroupId, userId, approve: true } }) });
        showToast(t('Đã duyệt thành viên', 'Member approved'), 'success');
        if (fetchedPendingMembers[activeGroupId]) {
          fetchedPendingMembers[activeGroupId] = fetchedPendingMembers[activeGroupId].filter(m => m.id !== userId);
        }
        renderMembers();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  });

  container.querySelectorAll('[data-reject-pending-user]').forEach(btn => {
    btn.addEventListener('click', async event => {
      const userId = event.target.dataset.rejectPendingUser;
      try {
        await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'review-pending', payload: { groupId: activeGroupId, userId, approve: false } }) });
        showToast(t('Đã từ chối thành viên', 'Member rejected'), 'success');
        if (fetchedPendingMembers[activeGroupId]) {
          fetchedPendingMembers[activeGroupId] = fetchedPendingMembers[activeGroupId].filter(m => m.id !== userId);
        }
        renderMembers();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  });

  container.querySelectorAll('[data-unblock-pending-user]').forEach(btn => {
    btn.addEventListener('click', async event => {
      const userId = event.target.dataset.unblockPendingUser;
      try {
        await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'unblock-member', payload: { groupId: activeGroupId, userId } }) });
        showToast(t('Đã bỏ chặn thành viên', 'Member unblocked'), 'success');
        if (fetchedBlockedMembers[activeGroupId]) {
          fetchedBlockedMembers[activeGroupId] = fetchedBlockedMembers[activeGroupId].filter(m => m.id !== userId);
        }
        renderMembers();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  });
  updateMemberBulkBar(membersList.length);
}
function updateMemberBulkBar(totalVisible = 0) {
  const node = document.getElementById('memberBulkCount');
  if (!node) return;
  node.textContent = `${selectedMembers.size} member selected`;
  const selectAll = document.querySelector('[data-select-all-members]');
  if (selectAll) selectAll.textContent = selectedMembers.size && selectedMembers.size === totalVisible ? 'Clear all' : 'Select all';
}
function loadCachedFriendsFromStorage() {
  try {
    const stored = localStorage.getItem('zalo_cached_profiles');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        if (!cachedFriends) cachedFriends = [];
        parsed.forEach(p => {
          const existingIdx = cachedFriends.findIndex(f => String(f.userId) === String(p.userId));
          if (existingIdx !== -1) {
            cachedFriends[existingIdx] = { ...cachedFriends[existingIdx], ...p };
          } else {
            cachedFriends.push(p);
          }
        });
      }
    }
  } catch (e) {
    console.error('Failed to load profiles cache:', e);
  }
}

function saveCachedFriendsToStorage() {
  try {
    if (!cachedFriends) return;
    const optimized = cachedFriends.map(f => ({
      userId: String(f.userId || f.id || '').replace(/_0$/, ''),
      displayName: f.displayName || f.name || '',
      avatar: f.avatar || f.avatarUrl || '',
      sdob: f.sdob || '',
      phoneNumber: f.phoneNumber || f.phone || ''
    })).filter(f => f.userId);
    localStorage.setItem('zalo_cached_profiles', JSON.stringify(optimized));
  } catch (e) {
    console.error('Failed to save profiles cache:', e);
  }
}

function mergeProfilesAndSave(newProfiles) {
  if (!Array.isArray(newProfiles)) return;
  if (!cachedFriends) cachedFriends = [];
  let changed = false;

  newProfiles.forEach(rawP => {
    const id = String(rawP.userId || rawP.id || rawP.uid || '').replace(/_0$/, '');
    if (!id) return;

    const name = rawP.displayName || rawP.name || rawP.zaloName || '';
    const avatar = rawP.avatar || rawP.avatarUrl || rawP.avatar_url || '';
    const sdob = rawP.sdob || '';
    let phoneNumber = rawP.phoneNumber || rawP.phone || '';
    if (phoneNumber) {
      phoneNumber = String(phoneNumber).trim().replace(/[^+0-9]/g, '');
      if (phoneNumber.startsWith('+84')) {
        phoneNumber = '0' + phoneNumber.substring(3);
      } else if (phoneNumber.startsWith('84')) {
        phoneNumber = '0' + phoneNumber.substring(2);
      }
    }

    const existingIdx = cachedFriends.findIndex(f => String(f.userId) === id);
    if (existingIdx !== -1) {
      const ext = cachedFriends[existingIdx];
      if (ext.displayName !== name || ext.avatar !== avatar || ext.sdob !== sdob || ext.phoneNumber !== phoneNumber) {
        cachedFriends[existingIdx] = {
          ...ext,
          userId: id,
          displayName: name,
          avatar: avatar,
          sdob: sdob,
          phoneNumber: phoneNumber
        };
        changed = true;
      }
    } else {
      cachedFriends.push({
        userId: id,
        displayName: name,
        avatar: avatar,
        sdob: sdob,
        phoneNumber: phoneNumber
      });
      changed = true;
    }
  });

  if (changed) {
    saveCachedFriendsToStorage();
  }
}

let composerTargetType = 'group';
let cachedFriends = [];
loadCachedFriendsFromStorage();
let composerSelectedTargets = new Set();
let currentFilter = '';

function toggleComposerMultiselect(event) {
  event.stopPropagation();
  const multiselect = document.getElementById('composerMultiselect');
  if (!multiselect) return;
  const isOpen = multiselect.classList.contains('open');

  document.querySelectorAll('.custom-multiselect').forEach(el => el.classList.remove('open'));
  if (!isOpen) {
    multiselect.classList.add('open');
    const searchInput = multiselect.querySelector('.multiselect-search-input');
    if (searchInput) {
      searchInput.value = '';
      filterComposerMultiselect('');
      searchInput.focus();
    }
  }
}

document.addEventListener('click', () => {
  document.querySelectorAll('.custom-multiselect').forEach(el => el.classList.remove('open'));
});

function filterComposerMultiselect(query) {
  currentFilter = query.toLowerCase().trim();
  const optionsContainer = document.getElementById('multiselectOptions');
  if (!optionsContainer) return;

  const options = optionsContainer.querySelectorAll('.multiselect-option');
  options.forEach(opt => {
    const text = opt.textContent.toLowerCase();
    if (text.includes(currentFilter)) {
      opt.style.display = 'flex';
    } else {
      opt.style.display = 'none';
    }
  });
}

function toggleOption(value) {
  const isPro = !!(state?.license?.isPro);

  if (value === 'all-groups' || value === 'all-users') {
    if (!isPro) {
      const chk = document.getElementById(`chk-${value}`);
      if (chk) chk.checked = false;
      return showToast(t('Chức năng này chỉ dành cho tài khoản PRO. Vui lòng nâng cấp!', 'This feature is only for PRO accounts. Please upgrade!'), 'warning');
    }

    const chk = document.getElementById(`chk-${value}`);
    if (chk) {
      if (composerSelectedTargets.has(value)) {
        composerSelectedTargets.delete(value);
        chk.checked = false;
      } else {
        composerSelectedTargets.clear();
        composerSelectedTargets.add(value);
        chk.checked = true;

        document.querySelectorAll('#multiselectOptions input[type="checkbox"]').forEach(c => {
          if (c.id !== `chk-${value}`) c.checked = false;
        });
      }
    }
    updateMultiselectDisplay();
    return;
  }

  const chk = document.getElementById(`chk-${value}`);
  if (chk) {
    if (composerSelectedTargets.has(value)) {
      composerSelectedTargets.delete(value);
      chk.checked = false;
    } else {
      const currentCount = Array.from(composerSelectedTargets).filter(v => v !== 'all-groups' && v !== 'all-users').length;
      if (currentCount >= 1 && !isPro) {
        chk.checked = false;
        return showToast(t('Gửi hàng loạt chỉ dành cho tài khoản PRO. Vui lòng nâng cấp!', 'Bulk sending is only for PRO accounts. Please upgrade!'), 'warning');
      }

      composerSelectedTargets.delete('all-groups');
      composerSelectedTargets.delete('all-users');
      const allChk = document.getElementById('chk-all-groups') || document.getElementById('chk-all-users');
      if (allChk) allChk.checked = false;

      composerSelectedTargets.add(value);
      chk.checked = true;
    }
  }
  updateMultiselectDisplay();
}

function updateMultiselectDisplay() {
  const valuesContainer = document.getElementById('multiselectValues');
  if (!valuesContainer) return;

  if (composerSelectedTargets.size === 0) {
    valuesContainer.innerHTML = `<span class="placeholder">${t('Chọn target...', 'Select target...')}</span>`;
    return;
  }

  valuesContainer.innerHTML = Array.from(composerSelectedTargets).map(val => {
    let label = val;
    if (val === 'all-groups') label = t('TẤT CẢ CÁC NHÓM', 'ALL GROUPS');
    else if (val === 'all-users') label = t('TẤT CẢ BẠN BÈ', 'ALL FRIENDS');
    else {
      const [type, id] = val.split(':');
      if (type === 'group') {
        const group = state.groups.find(g => g.groupId === id);
        if (group) label = repairText(group.name);
      } else if (type === 'user' && cachedFriends) {
        const friend = cachedFriends.find(f => (f.userId || f.id || f.uid) === id);
        if (friend) label = repairText(friend.name || friend.displayName || '');
      }
    }

    return `
          <span class="multiselect-pill">
            <span>${esc(label)}</span>
            <span class="remove" onclick="event.stopPropagation(); removeTargetPill('${esc(val)}')">&times;</span>
          </span>
        `;
  }).join('');
}

function removeTargetPill(value) {
  composerSelectedTargets.delete(value);
  const chk = document.getElementById(`chk-${value}`);
  if (chk) chk.checked = false;
  updateMultiselectDisplay();
}

async function setComposerTargetType(type) {
  composerTargetType = type;

  const tabGroup = document.getElementById('targetTabGroup');
  const tabUser = document.getElementById('targetTabUser');
  const tabCustom = document.getElementById('targetTabCustom');
  if (tabGroup) tabGroup.className = `btn ${type === 'group' ? 'primary' : ''}`;
  if (tabUser) tabUser.className = `btn ${type === 'user' ? 'primary' : ''}`;
  if (tabCustom) tabCustom.className = `btn ${type === 'custom' ? 'primary' : ''}`;

  const label = document.getElementById('composerTargetLabel');
  if (label) {
    if (type === 'group') label.textContent = t('Target Group', 'Target Group');
    else if (type === 'user') label.textContent = t('Target User / Bạn bè', 'Target User / Friends');
    else if (type === 'custom') label.textContent = t('ID tùy chỉnh', 'Custom ID');
  }

  const container = document.getElementById('composerTargetContainer');
  if (!container) return;

  composerSelectedTargets.clear();
  updateMultiselectDisplay();

  if (type === 'group') {
    container.innerHTML = `
          <label><span id="composerTargetLabel">${t('Target Group', 'Target Group')}</span>
            <div class="custom-multiselect" id="composerMultiselect">
              <div class="multiselect-select" onclick="toggleComposerMultiselect(event)">
                <div class="multiselect-values" id="multiselectValues">
                  <span class="placeholder">${t('Chọn target group...', 'Select target group...')}</span>
                </div>
                <span class="multiselect-arrow">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;"><path d="m6 9 6 6 6-6"/></svg>
                </span>
              </div>
              <div class="multiselect-dropdown" onclick="event.stopPropagation()">
                <div class="multiselect-search-container">
                  <input type="text" placeholder="${t('Tìm kiếm...', 'Search...')}..." oninput="filterComposerMultiselect(this.value)" class="multiselect-search-input" />
                </div>
                <div class="multiselect-options" id="multiselectOptions">
                  <div class="multiselect-option" onclick="toggleOption('all-groups')">
                    <input type="checkbox" id="chk-all-groups" onchange="event.stopPropagation(); toggleOption('all-groups')" />
                    <span style="font-weight: 600; color: var(--primary);">${t('TẤT CẢ CÁC NHÓM (Yêu cầu PRO)', 'ALL GROUPS (PRO Required)')}</span>
                  </div>
                  ${state.groups.map(group => `
                    <div class="multiselect-option" onclick="toggleOption('group:${esc(group.groupId)}')">
                      <input type="checkbox" id="chk-group:${esc(group.groupId)}" onchange="event.stopPropagation(); toggleOption('group:${esc(group.groupId)}')" />
                      <span>${esc(repairText(group.name))}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
          </label>
        `;
    updateMultiselectDisplay();
  } else if (type === 'user') {
    if (!cachedFriends) {
      container.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <span style="font-size: 13px; color: var(--muted);">${t('Cần tải danh sách bạn bè để chọn.', 'Need to load friend list first.')}</span>
              <button type="button" class="btn" onclick="loadComposerFriends()" style="align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;">
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                ${t('Tải danh sách bạn bè', 'Load Friends')}
              </button>
            </div>
          `;
    } else {
      renderComposerFriendsDropdown();
    }
  } else if (type === 'custom') {
    container.innerHTML = `
          <div style="display: flex; gap: 8px; align-items: flex-end;">
            <label style="flex: 1; margin: 0;"><span>${t('Target Type', 'Target Type')}</span>
              <select id="composerCustomType">
                <option value="group">Group ID</option>
                <option value="user">User ID</option>
              </select>
            </label>
            <label style="flex: 2; margin: 0;"><span>${t('Nhập ID (Ngăn cách bởi dấu phẩy)', 'Enter ID (comma separated)')}</span>
              <input id="composerCustomId" type="text" placeholder="${t('Nhập một hoặc nhiều ID, ví dụ: 460149..., 12345...', 'Enter one or more IDs, e.g. 460149..., 12345...')}" style="width: 100%; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text);" />
            </label>
          </div>
        `;
  }
}

async function loadComposerFriends() {
  const container = document.getElementById('composerTargetContainer');
  if (container) {
    container.innerHTML = `<span style="font-size: 13px; color: var(--muted);">${t('Đang tải danh sách bạn bè...', 'Loading friends list...')}</span>`;
  }
  try {
    const result = await runAction('get-friends', {}, t('Đã tải danh sách bạn bè', 'Friend list loaded'));
    let friendsArray = [];
    if (Array.isArray(result)) {
      friendsArray = result;
    } else if (result && Array.isArray(result.friends)) {
      friendsArray = result.friends;
    } else if (result && typeof result === 'object') {
      friendsArray = Object.values(result).find(val => Array.isArray(val)) || [];
    }
    mergeProfilesAndSave(friendsArray);
    renderComposerFriendsDropdown();
  } catch (error) {
    showToast(`${t('Tải bạn bè lỗi', 'Load friends failed')} - ${error.message}`, 'error');
    setComposerTargetType('user');
  }
}

function renderComposerFriendsDropdown() {
  const container = document.getElementById('composerTargetContainer');
  if (!container || !cachedFriends) return;
  if (cachedFriends.length === 0) {
    container.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <span style="font-size: 13px; color: var(--muted);">${t('Không tìm thấy bạn bè nào.', 'No friends found.')}</span>
            <button type="button" class="btn" onclick="loadComposerFriends()">${t('Tải lại', 'Reload')}</button>
          </div>
        `;
    return;
  }

  container.innerHTML = `
        <label><span id="composerTargetLabel">${t('Chọn bạn bè', 'Select Friend')}</span>
          <div class="custom-multiselect" id="composerMultiselect">
            <div class="multiselect-select" onclick="toggleComposerMultiselect(event)">
              <div class="multiselect-values" id="multiselectValues">
                <span class="placeholder">${t('Chọn bạn bè...', 'Select friends...')}</span>
              </div>
              <span class="multiselect-arrow">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;"><path d="m6 9 6 6 6-6"/></svg>
              </span>
            </div>
            <div class="multiselect-dropdown" onclick="event.stopPropagation()">
              <div class="multiselect-search-container">
                <input type="text" placeholder="${t('Tìm kiếm...', 'Search...')}..." oninput="filterComposerMultiselect(this.value)" class="multiselect-search-input" />
              </div>
              <div class="multiselect-options" id="multiselectOptions">
                <div class="multiselect-option" onclick="toggleOption('all-users')">
                  <input type="checkbox" id="chk-all-users" onchange="event.stopPropagation(); toggleOption('all-users')" />
                  <span style="font-weight: 600; color: var(--primary);">${t('TẤT CẢ BẠN BÈ (Yêu cầu PRO)', 'ALL FRIENDS (PRO Required)')}</span>
                </div>
                ${cachedFriends.map(friend => {
    const name = friend.name || friend.displayName || friend.nickName || t('Không tên', 'Unnamed');
    const id = friend.userId || friend.id || friend.uid || '';
    return `
                    <div class="multiselect-option" onclick="toggleOption('user:${esc(id)}')">
                      <input type="checkbox" id="chk-user:${esc(id)}" onchange="event.stopPropagation(); toggleOption('user:${esc(id)}')" />
                      <span>${esc(repairText(name))} (${esc(id)})</span>
                    </div>
                  `;
  }).join('')}
              </div>
            </div>
          </div>
        </label>
      `;
  updateMultiselectDisplay();
}

function previewComposerMessage() {
  const form = document.querySelector('#messages form');
  const text = form?.querySelector('textarea')?.value || '';
  if (!text.trim()) return showToast(t('Vui lòng nhập tin nhắn để xem preview.', 'Please enter message to preview.'), 'warning');
  openModal({
    title: t('Xem trước tin nhắn', 'Message Preview'),
    body: `
          <div style="background: var(--surface-2); padding: 12px; border-radius: var(--radius); font-size: 13px; font-family: sans-serif; max-height: 240px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;">${esc(text)}</div>
        `,
    confirmText: t('Đóng', 'Close'),
  });
}

function renderComposerTargets() {
  setComposerTargetType(composerTargetType);
}
function renderAudit() {
  const list = document.querySelector('#overview .layout .card:nth-child(2) .list');
  if (!list) return;
  list.innerHTML = (state.audit || []).slice(0, 8).map(item => `
        <div class="item">
          <div><div class="item-title">${esc(item.action)}${item.target ? ` <span style="opacity:.7;font-weight:500">→ ${esc(item.target)}</span>` : ''}</div><div class="item-sub">${esc(item.ts || '')}${item.kind ? ` · ${esc(item.kind)}` : ''}</div></div>
          <span class="status ${item.ok === false ? 'danger' : 'on'}">${item.ok === false ? 'ERR' : 'OK'}</span>
        </div>
      `).join('') || `<div class="item"><div class="item-title">${t('Chưa có action', 'No actions yet')}</div><div class="item-sub">${t('Các action từ dashboard sẽ hiện tại đây.', 'Dashboard actions will appear here.')}</div></div>`;
}
function pendingMembersFromDetail(detail) {
  const raw = detail?.pending;
  if (!raw) return [];
  if (Array.isArray(detail?.pending?.list)) {
    return detail.pending.list.map(item => ({
      id: String(item?.id || item?.userId || item?.uid || ''),
      name: repairText(item?.name || item?.displayName || item?.userName || item?.zaloName || item?.id || ''),
    })).filter(item => item.id);
  }
  const direct = [raw.members, raw.pendingMembers, raw.data, raw.list, raw].find(Array.isArray);
  const list = direct || [];
  if (list.length) {
    return list.map(item => ({
      id: String(item?.userId || item?.uid || item?.id || item || ''),
      name: repairText(item?.name || item?.displayName || item?.userName || item?.uid || item || ''),
    })).filter(item => item.id);
  }
  const seen = new Set();
  const out = [];
  const stack = [raw];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }
    if (typeof cur !== 'object') continue;
    const id = cur.userId || cur.uid || cur.id;
    if (id != null) {
      const key = String(id);
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ id: key, name: repairText(cur.name || cur.displayName || cur.userName || key) });
      }
    }
    for (const value of Object.values(cur)) stack.push(value);
  }
  return out;
}
function buildLocalGroupDetail(groupId, pendingResult = null) {
  const group = state.groups.find(item =>
    item.groupId === groupId
    || (item.groupIdByProfile && Object.values(item.groupIdByProfile).includes(groupId))
    || (Array.isArray(item.siblingIds) && item.siblingIds.includes(groupId))) || {};
  return {
    ...group,
    settings: botSettings(group),          // selected bot's settings (per-bot)
    botGroupId: botGroupId(group),         // selected bot's per-account groupId for toggles
    admins: group.admins || [],
    pending: pendingResult,
  };
}
function refreshDetailModal() {
  if (!currentDetailGroupId || !modalBackdrop.classList.contains('open')) return;
  currentDetailPayload = buildLocalGroupDetail(currentDetailGroupId, currentDetailPayload?.pending || null);
  modalTitle.textContent = uiText('Chi tiết group', 'Group details');
  modalBody.innerHTML = groupDetailBody(currentDetailPayload);
  modalConfirm.textContent = uiText('Lưu', 'Save');
  modalConfirm.classList.remove('danger');
  modalConfirm.classList.add('primary');
}
// ── Nhật ký nhóm (Phase 3) ───────────────────────────────
let journalState = { groupId: null, date: null, data: null, tab: 'summary' };
async function journalApi(action, payload) {
  const data = await api('/api/action', { method: 'POST', body: JSON.stringify({ action, payload }) });
  return data.result;
}
async function loadJournal(groupId, date) {
  const data = await journalApi('journal-data', { groupId, date });
  journalState.groupId = groupId;
  journalState.date = data.date;
  journalState.data = data;
  return data;
}
async function openJournal(groupId) {
  journalState = { groupId, date: null, data: null, tab: 'summary' };
  try { await loadJournal(groupId, null); }
  catch (e) { showToast(uiText('Lỗi tải nhật ký', 'Journal load error') + ': ' + e.message, 'error'); return; }
  await openModal({ title: uiText('Nhật ký nhóm', 'Group journal'), body: journalBodyHtml(), confirmText: uiText('Đóng', 'Close') });
}
function journalRerender() {
  if (modalBackdrop.classList.contains('open')) { modalBody.innerHTML = journalBodyHtml(); return; }
  if (document.getElementById('journal')?.classList.contains('active')) renderJournalBody();
}
const JOURNAL_TAB_ICONS = {
  summary: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M4 19V5m0 14h16M8 16v-5m4 5V8m4 8v-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  notes: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  memories: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M9.5 3A3.5 3.5 0 0 0 6 6.5 3 3 0 0 0 4 12a3 3 0 0 0 2 5 3.5 3.5 0 0 0 6.5-1.8V4.8A2 2 0 0 0 9.5 3Zm5 0a3.5 3.5 0 0 1 3.5 3.5A3 3 0 0 1 20 12a3 3 0 0 1-2 5 3.5 3.5 0 0 1-6.5-1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H6l-4 2 1.4-4.2A8 8 0 1 1 21 12Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  config: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9.5A1.7 1.7 0 0 0 10.5 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
function journalTabs() {
  // 'chat' (chat thô) và 'config' (lịch báo cáo) đã bỏ khỏi thanh tab: lịch báo cáo có trang riêng
  // vì một lịch trải trên nhiều nhóm. journalContentHtml vẫn xử lý 2 khoá này để state cũ lưu trong
  // journalState không làm trắng panel.
  return [
    ['summary', uiText('Tóm tắt', 'Summary')],
    ['notes', 'Note'],
    ['memories', 'Memory'],
  ];
}
function journalContentHtml() {
  const js = journalState;
  const d = js.data;
  if (js.tab === 'summary') return journalSummaryHtml(d.summary);
  if (js.tab === 'notes') return journalListHtml(d.notes, uiText('Chưa có note', 'No notes'));
  if (js.tab === 'memories') return journalListHtml(d.memories, uiText('Chưa có memory', 'No memories'));
  if (js.tab === 'config') return journalConfigHtml(d);
  return journalChatHtml(d.chat, d.chatTotal);
}
function journalBodyHtml() {
  const js = journalState;
  if (!js.data) return `<div class="item-sub">${uiText('Đang tải...', 'Loading...')}</div>`;
  const d = js.data;
  const tabBar = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${journalTabs().map(([k, l]) => `<button type="button" class="feature-toggle ${js.tab === k ? 'on' : 'off'}" data-jtab="${k}">${JOURNAL_TAB_ICONS[k]} ${l}</button>`).join('')}</div>`;
  let dateBar = '';
  if (js.tab === 'summary' || js.tab === 'chat') {
    const dates = js.tab === 'summary' ? d.summaryDates : d.chatDates;
    const allDates = [...new Set([d.date, ...(dates || [])])];
    dateBar = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <span class="item-sub">${uiText('Ngày', 'Date')}:</span>
      ${allDates.slice(0, 14).map(dt => `<button type="button" data-jdate="${dt}" style="padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:${dt === d.date ? 'var(--primary)' : 'var(--surface-2)'};color:${dt === d.date ? '#fff' : 'var(--text)'};font-size:12px;cursor:pointer">${dt}</button>`).join('')}
      <button type="button" class="btn" data-jgen="${d.date}" style="margin-left:auto">↻ ${uiText('Tổng hợp lại', 'Re-summarize')}</button>
    </div>`;
  }
  return `<div>${tabBar}${dateBar}${journalContentHtml()}</div>`;
}
// ── Nhật ký nhóm — mục riêng (section #journal) ──────────────────────────
function localDateStr(offsetDays = 0) {
  const dt = new Date();
  dt.setDate(dt.getDate() + offsetDays);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
// Điều hướng từ modal chi tiết group -> section, preselect group.
async function openJournalSection(groupId) {
  if (groupId) activeGroupId = groupId;
  setSection('journal');
  await renderJournal();
}
// Chọn ngày -> tải lại nhật ký ngày đó (dùng cho tab ngày của section).
async function journalPickDate(date) {
  const gid = journalState.groupId || activeGroupId;
  if (!gid) return;
  try { await loadJournal(gid, date); renderJournalBody(); }
  catch (e) { showToast(uiText('Lỗi tải nhật ký', 'Journal load error') + ': ' + e.message, 'error'); }
}
function journalDateTabsHtml() {
  const today = localDateStr(0);
  const yesterday = localDateStr(-1);
  const cur = journalState.date || today;
  const isCustom = cur !== today && cur !== yesterday;
  const CAL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const chip = (date, label) => `<button type="button" class="journal-date-chip ${cur === date ? 'active' : ''}" data-jsection-date="${date}">${label}</button>`;
  return `<div class="journal-date-tabs">
    ${chip(today, uiText('Hôm nay', 'Today'))}
    ${chip(yesterday, uiText('Hôm qua', 'Yesterday'))}
    <label class="journal-date-picker ${isCustom ? 'active' : ''}">${CAL}<span>${uiText('Chọn ngày', 'Pick date')}</span>
      <input type="date" id="journalDateInput" value="${esc(cur)}" max="${today}">
    </label>
  </div>`;
}
// Dropdown chọn nhóm — render động trong card bên phải, wiring lại sau mỗi lần vẽ
function journalGroupSelectHtml() {
  return `<div class="custom-select-container" id="journalGroupSelectContainer">
    <div class="custom-select-trigger" id="journalGroupSelectTrigger">
      <div class="custom-select-trigger-content">
        <div class="custom-select-avatar" id="journalSelectedGroupAvatar">G</div>
        <span class="custom-select-name" id="journalSelectedGroupName">${uiText('Chọn nhóm...', 'Select group...')}</span>
        <span class="custom-select-badge" id="journalSelectedGroupBadge">0</span>
      </div>
      <svg class="custom-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </div>
    <div class="custom-select-dropdown" id="journalGroupSelectDropdown"></div>
  </div>`;
}
function wireJournalGroupSelect() {
  const trigger = document.getElementById('journalGroupSelectTrigger');
  const container = document.getElementById('journalGroupSelectContainer');
  if (trigger && container) {
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      container.classList.toggle('open');
    });
  }
  populateGroupDropdown({
    groups: (state && state.groups) || [],
    dropdownId: 'journalGroupSelectDropdown',
    avatarId: 'journalSelectedGroupAvatar',
    nameId: 'journalSelectedGroupName',
    badgeId: 'journalSelectedGroupBadge',
    containerId: 'journalGroupSelectContainer',
    onSelect: async gid => {
      journalState = { groupId: gid, date: null, data: null, tab: journalState.tab || 'summary' };
      renderJournalBody();
      try { await loadJournal(gid, null); } catch (e) { showToast(uiText('Lỗi tải nhật ký', 'Journal load error') + ': ' + e.message, 'error'); }
      renderJournalBody();
    },
  });
}
// Vẽ phần thân: menu tab dọc (trái) + card nội dung (phải, gồm chọn nhóm + tab ngày)
function renderJournalBody() {
  const body = document.getElementById('journalBody');
  if (!body) return;
  const js = journalState;
  const d = js.data;
  // Menu tab DỌC (cột trái)
  const tabMenu = journalTabs().map(([k, l]) => `<button type="button" class="journal-vtab ${js.tab === k ? 'active' : ''}" data-jtab="${k}">${JOURNAL_TAB_ICONS[k]}<span>${l}</span></button>`).join('');
  const showDates = !!(js.groupId && d && (js.tab === 'summary' || js.tab === 'chat'));
  // Hàng 1: dropdown chọn nhóm + Tổng hợp lại. Hàng 2: tab ngày.
  const groupRow = `<div class="journal-group-row">
    ${journalGroupSelectHtml()}
    ${showDates ? `<button type="button" class="btn" data-jgen="${d.date}" style="margin-left:auto">↻ ${uiText('Tổng hợp lại', 'Re-summarize')}</button>` : ''}
  </div>`;
  const dateRow = showDates ? `<div class="journal-daterow">${journalDateTabsHtml()}</div>` : '';
  let content;
  if (!js.groupId) content = `<div style="padding:40px;text-align:center;color:var(--muted)">${uiText('Chọn một nhóm để xem nhật ký.', 'Select a group to view its journal.')}</div>`;
  else if (!d) content = `<div style="padding:40px;text-align:center;color:var(--muted)">${uiText('Đang tải...', 'Loading...')}</div>`;
  else content = journalContentHtml();
  body.innerHTML = `<div class="journal-layout">
    <nav class="card journal-vtabs" aria-label="${uiText('Mục nhật ký', 'Journal tabs')}">${tabMenu}</nav>
    <div class="card journal-card"><div class="journal-toolbar">${groupRow}${dateRow}</div><div class="journal-content">${content}</div></div>
  </div>`;
  wireJournalGroupSelect();
}
async function renderJournal() {
  const section = document.getElementById('journal');
  if (!section) return;
  const groups = (state && state.groups) || [];
  // Đồng bộ activeGroupId với danh sách nhóm hiện có
  if (groups.length > 0 && !groups.some(g => g.groupId === activeGroupId)) {
    activeGroupId = groups[0].groupId;
  }
  if (!activeGroupId) { journalState = { groupId: null, date: null, data: null, tab: 'summary' }; renderJournalBody(); return; }
  // Nạp dữ liệu nếu group đổi hoặc chưa có. Đổi group thì reset ngày về mặc định.
  if (journalState.groupId !== activeGroupId || !journalState.data) {
    const keepDate = journalState.groupId === activeGroupId ? journalState.date : null;
    journalState = { groupId: activeGroupId, date: keepDate, data: null, tab: journalState.tab || 'summary' };
    renderJournalBody();
    try { await loadJournal(activeGroupId, keepDate); }
    catch (e) { showToast(uiText('Lỗi tải nhật ký', 'Journal load error') + ': ' + e.message, 'error'); }
  }
  renderJournalBody();
}
// ── Cài đặt — mục riêng (section #settings) ──────────────────────────────
const SETTINGS_ICONS = {
  lang: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  theme: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M12 8h.01M11 12h1v4h1m-1 5a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
};
function settingsToggle(id, checked, label, sub) {
  return `<label class="journal-toggle-row"><span class="journal-toggle-label">${label}${sub ? `<small class="settings-sub">${sub}</small>` : ''}</span><span class="journal-switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}/><span class="journal-slider"></span></span></label>`;
}
function settingsPlanInfo() {
  const lic = (state && state.license) || {};
  if (!lic.isPro) return { name: 'FREE', expiry: uiText('Vĩnh viễn', 'Forever'), isPro: false };
  let name = (lic.plan || 'PRO').toUpperCase();
  if (lic.isTrial) name = t('Dùng thử Pro', 'Pro Trial');
  else if (lic.plan === 'personal') name = t('Cá nhân Pro', 'Personal Pro');
  else if (lic.plan === 'team') name = t('Team Pro', 'Team Pro');
  else if (lic.plan === 'lifetime') name = 'Lifetime';
  return { name, expiry: lic.expiry || '', isPro: true };
}
function renderSettings() {
  const root = document.getElementById('settingsBody');
  if (!root) return;
  const dark = (document.documentElement.dataset.theme || 'light') === 'dark';
  const seg = (active, val, label) => `<button type="button" class="settings-seg-btn ${active ? 'active' : ''}" data-set-${val}>${label}</button>`;
  const deviceId = (state && state.license && state.license.deviceId) || '';
  const version = (state && state.pluginVersion) || pluginVersion;
  const reduceMotion = localStorage.getItem('zaloReduceMotion') === '1';
  const plan = settingsPlanInfo();
  const STAR = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
  root.innerHTML = `
    <div class="settings-grid">
      <div class="card settings-card">
        <div class="settings-card-head">${SETTINGS_ICONS.theme}<div><strong>${uiText('Tùy chỉnh', 'Preferences')}</strong><div class="item-sub">${uiText('Ngôn ngữ, giao diện và hiệu ứng', 'Language, appearance and effects')}</div></div></div>
        <div class="settings-field">
          <span class="settings-field-label">${uiText('Ngôn ngữ', 'Language')}</span>
          <div class="settings-segmented">${seg(lang === 'vi', 'lang-vi', 'Tiếng Việt')}${seg(lang === 'en', 'lang-en', 'English')}</div>
        </div>
        <div class="settings-field">
          <span class="settings-field-label">${uiText('Giao diện', 'Appearance')}</span>
          <div class="settings-segmented">${seg(!dark, 'theme-light', uiText('Sáng', 'Light'))}${seg(dark, 'theme-dark', uiText('Tối', 'Dark'))}</div>
        </div>
        <div class="settings-field">
          <span class="settings-field-label">${uiText('Múi giờ hiển thị', 'Display timezone')}</span>
          <select id="setTimezone" style="padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);font-size:13px">
            ${TZ_CHOICES.map(([v, l]) => `<option value="${esc(v)}" ${displayTz() === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <div class="item-sub" style="margin:-4px 0 10px;font-size:11.5px">${uiText(
          `Chỉ đổi cách HIỂN THỊ mốc thời gian (vd: Lịch sử báo cáo). Giờ chạy của lịch báo cáo luôn theo giờ Việt Nam. Hiện tại: ${fmtTs(new Date().toISOString())}`,
          `Only changes how timestamps are DISPLAYED (e.g. Report log). Schedules always run on Vietnam time. Now: ${fmtTs(new Date().toISOString())}`)}</div>
        ${settingsToggle('setReduceMotion', reduceMotion, uiText('Giảm chuyển động', 'Reduce motion'), uiText('Tắt hiệu ứng chuyển cảnh', 'Disable transition effects'))}
      </div>
      <div class="card settings-card">
        <div class="settings-card-head">${SETTINGS_ICONS.info}<div><strong>${uiText('Thông tin', 'Information')}</strong><div class="item-sub">${uiText('Gói bản quyền, thiết bị và phiên bản', 'License plan, device and version')}</div></div></div>
        <div class="settings-info-row">
          <span class="settings-info-label">${uiText('Gói bản quyền', 'Plan')}</span>
          <div class="settings-info-val">
            <span class="settings-plan-badge ${plan.isPro ? 'pro' : 'free'}">${plan.isPro ? STAR : ''}${esc(plan.name)}</span>
          </div>
        </div>
        ${plan.expiry ? `<div class="settings-info-row">
          <span class="settings-info-label">${uiText('Hạn dùng', 'Expiry')}</span>
          <div class="settings-info-val"><span class="settings-plan-expiry">${esc(plan.expiry)}</span></div>
        </div>` : ''}
        <div class="settings-info-row">
          <span class="settings-info-label">Device ID</span>
          <div class="settings-info-val">
            <code class="settings-code">${esc(deviceId || '----')}</code>
            ${deviceId ? `<button type="button" class="btn settings-copy-btn" data-copy-id="${esc(deviceId)}" title="${uiText('Copy Device ID', 'Copy Device ID')}">${SETTINGS_ICONS.copy}</button>` : ''}
          </div>
        </div>
        <div class="settings-info-row">
          <span class="settings-info-label">${uiText('Phiên bản plugin', 'Plugin version')}</span>
          <div class="settings-info-val"><code class="settings-code">v${esc(version)}</code></div>
        </div>
      </div>
    </div>`;
  if (!root.dataset.wired) { wireSettingsRoot(root); root.dataset.wired = '1'; }
}
function applyReduceMotion() {
  const on = localStorage.getItem('zaloReduceMotion') === '1';
  document.documentElement.toggleAttribute('data-reduce-motion', on);
}
function wireSettingsRoot(root) {
  root.addEventListener('click', e => {
    if (e.target.closest('[data-set-lang-vi]')) return setLang('vi');
    if (e.target.closest('[data-set-lang-en]')) return setLang('en');
    if (e.target.closest('[data-set-theme-light]')) return setTheme('light');
    if (e.target.closest('[data-set-theme-dark]')) return setTheme('dark');
  });
  root.addEventListener('change', e => {
    if (e.target.id === 'setTimezone') {
      localStorage.setItem('zaloDashboardTz', e.target.value);
      renderSettings();
      showToast(uiText('Đã đổi múi giờ hiển thị', 'Display timezone updated'), 'success');
      return;
    }
    if (e.target.id === 'setReduceMotion') {
      localStorage.setItem('zaloReduceMotion', e.target.checked ? '1' : '0');
      applyReduceMotion();
      showToast(e.target.checked ? uiText('Đã giảm chuyển động', 'Reduced motion on') : uiText('Đã bật lại chuyển động', 'Motion restored'), 'success');
    }
  });
}
function journalConfigHtml(d) {
  // CHỈ ĐỌC. Lịch báo cáo giờ là thực thể riêng ở mục Nhật ký → Lịch báo cáo, vì một lịch trải trên
  // NHIỀU nhóm — không thể diễn tả bằng 4 setting nằm trên từng nhóm. Giữ hai trình sửa song song sẽ
  // thành hai nguồn sự thật ghi vào hai mô hình khác nhau, nên ở đây chỉ hiển thị nhóm này đang thuộc
  // lịch nào, kèm đường sang trang sửa.
  const gid = String(journalState.groupId || activeGroupId || '');
  const jobs = (reportsState.jobs || []).filter(j => j.groups === '*' || (Array.isArray(j.groups) && j.groups.includes(gid)));
  const kindLabel = (j) => j.kind === 'digest' ? uiText('tổng hợp', 'digest') : uiText('từng nhóm', 'per group');
  const rows = jobs.length
    ? jobs.map(j => `<div class="journal-config-block" style="margin-bottom:8px">
        <div class="item-title">${esc(j.name)} ${j.enabled ? '' : `<span class="item-sub">(${uiText('đang tắt', 'disabled')})</span>`}</div>
        <div class="item-sub" style="line-height:1.7">
          ${kindLabel(j)} · ${j.time} · ${esc(reportDeliverSummary(j))}
          ${j.groups === '*' ? `<br>${uiText('Áp cho tất cả nhóm đang follow', 'Applies to all followed groups')}` : ''}
        </div></div>`).join('')
    : `<div class="item-sub">${uiText('Nhóm này chưa thuộc lịch báo cáo nào.', 'This group is not in any schedule yet.')}</div>`;
  return `<div class="journal-config">
    <div class="item-sub" style="margin-bottom:12px">${uiText('Lịch báo cáo được quản lý ở một chỗ duy nhất vì một lịch có thể áp cho nhiều nhóm.', 'Schedules live in one place because a single schedule can cover many groups.')}</div>
    ${rows}
    <button type="button" class="btn primary journal-save-btn" data-goto-reports="1">
      <span>${uiText('Mở Lịch báo cáo', 'Open Schedules')}</span></button>
  </div>`;
}
// Multi-select group dropdown for the report tab — reuses the .custom-select-* component
// styling (same as the journal group picker) instead of a second bespoke dropdown.
function journalSummaryHtml(s) {
  if (!s) return `<div class="item-sub">${uiText('Chưa có tóm tắt cho ngày này. Bấm "Tổng hợp lại".', 'No summary yet. Click re-summarize.')}</div>`;
  const x = s.sections || {};
  const sec = (title, inner) => inner ? `<div class="item" style="display:block"><div class="item-title">${title}</div><div style="margin-top:6px">${inner}</div></div>` : '';
  const list = arr => `<ul style="margin:0;padding-left:18px">${arr.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
  return `<div class="list" style="padding:0">
    <div class="item-sub" style="margin-bottom:8px">💬 ${s.messageCount} ${uiText('tin', 'msgs')} · AI ${s.aiOk ? '✓' : '✗'}</div>
    ${sec('📌 ' + uiText('Tổng quan', 'Overview'), x.overview ? esc(x.overview) : '')}
    ${sec('⭐ ' + uiText('Nổi bật', 'Highlights'), x.highlights?.length ? list(x.highlights) : '')}
    ${sec('🔁 ' + uiText('Lặp lại', 'Repeated'), x.repeatedTopics?.length ? list(x.repeatedTopics) : '')}
    ${sec('🗣️ ' + uiText('Người nói chính', 'Key speakers'), x.keySpeakers?.length ? x.keySpeakers.map(k => `<div>• <strong>${esc(k.name || '')}</strong>: ${esc(k.gist || '')}</div>`).join('') : '')}
    ${sec('📅 ' + uiText('Hẹn lịch', 'Appointments'), x.appointments?.length ? x.appointments.map(a => `<div>• ${esc(a.name || '')}: ${esc(a.what || '')}${a.when ? ` (${esc(a.when)})` : ''}</div>`).join('') : '')}
    ${sec('🔗 Link', x.links?.length ? x.links.map(l => `<div>• <a href="${esc(l.url)}" target="_blank" rel="noopener" style="color:var(--primary)">${esc(l.url)}</a>${l.name ? ` — ${esc(l.name)}` : ''}</div>`).join('') : '')}
    ${sec('📝 Note', x.notes?.length ? x.notes.map(n => `<div>• <strong>${esc(n.name || '')}</strong>: ${esc(n.text || '')}</div>`).join('') : '')}
    ${sec('🧠 Memory', x.memories?.length ? x.memories.map(m => `<div>• <strong>${esc(m.name || '')}</strong>: ${esc(m.text || '')}</div>`).join('') : '')}
  </div>`;
}
function journalListHtml(items, emptyMsg) {
  if (!items?.length) return `<div class="item-sub">${emptyMsg}</div>`;
  return `<div class="list" style="padding:0">${[...items].reverse().map(i => `<div class="item"><div><div class="item-title">${esc(i.userName || '?')}</div><div class="item-sub">${esc(i.text || '')}</div></div><small class="item-sub">${esc((i.ts || '').slice(0, 10))}</small></div>`).join('')}</div>`;
}
function journalChatHtml(chat, total) {
  if (!chat?.length) return `<div class="item-sub">${uiText('Không có chat ngày này (cần bật tracking).', 'No chat this day (enable tracking).')}</div>`;
  const more = total > chat.length ? `<div class="item-sub" style="margin-bottom:6px">${uiText(`hiển thị ${chat.length}/${total} tin gần nhất`, `showing last ${chat.length}/${total}`)}</div>` : '';
  return `${more}<div class="list" style="padding:0;max-height:50vh;overflow:auto">${chat.map(e => `<div class="item"><div><div class="item-title" style="font-size:13px">${esc(e.name || '')} <small class="item-sub">${esc(e.t || '')}</small></div><div class="item-sub">${esc(e.text || '')}</div></div></div>`).join('')}</div>`;
}
// ── Phân quyền — mục riêng (section #permissions) ───────────────
const permDmModes = () => [['all', uiText('Tất cả mọi người', 'Everyone')], ['friends', uiText('Chỉ bạn bè', 'Friends only')], ['list', uiText('Chỉ người được chọn', 'Selected people only')], ['owner', uiText('Chỉ owner', 'Owner only')], ['none', uiText('Không cho DM', 'No DM')]];
const permGrpModes = () => [['all', uiText('Tất cả nhóm', 'All groups')], ['list', uiText('Chỉ nhóm được chọn', 'Selected groups only')], ['none', uiText('Không nhóm nào', 'No groups')]];
const permCmdScopes = () => [['owner', uiText('Chỉ owner', 'Owner only')], ['admin', uiText('Owner + Admin', 'Owner + Admin')], ['list', uiText('Người được chọn', 'Selected people')], ['all', uiText('Mọi thành viên', 'Everyone')]];
function permModeHint(domain, mode) {
  const H = {
    dm: {
      all: uiText('Bất kỳ ai cũng nhắn riêng được với bot.', 'Anyone can DM the bot.'),
      friends: uiText('Chỉ bạn bè Zalo của bot (và người tick dưới) được DM.', "Only the bot's Zalo friends (and people ticked below) can DM."),
      list: uiText('CHỈ những người bạn tick ở dưới mới được DM với bot.', 'ONLY people you tick below can DM the bot.'),
      owner: uiText('Chỉ chủ bot (owner) được DM, người khác bị bỏ qua.', 'Only the owner can DM; others ignored.'),
      none: uiText('Bot không trả lời DM của bất kỳ ai.', 'Bot ignores all DMs.'),
    },
    group: {
      all: uiText('Bot hoạt động ở tất cả nhóm nó tham gia.', 'Bot active in every group it joins.'),
      list: uiText('Bot CHỈ hoạt động ở các nhóm bạn tick dưới đây.', 'Bot active ONLY in groups ticked below.'),
      none: uiText('Bot không hoạt động ở nhóm nào.', 'Bot inactive in all groups.'),
    },
    cmd: {
      owner: uiText('Chỉ chủ bot chạy được lệnh này.', 'Only the owner can run it.'),
      admin: uiText('Chủ bot và admin nhóm chạy được.', 'Owner and group admins can run it.'),
      list: uiText('CHỈ những người tick dưới mới chạy được.', 'ONLY people ticked below can run it.'),
      all: uiText('Mọi thành viên trong nhóm đều chạy được.', 'Any group member can run it.'),
    },
  };
  return (H[domain] && H[domain][mode]) || '';
}
let permState = { data: null, dmMode: 'all', grpMode: 'all', noteScope: 'admin', memScope: 'admin', dmSel: new Set(), grpSel: new Set(), noteSel: new Set(), memSel: new Set(), cmdTab: 'note' };

// Trang phân quyền là per-bot (mỗi bot có group riêng), nên cần biết đang cấu hình
// cho bot nào. Nhưng thanh chọn bot ở topbar CHỈ được render khi có >1 bot, nên máy
// 1 bot thì selectedBotFilter mãi là 'all' → trước đây trang hiện đúng một câu
// "chọn 1 bot ở thanh chọn bot phía trên" trong khi thanh đó không tồn tại, nhìn như
// trắng trang. Có 1 bot thì 'all' và chính bot đó là một, nên tự suy ra luôn.
// KHÔNG sửa biến selectedBotFilter toàn cục: nó còn dùng để lọc group ở trang khác.
function permProfile() {
  if (selectedBotFilter && selectedBotFilter !== 'all') return selectedBotFilter;
  const bots = (state && state.bots) || [];
  return bots.length === 1 ? bots[0].profile : '';
}

async function renderPermissions() {
  const root = document.getElementById('permContent');
  if (!root) return;
  if (!root.dataset.wired) { wirePermRoot(root); root.dataset.wired = '1'; }
  if (!state) {
    // Mở tab trước khi /api/state về — đợi refresh gọi lại, đừng báo "chưa có bot".
    root.innerHTML = `<div class="perm-empty">${uiText('Đang tải...', 'Loading...')}</div>`;
    return;
  }
  const profile = permProfile();
  if (!profile) {
    const botCount = (state.bots || []).length;
    // Không có bot nào → hướng dẫn Sync Account, chứ đừng chỉ tới thanh chọn bot rỗng.
    root.innerHTML = `<div class="perm-empty">${botCount === 0
      ? uiText('Chưa có bot nào. Bấm "Sync Account" ở trên để nạp tài khoản Zalo và group, rồi quay lại trang này.', 'No bot yet. Click "Sync Account" above to import the Zalo account and its groups, then come back.')
      : uiText('Chọn 1 bot cụ thể ở thanh chọn bot phía trên để cấu hình phân quyền (mỗi bot có nhóm riêng).', 'Pick a specific bot in the top bar to configure permissions (each bot has its own groups).')}</div>`;
    return;
  }
  root.innerHTML = `<div class="perm-empty">${uiText('Đang tải...', 'Loading...')}</div>`;
  let d;
  try { d = await journalApi('get-permissions', { profile }); }
  catch (e) { root.innerHTML = `<div class="perm-empty">${esc(e.message)}</div>`; return; }
  const p = d.permissions;
  const userMap = {};
  (d.members || []).forEach(u => { userMap[u.id] = { ...u }; });
  (d.friends || []).forEach(u => { if (!userMap[u.id]) userMap[u.id] = { ...u }; });
  permState = {
    data: { users: Object.values(userMap), groups: d.groups || [] },
    dmMode: p.dm.mode, grpMode: p.group.mode, noteScope: p.note.scope, memScope: p.memory.scope,
    dmSel: new Set((p.dm.allowList || []).map(String)),
    grpSel: new Set((p.group.allowList || []).map(String)),
    noteSel: new Set((p.note.allowList || []).map(String)),
    memSel: new Set((p.memory.allowList || []).map(String)),
    cmdTab: 'note',
  };
  rebuildPermCards();
}
function rebuildPermCards() {
  const root = document.getElementById('permContent');
  if (root && permState.data) root.innerHTML = permCardsHtml();
}
function permDrop(kind, value, options) {
  const cur = options.find(o => o[0] === value) || options[0];
  return `<div class="pdrop">
    <button type="button" class="pdrop-trigger" data-pdrop-toggle><span>${cur[1]}</span><svg class="pdrop-chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <div class="pdrop-menu">${options.map(o => `<button type="button" class="pdrop-opt ${o[0] === value ? 'active' : ''}" data-pdrop-pick="${kind}" data-val="${o[0]}">${o[1]}</button>`).join('')}</div>
  </div>`;
}
function permAvatar(item) {
  const initials = String(item.name || item.id || '?').trim().slice(0, 2).toUpperCase();
  return item.avatar
    ? `<span class="perm-av"><img src="${esc(item.avatar)}" alt="" onerror="const p=this.parentElement;this.remove();if(p)p.textContent='${esc(initials)}'"></span>`
    : `<span class="perm-av">${esc(initials)}</span>`;
}
function permUserRows(users, set, setName) {
  if (!users.length) return `<div class="perm-empty">${uiText('Chưa có member/bạn bè — mở tab Bạn bè/Thành viên để nạp trước.', 'No member/friend data yet.')}</div>`;
  return users.map(u => {
    const role = u.role === 'owner' ? `<span class="perm-role owner">Owner</span>` : `<span class="perm-role">Member</span>`;
    return `<label class="perm-row"><input type="checkbox" data-perm-check data-perm-set="${setName}" data-uid="${esc(u.id)}" ${set.has(String(u.id)) ? 'checked' : ''}/>${permAvatar(u)}<span class="perm-row-main"><span class="perm-row-name">${esc(u.name || u.id)} ${role}</span><span class="perm-row-id">${esc(u.id)}</span></span></label>`;
  }).join('');
}
function permGroupRows(groups, set) {
  if (!groups.length) return `<div class="perm-empty">${uiText('Chưa có nhóm.', 'No groups.')}</div>`;
  return groups.map(g => `<label class="perm-row"><input type="checkbox" data-perm-check data-perm-set="grp" data-gid="${esc(g.groupId)}" ${set.has(String(g.groupId)) ? 'checked' : ''}/><span class="perm-av">${esc(String(g.name || 'G').trim().slice(0, 2).toUpperCase())}</span><span class="perm-row-main"><span class="perm-row-name">${esc(repairText(g.name))}</span><span class="perm-row-id">${esc(g.groupId)}</span></span></label>`).join('');
}
function permListBlock(label, rowsHtml, placeholder) {
  return `<div class="perm-list-wrap"><div class="perm-list-label">${label}</div><input type="text" class="perm-search" data-perm-search placeholder="${placeholder}"><div class="perm-list">${rowsHtml}</div></div>`;
}
const PERM_SAVE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 21v-8H7v8M7 3v5h7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function permHint(domain, mode) {
  const txt = permModeHint(domain, mode);
  return txt ? `<div class="perm-hint"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M12 8h.01M11 12h1v4h1m-1 5a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${txt}</span></div>` : '';
}
function permCardsHtml() {
  const s = permState;
  const users = s.data.users || [];
  const groups = s.data.groups || [];
  const dmShow = !['none', 'owner'].includes(s.dmMode);
  const grpShow = s.grpMode !== 'none';
  const cmdKind = s.cmdTab === 'note' ? 'note' : 'memory';
  const cmdScope = s.cmdTab === 'note' ? s.noteScope : s.memScope;
  const cmdSet = s.cmdTab === 'note' ? s.noteSel : s.memSel;
  const cmdShow = cmdScope !== 'owner';
  const saveBtn = kind => `<button type="button" class="btn primary perm-save-btn" data-permsave-card="${kind}">${PERM_SAVE_ICON}<span>${uiText('Lưu', 'Save')}</span></button>`;
  return `
    <div class="card perm-card">
      <div class="perm-card-head"><span class="perm-card-emoji">💬</span><div class="perm-card-title"><strong>${uiText('Quyền DM', 'DM access')}</strong><div class="item-sub">${uiText('Ai được nhắn riêng với bot', 'Who can DM the bot')}</div></div>${saveBtn('dm')}</div>
      ${permDrop('dmMode', s.dmMode, permDmModes())}
      ${permHint('dm', s.dmMode)}
      ${dmShow ? permListBlock(uiText('Danh sách cho phép', 'Allow list'), permUserRows(users, s.dmSel, 'dm'), uiText('Tìm tên / ID...', 'Search name / ID...')) : ''}
    </div>
    <div class="card perm-card">
      <div class="perm-card-head"><span class="perm-card-emoji">👥</span><div class="perm-card-title"><strong>${uiText('Quyền Group', 'Group access')}</strong><div class="item-sub">${uiText('Bot hoạt động ở nhóm nào', 'Which groups the bot serves')}</div></div>${saveBtn('group')}</div>
      ${permDrop('grpMode', s.grpMode, permGrpModes())}
      ${permHint('group', s.grpMode)}
      ${grpShow ? permListBlock(uiText('Danh sách nhóm', 'Group list'), permGroupRows(groups, s.grpSel), uiText('Tìm nhóm...', 'Search group...')) : ''}
    </div>
    <div class="card perm-card">
      <div class="perm-card-head"><span class="perm-card-emoji">📝</span><div class="perm-card-title"><strong>${uiText('Quyền lệnh', 'Command access')}</strong><div class="item-sub">${uiText('Ai được chạy /note & /memory', 'Who can run /note & /memory')}</div></div>${saveBtn('cmd')}</div>
      <div class="perm-tabs"><button type="button" class="perm-tab ${s.cmdTab === 'note' ? 'active' : ''}" data-perm-tab="note">📝 /note</button><button type="button" class="perm-tab ${s.cmdTab === 'memory' ? 'active' : ''}" data-perm-tab="memory">🧠 /memory</button></div>
      ${permDrop(cmdKind === 'note' ? 'noteScope' : 'memScope', cmdScope, permCmdScopes())}
      ${permHint('cmd', cmdScope)}
      ${cmdShow ? permListBlock(uiText('Ai được chạy', 'Allowed for') + ' /' + cmdKind, permUserRows(users, cmdSet, cmdKind === 'note' ? 'note' : 'mem'), uiText('Tìm tên / ID...', 'Search name / ID...')) : ''}
    </div>`;
}
function wirePermRoot(root) {
  root.addEventListener('click', async e => {
    const toggle = e.target.closest('[data-pdrop-toggle]');
    if (toggle) {
      const dd = toggle.closest('.pdrop');
      const wasOpen = dd.classList.contains('open');
      root.querySelectorAll('.pdrop.open').forEach(d => d.classList.remove('open'));
      if (!wasOpen) dd.classList.add('open');
      return;
    }
    const pick = e.target.closest('[data-pdrop-pick]');
    if (pick) {
      const kind = pick.dataset.pdropPick;
      permState[kind] = pick.dataset.val; // dmMode | grpMode | noteScope | memScope
      rebuildPermCards();
      return;
    }
    const tab = e.target.closest('[data-perm-tab]');
    if (tab) { permState.cmdTab = tab.dataset.permTab; rebuildPermCards(); return; }
    const save = e.target.closest('[data-permsave-card]');
    if (save) { await savePermCard(save); return; }
  });
  root.addEventListener('change', e => {
    const chk = e.target.closest('input[data-perm-check]');
    if (!chk) return;
    const map = { dm: permState.dmSel, grp: permState.grpSel, note: permState.noteSel, mem: permState.memSel };
    const set = map[chk.dataset.permSet];
    if (!set) return;
    const id = chk.dataset.uid || chk.dataset.gid;
    if (chk.checked) set.add(id); else set.delete(id);
  });
  root.addEventListener('input', e => {
    const s = e.target.closest('[data-perm-search]');
    if (!s) return;
    const q = String(s.value || '').toLowerCase().trim();
    s.parentElement.querySelectorAll('.perm-row').forEach(row => {
      row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.pdrop')) root.querySelectorAll('.pdrop.open').forEach(d => d.classList.remove('open'));
  });
}
async function savePermCard(btn) {
  const permissions = {
    dm: { mode: permState.dmMode, allowList: [...permState.dmSel] },
    group: { mode: permState.grpMode, allowList: [...permState.grpSel] },
    note: { scope: permState.noteScope, allowList: [...permState.noteSel] },
    memory: { scope: permState.memScope, allowList: [...permState.memSel] },
  };
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳';
  try {
    await journalApi('save-permissions', { permissions });
    showToast(uiText('Đã lưu phân quyền', 'Permissions saved'), 'success');
  } catch (e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = old; }
}
async function openGroupDetailModal(groupId) {
  let detail = null;
  try { detail = await runAction('group-detail', { groupId }, 'Group detail loaded'); } catch (_) { }
  if (!detail) {
    let pendingResult = null;
    try { pendingResult = await runAction('get-pending', { groupId }, 'Pending members loaded'); } catch (_) { }
    detail = buildLocalGroupDetail(groupId, pendingResult);
  }
  currentDetailGroupId = groupId;
  currentDetailPayload = detail;
  // Footer là "Đóng", không phải "Lưu": modal này không còn form nào cần chốt. Mọi feature toggle
  // (Mute/Silent/Follow…) lưu tức thì khi bấm, còn lịch báo cáo đã chuyển sang trang riêng.
  await openModal({ title: uiText('Chi tiết group', 'Group details'), body: groupDetailBody(detail), confirmText: uiText('Đóng', 'Close') });
}
function groupDetailBody(detail) {
  const pending = pendingMembersFromDetail(detail);
  const pendingCount = Number(detail.pendingCount || pending.length || 0);
  const modes = Array.isArray(detail.customModes) ? detail.customModes : [];
  const people = groupPeople(detail);
  const VIEW_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>';
  return `
        <div class="list" style="padding:0">
          <div class="item"><div><div class="item-title">${esc(repairText(detail.name))} <span class="member-badge">${detail.memberCount || 0} ${uiText('members', 'members')}</span></div><div class="item-sub">${esc(detail.groupId)} - ${detail.admins?.length || 0} admins</div></div><span class="status ${detail.settings?.pendingAuto ? 'on' : 'off'}">${detail.settings?.pendingAuto ? uiText('Tự duyệt', 'Auto approve') : uiText('Duyệt tay', 'Manual')}</span></div>
          <div class="item"><div><div class="item-title">${uiText('Owner/Admin', 'Owner/Admin')}</div><div class="avatar-stack" style="margin-top:10px">${people.map(personChip).join('') || `<small>${uiText('Chưa có owner/admin', 'No owner/admin')}</small>`}</div></div></div>
          <div class="item"><div><div class="item-title">${uiText('Tính năng', 'Features')}</div><div class="feature-toggles" style="margin-top:8px">
            ${[
      ['muted', 'Mute'],
      ['silent', 'Silent'],
      ['welcome', 'Welcome'],
      ['follow', 'Follow'],
      ['pendingAuto', uiText('Tự duyệt', 'Auto approve')],
    ].map(([key, label]) => `<button class="feature-toggle ${detail.settings?.[key] ? 'on' : 'off'}" type="button" data-toggle="${esc(detail.botGroupId || detail.groupId)}:${key}:${!detail.settings?.[key]}" data-toggle-profile="${esc(selBotProfile())}">${label}</button>`).join('')}
          </div></div></div>
          <div class="item"><div style="width:100%">
            ${/* Hai nút CÙNG MỘT DÒNG với tiêu đề: chính (Lịch báo cáo — nơi cài đặt thật) + phụ
                  (Nhật ký). Ba thứ phải làm cùng nhau, thiếu một là rớt dòng:
                    · `.btn` có min-height:38px nên phải ghi đè, không thì giảm padding vô ích;
                    · `white-space:nowrap` để nhãn nút không tự xé làm hai;
                    · `flex-wrap:wrap` + `min-width` cho tiêu đề: màn hẹp thì cả CỤM nút xuống dòng
                      dưới, thay vì bóp tiêu đề thành 3 dòng như bản trước. */''}
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
              <div class="item-title" style="font-size:15px;font-weight:700;flex:1 1 auto;min-width:150px">🗓️ ${uiText('Lịch báo cáo cuối ngày', 'End-of-day report')}</div>
              <div style="display:flex;align-items:center;gap:6px;flex:0 0 auto">
                <button class="btn" type="button" data-journal="${esc(detail.groupId)}"
                  style="min-height:0;height:28px;padding:0 9px;font-size:11.5px;white-space:nowrap;flex:none">${VIEW_ICON}${uiText('Nhật ký', 'Journal')}</button>
                <button class="btn primary" type="button" data-goto-reports
                  style="min-height:0;height:28px;padding:0 9px;font-size:11.5px;white-space:nowrap;flex:none">🗓️ ${uiText('Lịch báo cáo', 'Schedules')}</button>
              </div>
            </div>
            <div class="item-sub" style="margin:2px 0 0">${uiText(
              'Lịch báo cáo là thực thể riêng vì một lịch trải trên nhiều nhóm — cài ở trang Lịch báo cáo.',
              'Schedules are their own entity because one schedule spans many groups — set them on the Schedules page.')}</div>
          </div></div>
          <div class="item">
            <div style="width:100%">
              <div class="pending-head">
                <div class="item-title">${uiText('Member đang chờ duyệt', 'Pending members')}</div>
                ${pending.length ? `<button class="btn pending-approve-all" type="button" data-approve-all="${esc(detail.groupId)}:${esc(pending.map(m => m.id).join(','))}">${uiText('Duyệt tất cả', 'Approve all')}</button>` : ''}
              </div>
              ${pending.length ? `<div class="pending-list">${pending.map(member => `
                <div class="pending-card">
                  <div class="pending-user">
                    <strong>${esc(member.name && member.name !== member.id ? member.name : `Zalo ${member.id.slice(-6)}`)}</strong>
                    <small>ID: ${esc(member.id)}</small>
                  </div>
                  <button class="btn pending-approve" type="button" data-approve-one="${esc(detail.groupId)}:${esc(member.id)}">${uiText('Duyệt', 'Approve')}</button>
                </div>
              `).join('')}</div>` : `<div class="item-sub">${pendingCount ? uiText(`Có ${pendingCount} member đang chờ nhưng ZCA chưa trả danh sách chi tiết.`, `${pendingCount} members are pending but ZCA did not return the detailed list.`) : uiText('Không có pending member hoặc ZCA chưa trả dữ liệu.', 'No pending members or ZCA did not return data.')}</div>`}
            </div>
            </div>
          </div>
        </div>
      `;
}
navButtons.forEach(button => {
  button.addEventListener('click', () => setSection(button.dataset.section));
});
document.getElementById('permBtn')?.addEventListener('click', () => setSection('permissions'));
document.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target) return;
  activeActionButton = target.matches('[data-action], [data-toggle], [data-remove], [data-dm], [data-friend], [data-toggle-custom], [data-add-mode], [data-edit-mode], [data-group-detail], [data-approve-one], [data-approve-all], [data-bulk-feature], [data-select-all-groups], [data-leave-group], [data-copy-id], [data-scan-members], [data-bulk-member-action], [data-member-group], [data-group-filter]') ? target : null;
  try {
    if (target.dataset.sectionTarget) setSection(target.dataset.sectionTarget);
    if (target.dataset.groupFilter) {
      currentGroupFilter = target.dataset.groupFilter;
      document.querySelectorAll('[data-group-filter]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.groupFilter === currentGroupFilter);
      });
      renderGroups();
      updateBulkBar();
    }
    if (target.hasAttribute('data-select-all-groups')) {
      const visibleGroups = state.groups.filter(groupMatchesFilter);
      const allSelected = visibleGroups.length > 0 && visibleGroups.every(group => selectedGroups.has(group.groupId));
      visibleGroups.forEach(group => {
        if (allSelected) selectedGroups.delete(group.groupId);
        else selectedGroups.add(group.groupId);
      });
      renderGroups();
      updateBulkBar();
    }
    if (target.dataset.openMembers) {
      activeGroupId = target.dataset.openMembers
      setSection('members');
      renderMembers();
    }
    if (target.dataset.memberGroup) {
      activeGroupId = target.dataset.memberGroup;
      renderMembers();
    }
    if (target.dataset.selectAllMembers !== undefined) {
      const keys = Object.keys(state.members[activeGroupId] || {}).map(userId => `${activeGroupId}:${userId}`);
      const allSelected = keys.length > 0 && keys.every(key => selectedMembers.has(key));
      keys.forEach(key => allSelected ? selectedMembers.delete(key) : selectedMembers.add(key));
      renderMembers();
    }
    if (target.dataset.bulkMemberAction) {
      if (!selectedMembers.size) return showToast('Select at least one member first.', 'warning');
      const selected = [...selectedMembers].filter(key => key.startsWith(`${activeGroupId}:`)).map(key => key.split(':')[1]);
      if (!selected.length) return showToast('No members selected in this group.', 'warning');
      if (!state.license?.canBulk) {
        showToast(t('Thao tác nhiều thành viên yêu cầu gói PRO hoặc TEAM.', 'Multi-member actions require PRO or TEAM.'), 'warning');
        setSection('upgrade');
        return;
      }
      if (target.dataset.bulkMemberAction === 'friend') {
        await runAction('bulk-friend-request', { userIds: selected, message: 'Xin chào, mình là Williams bot owner.' }, 'Friend requests sent');
        showToast('Friend requests sent.', 'success');
      }
      if (target.dataset.bulkMemberAction === 'dm') {
        const ok = await openModal({
          title: t('Nhắn nhiều thành viên', 'Bulk DM'),
          desc: t(`Gửi tin tới ${selected.length} member trong group hiện tại.`, `Send message to ${selected.length} selected members.`),
          body: `<label>${t('Nội dung', 'Message')}<textarea id="bulkMemberMessage">${t('Xin chào, mình là owner.', 'Hi, this is the owner.')}</textarea></label>`,
          confirmText: t('Gửi', 'Send'),
        });
        const text = document.getElementById('bulkMemberMessage')?.value.trim();
        if (ok && text) {
          await runAction('send-messages', { targets: selected.map(targetId => ({ targetType: 'user', targetId })), text }, 'Bulk DM sent');
          showToast(t('Đã gửi DM hàng loạt', 'Bulk DM sent'), 'success');
        }
      }
    }
    if (target.dataset.bulkFeature) {
      if (!state.license?.canBulk) {
        showToast(t('Thao tác hàng loạt cho nhiều group yêu cầu bản quyền PRO!', 'Bulk operations for multiple groups require a PRO license!'), 'error');
        setSection('upgrade');
        return;
      }
      if (!selectedGroups.size) return showToast('Select at least one group first.', 'warning');
      const [key, rawValue] = target.dataset.bulkFeature.split(':');
      const value = rawValue === 'true';
      if (key === 'pendingAuto' && value) {
        const ok = await confirmPendingAutoWarning();
        if (!ok) return;
      }
      // Per-bot: when a specific bot is selected, map each selected group to THAT bot's
      // groupId and pass the profile so the change applies to that bot only.
      const _bulkProfile = selBotProfile();
      const _bulkGids = [...selectedGroups].map(gid => {
        if (!_bulkProfile) return gid;
        const g = state.groups.find(x => x.groupId === gid || (Array.isArray(x.siblingIds) && x.siblingIds.includes(gid)));
        return (g && g.groupIdByProfile && g.groupIdByProfile[_bulkProfile]) || gid;
      });
      await runAction('bulk-toggle-setting', { groupIds: _bulkGids, key, value, profile: _bulkProfile }, 'Bulk groups updated');
      renderGroups();
      updateBulkBar();
    }
    if (target.dataset.scanMembers) {
      const groupId = target.dataset.scanMembers;
      activeGroupId = groupId;
      await runAction('scan-members', { groupId }, 'Member scan complete');
      setSection('members');
      renderMembers();
    }
    if (target.dataset.copyId) {
      const id = target.dataset.copyId;
      await navigator.clipboard.writeText(id);
      showToast(uiText('Đã copy ID', 'ID copied'), 'success');
    }
    if (target.dataset.groupDetail) {
      await openGroupDetailModal(target.dataset.groupDetail);
    }
    if (target.dataset.journal) {
      await openJournalSection(target.dataset.journal);
    }
    if (target.dataset.jtab) {
      journalState.tab = target.dataset.jtab;
      journalRerender();
    }
    if (target.dataset.jdate) {
      try { await loadJournal(journalState.groupId, target.dataset.jdate); journalRerender(); }
      catch (e) { showToast(e.message, 'error'); }
    }
    if (target.dataset.jsectionDate) {
      await journalPickDate(target.dataset.jsectionDate);
    }
    if (target.dataset.jgen) {
      const btn = target;
      btn.textContent = '⏳...'; btn.disabled = true;
      try {
        await journalApi('generate-summary', { groupId: journalState.groupId, date: target.dataset.jgen });
        await loadJournal(journalState.groupId, target.dataset.jgen);
        journalState.tab = 'summary';
        journalRerender();
        showToast(uiText('Đã tổng hợp', 'Summarized'), 'success');
      } catch (e) {
        showToast(uiText('Lỗi tổng hợp', 'Summarize error') + ': ' + e.message, 'error');
        btn.textContent = '↻'; btn.disabled = false;
      }
    }
    if (target.dataset.leaveGroup) {
      const groupId = target.dataset.leaveGroup;
      const ok = await openModal({
        title: uiText('Rời nhóm', 'Leave group'),
        desc: uiText(`Bot sẽ rời group ${groupId}.`, `Bot will leave group ${groupId}.`),
        body: `<div class="item-sub">${uiText('Thao tác này sẽ gọi API leaveGroup thật.', 'This action calls the real leaveGroup API.')}</div>`,
        confirmText: uiText('Rời nhóm', 'Leave'),
        danger: true,
        tone: 'danger',
      });
      if (ok) await runAction('leave-group', { groupId, silent: true }, uiText('Bot đã rời nhóm', 'Bot left the group'));
    }
    if (target.dataset.approveOne) {
      const [groupId, userId] = target.dataset.approveOne.split(':');
      await runAction('review-pending', { groupId, members: userId, approve: true }, 'Member approved');
    }
    if (target.dataset.approveAll) {
      const [groupId, members] = target.dataset.approveAll.split(':');
      await runAction('review-pending', { groupId, members, approve: true }, 'All pending members approved');
    }
    if (target.dataset.toggleCustom || target.dataset.addMode || target.dataset.editMode) {
      if (!state.license?.isPro) {
        showToast(t('Chức năng cài đặt nhóm nâng cao yêu cầu bản quyền PRO!', 'Advanced group settings require a PRO license!'), 'error');
        setSection('upgrade');
        return;
      }
    }
    if (target.dataset.toggle) {
      const [groupId, key, rawValue] = target.dataset.toggle.split(':');
      const profile = target.dataset.toggleProfile || '';
      const value = rawValue === 'true';
      if (key === 'pendingAuto' && value) {
        const ok = await confirmPendingAutoWarning();
        if (!ok) { renderGroups(); return; } // huỷ → giữ nguyên trạng thái, không bật
      }
      // Reflect the change immediately and before the API call: toggle-setting doesn't return
      // full state, so runAction()'s refreshDetailModal() (fired once the request resolves)
      // would otherwise rebuild the open modal from the stale pre-toggle value, making the
      // toggle look like it reverted itself right after being saved.
      // groupId is the SELECTED bot's per-account id — match against the row id, its
      // per-bot map, or its siblings so the optimistic update lands on the right row.
      const g = state.groups && state.groups.find(x =>
        x.groupId === groupId
        || (x.groupIdByProfile && Object.values(x.groupIdByProfile).includes(groupId))
        || (Array.isArray(x.siblingIds) && x.siblingIds.includes(groupId)));
      if (g) {
        // Per-bot toggle must NOT leak to sibling bots. seed()/merge make
        // settingsByProfile[winnerProfile] the SAME object as g.settings, and other bots
        // fall back to g.settings when their own bucket is absent — so mutating in place
        // flips their badge too. Clone before writing to break that shared reference, and
        // when a bot is selected always write into ITS OWN bucket (never shared g.settings).
        if (profile) {
          g.settingsByProfile = g.settingsByProfile || {};
          g.settingsByProfile[profile] = { ...(g.settingsByProfile[profile] || g.settings || {}) };
          g.settingsByProfile[profile][key] = value;
        } else {
          g.settings = { ...(g.settings || {}) };
          g.settings[key] = value;
        }
      }
      await runAction('toggle-setting', { groupId, key, value, profile }, t(`${key} đã cập nhật`, `${key} updated`));
      renderGroups();
      updateBulkBar();
      // Bật Silent → mở modal diễn giải + cho sửa "tên gọi" (name triggers) của bot.
      // Name triggers theo TÀI KHOẢN: dùng profile của toggle, hoặc profile đầu của nhóm.
      if (key === 'silent' && value && !modalBackdrop.classList.contains('open')) {
        const acct = profile || String(g?.profile || '').split(',')[0].trim() || 'default';
        const botLabel = (state?.bots || []).find(b => (b.profile || b.id || b.accountId) === acct)?.name || acct;
        await openSilentNameModal(acct, botLabel);
      }
    }
    if (target.dataset.toggleCustom) {
      const [groupId, slug, state] = target.dataset.toggleCustom.split(':');
      await runAction('toggle-custom-mode', { groupId, slug, enabled: state === 'on' }, 'Custom mode updated');
    }
    if (target.dataset.addMode || target.dataset.editMode) {
      const [groupId, slug = ''] = String(target.dataset.editMode || `${target.dataset.addMode}:`).split(':');
      const group = state.groups.find(item => item.groupId === groupId);
      const currentMode = group?.customModes?.find(item => item.slug === slug);
      const ok = await openModal({
        title: currentMode ? 'Edit custom mode' : 'Create custom mode',
        desc: 'This mode creates /bot-<slug>-on and /bot-<slug>-off commands for the group.',
        body: `
            <label>Mode label<input id="modeLabel" autocomplete="off" value="${esc(currentMode?.label || '')}" placeholder="Bot si / Morning"></label>
            <label>Command slug<input id="modeSlug" autocomplete="off" value="${esc(currentMode?.slug || '')}" placeholder="bot-si / bot-morning"></label>
            <label>Attached skill<input id="modeSkill" autocomplete="off" value="${esc(currentMode?.skill || '')}" placeholder="zalo-group-admin, morning-greeter"></label>
            <label>Short description<textarea id="modeDesc" placeholder="Context for this mode">${esc(currentMode?.description || '')}</textarea></label>
          `,
        confirmText: currentMode ? 'Save mode' : 'Create mode',
      });
      if (ok) {
        const label = document.getElementById('modeLabel')?.value.trim();
        const modeSlug = document.getElementById('modeSlug')?.value.trim();
        const skill = document.getElementById('modeSkill')?.value.trim();
        const description = document.getElementById('modeDesc')?.value.trim();
        await runAction('upsert-custom-mode', { groupId, slug: modeSlug, label, skill, description, enabled: currentMode?.enabled !== false }, 'Custom mode saved');
      }
    }
    if (target.dataset.remove) {
      const [groupId, userId] = target.dataset.remove.split(':');
      const ok = await openModal({
        title: t('Xác nhận kick member', 'Confirm member kick'),
        desc: t(`User ${userId} sẽ bị xóa khỏi group ${groupId}.`, `User ${userId} will be removed from group ${groupId}.`),
        body: `<label>${t('Nhập KICK để xác nhận', 'Type KICK to confirm')}<input id="confirmText" autocomplete="off"></label>`,
        confirmText: 'Kick',
        danger: true,
      });
      if (ok && document.getElementById('confirmText')?.value === 'KICK') {
        await runAction('remove-user', { groupId, userId }, t('Đã gửi yêu cầu kick tới ZCA', 'Kick request sent to ZCA'));
      } else if (ok) {
        showToast(t('Chưa nhập đúng xác nhận KICK.', 'KICK confirmation was not entered correctly.'), 'warning');
      }
    }
    if (target.dataset.dm) {
      const [userId, ...nameParts] = target.dataset.dm.split(':');
      const name = nameParts.join(':') || userId;
      const initials = String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || 'U';

      const profile = cachedFriends ? cachedFriends.find(f => String(f.userId) === String(userId).replace(/_0$/, '')) : null;
      const avatarUrl = profile && profile.avatar ? profile.avatar : '';
      const phone = profile && profile.phoneNumber ? profile.phoneNumber : '';
      const dob = profile && profile.sdob ? profile.sdob : '';

      let avatarHtml = '';
      if (avatarUrl) {
        avatarHtml = `<img src="${esc(avatarUrl)}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--primary-light);" onerror="this.outerHTML='<div class=&quot;modal-avatar&quot; style=&quot;width:48px; height:48px; border-radius:50%; background:linear-gradient(135deg, var(--primary) 0%, var(--primary-deep) 100%); color:white; font-weight:700; font-size:16px; display:flex; align-items:center; justify-content:center; text-transform:uppercase;&quot;>${esc(initials)}</div>'" />`;
      } else {
        avatarHtml = `<div class="modal-avatar" style="width:48px; height:48px; border-radius:50%; background:linear-gradient(135deg, var(--primary) 0%, var(--primary-deep) 100%); color:white; font-weight:700; font-size:16px; display:flex; align-items:center; justify-content:center; text-shadow:0 1px 2px rgba(0,0,0,0.15); text-transform:uppercase;">${esc(initials)}</div>`;
      }

      let infoLinesHtml = '';
      if (phone) {
        infoLinesHtml += `
            <div style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); margin-top: 4px;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--primary);"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
              <span>${esc(phone)}</span>
            </div>
          `;
      }
      if (dob) {
        infoLinesHtml += `
            <div style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); margin-top: 4px;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--primary);"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
              <span>${esc(dob)}</span>
            </div>
          `;
      }

      const ok = await openModal({
        title: t(`Nhắn tin cho ${repairText(name)}`, `Message ${repairText(name)}`),
        desc: t(`Tin nhắn sẽ gửi trực tiếp tới Zalo userId ${userId}.`, `This message will be sent directly to Zalo userId ${userId}.`),
        body: `
            <div class="premium-friend-modal-card" style="display:flex; align-items:center; gap:16px; background:var(--surface-2); padding:16px; border-radius:14px; border:1.5px solid var(--border); margin-bottom:18px; box-shadow:inset 0 0 0 1px rgba(255,255,255,0.05);">
              ${avatarHtml}
              <div>
                <strong style="display:block; font-size:16px; color:var(--text); font-weight:700;">${esc(repairText(name))}</strong>
                <div style="font-family:monospace; font-size:12px; color:var(--text-muted); margin-top:2px;">ID: ${esc(userId)}</div>
                ${infoLinesHtml}
              </div>
            </div>
            <label>${t('Nội dung', 'Content')}<textarea id="dmText" placeholder="${t('Nhập nội dung cần gửi...', 'Enter message content...')}"></textarea></label>
          `,
        confirmText: t('Gửi tin', 'Send'),
      });
      const text = document.getElementById('dmText')?.value.trim();
      if (ok && text) await runAction('send-message', { targetType: 'user', targetId: userId, text }, t('Đã gửi tin nhắn', 'Message sent'));
    }
    if (target.dataset.friend) {
      const [userId, ...nameParts] = target.dataset.friend.split(':');
      const name = nameParts.join(':') || userId;
      const initials = String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || 'U';

      const profile = cachedFriends ? cachedFriends.find(f => String(f.userId) === String(userId).replace(/_0$/, '')) : null;
      const avatarUrl = profile && profile.avatar ? profile.avatar : '';
      const phone = profile && profile.phoneNumber ? profile.phoneNumber : '';
      const dob = profile && profile.sdob ? profile.sdob : '';

      let avatarHtml = '';
      if (avatarUrl) {
        avatarHtml = `<img src="${esc(avatarUrl)}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--primary-light);" onerror="this.outerHTML='<div class=&quot;modal-avatar&quot; style=&quot;width:48px; height:48px; border-radius:50%; background:linear-gradient(135deg, var(--primary) 0%, var(--primary-deep) 100%); color:white; font-weight:700; font-size:16px; display:flex; align-items:center; justify-content:center; text-transform:uppercase;&quot;>${esc(initials)}</div>'" />`;
      } else {
        avatarHtml = `<div class="modal-avatar" style="width:48px; height:48px; border-radius:50%; background:linear-gradient(135deg, var(--primary) 0%, var(--primary-deep) 100%); color:white; font-weight:700; font-size:16px; display:flex; align-items:center; justify-content:center; text-shadow:0 1px 2px rgba(0,0,0,0.15); text-transform:uppercase;">${esc(initials)}</div>`;
      }

      let infoLinesHtml = '';
      if (phone) {
        infoLinesHtml += `
            <div style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); margin-top: 4px;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--primary);"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
              <span>${esc(phone)}</span>
            </div>
          `;
      }
      if (dob) {
        infoLinesHtml += `
            <div style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); margin-top: 4px;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--primary);"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
              <span>${esc(dob)}</span>
            </div>
          `;
      }

      const ok = await openModal({
        title: t('Gửi lời mời kết bạn', 'Send Friend Request'),
        desc: t('Gửi lời mời kết bạn thật theo Zalo userId. Đây không phải là tin nhắn DM.', 'Send a real friend request by Zalo userId. This is not a DM message.'),
        body: `
            <div class="premium-friend-modal-card" style="display:flex; align-items:center; gap:16px; background:var(--surface-2); padding:16px; border-radius:14px; border:1.5px solid var(--border); margin-bottom:18px; box-shadow:inset 0 0 0 1px rgba(255,255,255,0.05);">
              ${avatarHtml}
              <div>
                <strong style="display:block; font-size:16px; color:var(--text); font-weight:700;">${esc(repairText(name))}</strong>
                <div style="font-family:monospace; font-size:12px; color:var(--text-muted); margin-top:2px;">ID: ${esc(userId)}</div>
                ${infoLinesHtml}
              </div>
            </div>
            <label>${t('Lời nhắn kết bạn', 'Friend Invitation Message')}<textarea id="friendText" style="min-height:80px; width:100%;">${t('Xin chào, mình là Williams bot owner.', 'Hi, I am the Williams bot owner.')}</textarea></label>
          `,
        confirmText: t('Gửi lời mời', 'Send request'),
      });
      const message = document.getElementById('friendText')?.value.trim();
      if (ok) await runAction('send-friend-request', { userId, message }, t('Đã gửi lời mời kết bạn', 'Friend request sent'));
    }
    if (target.dataset.acceptFriend) {
      const userId = target.dataset.acceptFriend;
      await runAction('accept-friend', { userId }, t('Đã đồng ý kết bạn', 'Friend request accepted'));
      const p = cachedFriends ? cachedFriends.find(f => String(f.userId) === String(userId)) : null;
      if (p) p.isFr = 1;
      saveCachedFriendsToStorage();
      renderMembers();
    }
    if (target.dataset.action) {
      const action = target.dataset.action;
      if (action === 'open-api') setSection('api');
      if (action === 'open-upgrade') setSection('upgrade');
      if (action === 'sync') {
        if (selectedBotFilter === 'all' && state.bots?.length > 1 && !state.license?.canMultiBot) {
          showToast(t('Đồng bộ nhiều bot cùng lúc yêu cầu gói TEAM. Hãy chọn một bot để đồng bộ riêng.', 'Syncing multiple bots at once requires TEAM. Select one bot to sync it separately.'), 'warning');
          setSection('upgrade');
          return;
        }
        const syncPayload = selectedBotFilter === 'all' ? {} : { profile: selectedBotFilter };
        const res = await runAction('sync-groups', syncPayload, t('Đã sync group từ ZCA', 'Synced groups from ZCA'));
        if (res && Array.isArray(res.failed) && res.failed.length) {
          showToast(t(`⚠️ Bot lỗi session, KHÔNG sync được: ${res.failed.join(', ')}. Đăng nhập lại các bot này rồi sync lại.`, `Sync failed for: ${res.failed.join(', ')}. Re-login those bots and sync again.`), 'warning');
        }
        // Sync xong danh sách nhóm/member thì kéo luôn liên hệ + nhãn Zalo về CRM cho cùng phạm vi.
        // Không tách thành nút riêng nữa: owner sẽ không nhớ bấm, và CRM sẽ luôn cũ hơn thực tế.
        await crmSyncFromZalo(selectedBotFilter === 'all' ? '' : selectedBotFilter);
      }
      if (action === 'danger') showToast(t('Action nguy hiểm cần xác nhận 2 bước ở backend.', 'Danger actions require two-step confirmation in backend.'), 'warning');
      if (action === 'approve-selected') {
        const ok = await openModal({
          title: t('Duyệt pending member', 'Approve pending member'),
          desc: t('Nhập groupId và userId đang chờ duyệt. Hỗ trợ nhiều userId cách nhau bằng dấu phẩy.', 'Enter groupId and pending userId. Multiple userIds can be separated by commas.'),
          body: '<label>Group ID<input id="pendingGroup" autocomplete="off"></label><label>User IDs<textarea id="pendingUsers" placeholder="userId1, userId2"></textarea></label>',
          confirmText: t('Duyệt', 'Approve'),
        });
        const groupId = document.getElementById('pendingGroup')?.value.trim();
        const members = document.getElementById('pendingUsers')?.value.trim();
        if (ok && groupId && members) await runAction('review-pending', { groupId, members, approve: true }, t('Đã gửi lệnh duyệt member', 'Approve request sent'));
      }
      if (action === 'kick-by-id') {
        const ok = await openModal({
          title: t('Kick member theo ID', 'Kick member by ID'),
          desc: t('Thao tác này gọi removeUserFromGroup thật.', 'This action calls the real removeUserFromGroup API.'),
          body: `<label>Group ID<input id="kickGroup" autocomplete="off"></label><label>User ID<input id="kickUser" autocomplete="off"></label><label>${t('Nhập KICK để xác nhận', 'Type KICK to confirm')}<input id="kickConfirm" autocomplete="off"></label>`,
          confirmText: 'Kick',
          danger: true,
        });
        const groupId = document.getElementById('kickGroup')?.value.trim();
        const userId = document.getElementById('kickUser')?.value.trim();
        const confirmText = document.getElementById('kickConfirm')?.value.trim();
        if (ok && groupId && userId && confirmText === 'KICK') await runAction('remove-user', { groupId, userId }, t('Đã gửi lệnh kick member', 'Kick request sent'));
      }
      if (action === 'find-user') {
        const ok = await openModal({
          title: t('Tìm user Zalo', 'Find Zalo user'),
          desc: t('Gọi getUserInfo theo userId.', 'Call getUserInfo by userId.'),
          body: '<label>User ID<input id="findUserId" autocomplete="off"></label>',
          confirmText: t('Tìm', 'Find'),
        });
        const userId = document.getElementById('findUserId')?.value.trim();
        if (ok && userId) {
          const result = await runAction('get-user-info', { userId }, t('Đã gọi getUserInfo', 'getUserInfo called'));
          await openModal({ title: t('Kết quả getUserInfo', 'getUserInfo Result'), body: `<pre style="white-space:pre-wrap;max-height:320px;overflow:auto">${esc(JSON.stringify(result, null, 2))}</pre>`, confirmText: t('Đóng', 'Close') });
        }
      }
      if (action === 'friend-request-by-id') {
        const prefilledId = target.dataset.userId || '';
        const ok = await openModal({
          title: t('Gửi lời mời kết bạn', 'Send Friend Request'),
          desc: t('Gọi sendFriendRequest thật theo userId.', 'Call the real sendFriendRequest API by userId.'),
          body: `<label>User ID<input id="friendUserId" autocomplete="off" value="${esc(prefilledId)}"></label><label>${t('Lời nhắn', 'Message')}<textarea id="friendMessage">${t('Xin chào, mình là Williams bot owner.', 'Hi, I am the Williams bot owner.')}</textarea></label>`,
          confirmText: t('Gửi lời mời', 'Send request'),
        });
        const userId = document.getElementById('friendUserId')?.value.trim();
        const message = document.getElementById('friendMessage')?.value.trim();
        if (ok && userId) await runAction('send-friend-request', { userId, message }, t('Đã gửi lời mời kết bạn', 'Friend request sent'));
      }
      if (action === 'get-friends') {
        const result = await runAction('get-friends', {}, t('Đã tải danh sách bạn bè', 'Friend list loaded'));
        await openModal({ title: 'Bạn bè API result', body: `<pre style="white-space:pre-wrap;max-height:320px;overflow:auto">${esc(JSON.stringify(result, null, 2))}</pre>`, confirmText: t('Đóng', 'Close') });
      }
      if (action === 'send') {
        const form = document.querySelector('#messages form');
        const text = form?.querySelector('textarea')?.value || '';

        let targets = [];

        if (composerTargetType === 'group' || composerTargetType === 'user') {
          if (composerSelectedTargets.has('all-groups')) {
            targets = state.groups.map(g => ({ targetType: 'group', targetId: g.groupId }));
          } else if (composerSelectedTargets.has('all-users')) {
            if (cachedFriends) {
              targets = cachedFriends.map(f => ({ targetType: 'user', targetId: f.userId || f.id || f.uid }));
            }
          } else {
            targets = Array.from(composerSelectedTargets).map(val => {
              const parts = val.split(':');
              return { targetType: parts[0], targetId: parts[1] };
            });
          }
        } else if (composerTargetType === 'custom') {
          const targetType = document.getElementById('composerCustomType')?.value || 'group';
          const rawInput = document.getElementById('composerCustomId')?.value || '';
          const ids = rawInput.split(',').map(s => s.trim()).filter(Boolean);
          targets = ids.map(id => ({ targetType, targetId: id }));
        }

        if (targets.length === 0 || !text.trim()) {
          return showToast(t('Chọn ít nhất một target và nhập nội dung trước khi gửi.', 'Choose at least one target and enter content before sending.'), 'warning');
        }

        const canBulk = !!(state?.license?.canBulk);
        if (targets.length > 1 && !canBulk) {
          return showToast(t('Gửi tin nhắn hàng loạt chỉ dành cho tài khoản PRO. Vui lòng nâng cấp!', 'Bulk messaging is only for PRO accounts. Please upgrade!'), 'warning');
        }

        const ok = await openModal({
          title: t('Xác nhận gửi tin', 'Confirm Message'),
          desc: t(`Gửi tin nhắn tới ${targets.length} mục.`, `Send message to ${targets.length} targets.`),
          body: `
              <div class="item-sub" style="word-break: break-all; margin-bottom: 12px; background: var(--bg); padding: 8px; border-radius: 4px;">${esc(text.slice(0, 280))}</div>
              <div style="font-size: 12px; color: var(--text-muted);">${t('Rate limit an toàn sẽ được áp dụng tự động.', 'Safe rate limits will be applied automatically.')}</div>
            `,
          confirmText: t('Gửi', 'Send'),
        });

        if (!ok) return;

        showToast(t('Bắt đầu gửi tin nhắn...', 'Starting bulk sending...'), 'info');

        let successCount = 0;
        let failCount = 0;
        try {
          if (targets.length === 1) {
            await runAction('send-message', { ...targets[0], text }, null);
            successCount = 1;
          } else {
            const result = await runAction('send-messages', { targets, text }, null);
            successCount = Number(result?.sent || targets.length);
          }
        } catch (err) {
          console.error(err);
          failCount = targets.length;
        }

        showToast(t(`Gửi hoàn tất: Thành công ${successCount}, Lỗi ${failCount}`, `Sending complete: Success ${successCount}, Fail ${failCount}`), failCount > 0 ? 'warning' : 'success');
      }
      if (action === 'member-form-action') {
        const form = document.querySelector('#members form');
        const groupId = form?.querySelector('select')?.value;
        const userId = form?.querySelector('input')?.value.trim();
        const actionText = form?.querySelectorAll('select')?.[1]?.value || '';
        if (!groupId || !userId) return showToast(t('Chọn group và nhập userId trước.', 'Select a group and enter userId first.'), 'warning');
        if (actionText === 'approve') await runAction('review-pending', { groupId, members: userId, approve: true }, t('Đã gửi lệnh duyệt member', 'Approve request sent'));
        else if (actionText === 'reject') await runAction('review-pending', { groupId, members: userId, approve: false }, t('Đã gửi lệnh từ chối member', 'Reject request sent'));
        else if (actionText === 'remove') {
          const ok = await openModal({ title: t('Xác nhận kick', 'Confirm kick'), desc: t(`Kick ${userId} khỏi group ${groupId}.`, `Kick ${userId} from group ${groupId}.`), body: `<label>${t('Nhập KICK', 'Type KICK')}<input id="formKickConfirm"></label>`, confirmText: 'Kick', danger: true });
          if (ok && document.getElementById('formKickConfirm')?.value === 'KICK') await runAction('remove-user', { groupId, userId }, t('Đã gửi lệnh kick member', 'Kick request sent'));
        }
        else if (actionText === 'block') await runAction('block-member', { groupId, userId }, t('Đã gửi lệnh block member', 'Block request sent'));
        else if (actionText === 'invite') await runAction('send-friend-request', { userId, message: 'Xin chào, mình là Williams bot owner.' }, t('Đã gửi lời mời kết bạn', 'Friend request sent'));
      }
    }
  } catch (error) {
    if (!/Action failed|Thao tác lỗi/.test(String(error.message || ''))) {
      showToast(`${t('Thao tác lỗi', 'Action failed')} - ${error.message || error}`, 'error');
    }
  } finally {
    activeActionButton = null;
  }
});
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const sidebar = document.querySelector('.sidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');

if (mobileMenuBtn && sidebar && sidebarBackdrop) {
  mobileMenuBtn.addEventListener('click', () => {
    sidebar.classList.add('open');
    sidebarBackdrop.classList.add('open');
  });

  const closeMobileMenu = () => {
    sidebar.classList.remove('open');
    sidebarBackdrop.classList.remove('open');
  };

  sidebarBackdrop.addEventListener('click', closeMobileMenu);

  // Close mobile menu when nav link is clicked
  sidebar.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', closeMobileMenu);
  });
}

// Toggle custom select dropdown
const selectContainer = document.getElementById('membersGroupSelectContainer');
const selectTrigger = document.getElementById('membersGroupSelectTrigger');
if (selectTrigger && selectContainer) {
  selectTrigger.addEventListener('click', event => {
    event.stopPropagation();
    selectContainer.classList.toggle('open');
    const botContainer = document.getElementById('membersBotSelectContainer');
    if (botContainer) botContainer.classList.remove('open');
    const groupsBotContainer = document.getElementById('groupsBotSelectContainer');
    if (groupsBotContainer) groupsBotContainer.classList.remove('open');
    const topbarContainer = document.getElementById('topbarBotSelectContainer');
    if (topbarContainer) topbarContainer.classList.remove('open');
  });
}

// Chọn ngày bằng input date trong section Nhật ký
document.addEventListener('change', event => {
  if (event.target && event.target.id === 'journalDateInput') {
    journalPickDate(event.target.value);
  }
});

// Đặt theme (dùng chung nút topbar + section Cài đặt)
function setTheme(next) {
  document.documentElement.dataset.theme = next;
  localStorage.setItem('zaloDashboardTheme', next);
  syncChromeState();
  if (document.getElementById('settings')?.classList.contains('active')) renderSettings();
  showToast(next === 'dark' ? t('Đã bật dark mode', 'Dark mode enabled') : t('Đã chuyển sang light mode', 'Light mode enabled'), 'success');
}
// Đặt ngôn ngữ (dùng chung nút topbar + section Cài đặt)
function setLang(next) {
  if (next === lang) return;
  lang = next;
  localStorage.setItem('zaloDashboardLang', lang);
  applyI18n();
  if (state) renderState();
  if (document.getElementById('permissions')?.classList.contains('active') && permState.data) rebuildPermCards();
  if (document.getElementById('journal')?.classList.contains('active')) renderJournal();
  if (document.getElementById('settings')?.classList.contains('active')) renderSettings();
  if (document.getElementById('contacts')?.classList.contains('active')) renderCrmContacts();
  if (document.getElementById('leads')?.classList.contains('active')) renderCrmLeads();
  if (document.getElementById('tasks')?.classList.contains('active')) renderCrmTasks();
  showToast(lang === 'vi' ? 'Ngôn ngữ: Tiếng Việt' : 'Language: English', 'info');
}
const themeToggle = document.getElementById('themeToggle');
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'light';
    setTheme(current === 'dark' ? 'light' : 'dark');
  });
}
const langToggle = document.getElementById('langToggle');
if (langToggle) {
  langToggle.addEventListener('click', () => setLang(lang === 'vi' ? 'en' : 'vi'));
}

const ownerPill = document.getElementById('ownerPill');
if (ownerPill) {
  ownerPill.addEventListener('click', event => {
    event.stopPropagation();
    ownerPill.classList.toggle('open');
    const groupContainer = document.getElementById('membersGroupSelectContainer');
    if (groupContainer) groupContainer.classList.remove('open');
    const botContainer = document.getElementById('membersBotSelectContainer');
    if (botContainer) botContainer.classList.remove('open');
    const groupsBotContainer = document.getElementById('groupsBotSelectContainer');
    if (groupsBotContainer) groupsBotContainer.classList.remove('open');
    const topbarBotContainer = document.getElementById('topbarBotSelectContainer');
    if (topbarBotContainer) topbarBotContainer.classList.remove('open');
  });
}

document.addEventListener('click', () => {
  const groupContainer = document.getElementById('membersGroupSelectContainer');
  if (groupContainer) groupContainer.classList.remove('open');
  const botContainer = document.getElementById('membersBotSelectContainer');
  if (botContainer) botContainer.classList.remove('open');
  const groupsBotContainer = document.getElementById('groupsBotSelectContainer');
  if (groupsBotContainer) groupsBotContainer.classList.remove('open');
  const topbarBotContainer = document.getElementById('topbarBotSelectContainer');
  if (topbarBotContainer) topbarBotContainer.classList.remove('open');
  const jGroupContainer = document.getElementById('journalGroupSelectContainer');
  if (jGroupContainer) jGroupContainer.classList.remove('open');
  if (ownerPill) ownerPill.classList.remove('open');
});

// Group select dropdown for Members
document.getElementById('membersGroupSelect').addEventListener('change', event => {
  activeGroupId = event.target.value;
  renderMembers();
});

// Member filter tabs listener
document.querySelectorAll('#membersFilterTabs button').forEach(btn => {
  btn.addEventListener('click', event => {
    const filter = event.currentTarget.dataset.memberFilter;
    if (!filter) return;
    currentMemberFilter = filter;
    currentMembersPage = 1;
    document.querySelectorAll('#membersFilterTabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.memberFilter === currentMemberFilter);
    });
    renderMembers();
  });
});

document.getElementById('search').addEventListener('input', event => {
  const activeSection = sections.find(s => s.classList.contains('active'))?.id;
  if (activeSection === 'members') {
    currentMembersPage = 1;
    renderMembers();
    return;
  }
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll('tbody tr, .member-card, .api-card').forEach(row => {
    row.style.display = !query || row.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
});
modalCancel.addEventListener('click', () => closeModal(false));
modalConfirm.addEventListener('click', () => closeModal(true));
modalBackdrop.addEventListener('click', event => {
  if (event.target === modalBackdrop) closeModal(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && modalBackdrop.classList.contains('open')) closeModal(false);
});


// Collapsible sidebar logic
const sidebarElement = document.querySelector('.sidebar');
const collapseBtn = document.getElementById('sidebarCollapseBtn');

if (sidebarElement && collapseBtn) {
  const isCollapsed = localStorage.getItem('zaloSidebarCollapsed') === 'true';
  if (isCollapsed) {
    sidebarElement.classList.add('collapsed');
  }

  collapseBtn.addEventListener('click', () => {
    sidebarElement.classList.toggle('collapsed');
    const collapsed = sidebarElement.classList.contains('collapsed');
    localStorage.setItem('zaloSidebarCollapsed', String(collapsed));
  });
}

// Bottom-nav drawer menu logic for mobile/tablet
const openMenuBtn = document.querySelector('[data-open-menu]');
const drawerBackdrop = document.querySelector('.drawer-backdrop');
const drawerElement = document.querySelector('.drawer');

if (openMenuBtn && drawerBackdrop && drawerElement) {
  openMenuBtn.addEventListener('click', () => {
    drawerElement.classList.add('open');
    drawerBackdrop.classList.add('open');
  });

  const closeDrawer = () => {
    drawerElement.classList.remove('open');
    drawerBackdrop.classList.remove('open');
  };

  drawerBackdrop.addEventListener('click', closeDrawer);

  const drawerNav = document.querySelector('[data-drawer-nav]');
  if (drawerNav) {
    drawerNav.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        setSection(btn.dataset.section);
        closeDrawer();
      });
    });
  }
}

// ── Templates Management ─────────────────────────────────────
let activeTemplateKey = 'noi-quy';

function renderTemplates() {
  if (!state || !state.templates) return;
  
  // 1. Update left pane active class
  document.querySelectorAll('#templates .template-item').forEach(item => {
    const key = item.dataset.templateKey;
    item.classList.toggle('active', key === activeTemplateKey);
  });
  
  // 2. Update editor headers
  const titleEl = document.getElementById('current-template-title');
  const fileEl = document.getElementById('current-template-file');
  
  const titles = {
    'noi-quy': t('Nội quy nhóm', 'Group Rules'),
    'huong-dan': t('Hướng dẫn dùng bot', 'Bot Manual'),
    'menu': t('Menu lệnh', 'Slash Commands Menu'),
    'welcome': t('Chào mừng thành viên', 'Welcome Message'),
    'spam-warning': t('Cảnh báo spam link', 'Spam Link Warning'),
    'maintenance': t('Thông báo bảo trì bot', 'Maintenance Notice')
  };

  titleEl.textContent = titles[activeTemplateKey] || activeTemplateKey;
  fileEl.textContent = `${activeTemplateKey}.txt`;

  // 3. Set text content
  const textarea = document.getElementById('template-textarea');
  textarea.value = state.templates[activeTemplateKey] || '';

  // 3b. Custom slash command binding
  const cmdInput = document.getElementById('template-command');
  const cmdPrefixEl = document.getElementById('template-command-prefix');
  const cmds = state.templateCommands || {};
  const prefix = (state.bot && state.bot.cmdPrefix) || '/bot-';
  if (cmdInput) cmdInput.value = cmds[activeTemplateKey] || '';
  if (cmdPrefixEl) cmdPrefixEl.textContent = prefix;
  updateTemplateCmdHint();

  // 4. Custom modes only shown for menu; memberName only for welcome / spam-warning
  document.querySelectorAll('#templates .var-menu-only').forEach(el => {
    el.style.display = (activeTemplateKey === 'menu') ? 'inline-flex' : 'none';
  });
  document.querySelectorAll('#templates .var-member-only').forEach(el => {
    el.style.display = (activeTemplateKey === 'welcome' || activeTemplateKey === 'spam-warning') ? 'inline-flex' : 'none';
  });
}

function updateTemplateCmdHint() {
  const cmdInput = document.getElementById('template-command');
  const cmdHintEl = document.getElementById('template-command-hint');
  if (!cmdHintEl) return;
  const prefix = (state && state.bot && state.bot.cmdPrefix) || '/bot-';
  const w = (cmdInput && cmdInput.value.trim().toLowerCase().replace(/^\/+/, '').replace(/[^a-z0-9-]/g, '')) || '';
  cmdHintEl.textContent = w
    ? t('Gõ ', 'Type ') + prefix + w + t(' trong nhóm để bot gửi template này.', ' in the group to send this template.')
    : t('Để trống nếu không muốn gán lệnh slash cho template này.', 'Leave empty to not bind a slash command.');
}

function initTemplatesEditor() {
  // Bind left sidebar select
  document.querySelectorAll('#templates .template-item').forEach(item => {
    item.addEventListener('click', () => {
      activeTemplateKey = item.dataset.templateKey;
      renderTemplates();
    });
  });
  
  // Bind cheatsheet tags click to insert at cursor
  document.querySelectorAll('#templates .var-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const varText = tag.dataset.var;
      const textarea = document.getElementById('template-textarea');
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;
      textarea.value = text.substring(0, start) + varText + text.substring(end);
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + varText.length;
    });
  });
  
  // Live-update the slash-command hint as the owner types
  const cmdInputEl = document.getElementById('template-command');
  if (cmdInputEl) cmdInputEl.addEventListener('input', updateTemplateCmdHint);

  // Bind save button
  const saveBtn = document.getElementById('btn-save-template');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const textarea = document.getElementById('template-textarea');
      const content = textarea.value;
      const cmdInput = document.getElementById('template-command');
      const command = cmdInput ? cmdInput.value : '';

      setButtonLoading(saveBtn, true);
      try {
        const res = await api('/api/action', {
          method: 'POST',
          body: JSON.stringify({
            action: 'save-templates',
            payload: { key: activeTemplateKey, content, command }
          })
        });
        if (res.ok) {
          showToast(t('Lưu template thành công!', 'Template saved successfully!'), 'success');
          // Update in local state object too
          state.templates[activeTemplateKey] = content;
          state.templateCommands = state.templateCommands || {};
          if (res.command !== undefined) state.templateCommands[activeTemplateKey] = res.command;
          renderTemplates();
        } else {
          showToast(res.error || t('Có lỗi xảy ra!', 'An error occurred!'), 'error');
        }
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        setButtonLoading(saveBtn, false);
      }
    });
  }
  
  // Bind preview button
  const previewBtn = document.getElementById('btn-preview-template');
  const previewModal = document.getElementById('previewModalBackdrop');
  const previewBody = document.getElementById('previewModalBody');
  
  if (previewBtn && previewModal && previewBody) {
    previewBtn.addEventListener('click', () => {
      const textarea = document.getElementById('template-textarea');
      let text = textarea.value;
      
      // Replace dummy variables
      const dummyVars = {
        groupName: t('Nhóm Cứu Hộ Thế Giới 🌍', 'World Rescue Group 🌍'),
        botName: state.bot?.name || 'Mkt Bot',
        BOTNAME: String(state.bot?.name || 'Mkt Bot').toUpperCase(),
        cmdPrefix: state.bot?.cmdPrefix || '/bot-',
        memberName: t('Minh (thành viên mới)', 'Minh (new member)')
      };
      
      for (const [k, v] of Object.entries(dummyVars)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
      
      // If it is menu, mock the custom modes
      if (activeTemplateKey === 'menu') {
        const dummyModesText = [
          t('🧩 Chế độ (Custom Modes):', '🧩 Custom Modes:'),
          `  ${dummyVars.cmdPrefix}bot-tieng-anh-on   — ${t('Bật Luyện tiếng Anh', 'Enable English Practice')}`,
          `  ${dummyVars.cmdPrefix}bot-tieng-anh-off  — ${t('Tắt Luyện tiếng Anh', 'Disable English Practice')}`,
          `  ${dummyVars.cmdPrefix}bot-nhac-nho-on    — ${t('Bật Nhắc nhở', 'Enable Reminders')}`,
          `  ${dummyVars.cmdPrefix}bot-nhac-nho-off   — ${t('Tắt Nhắc nhở', 'Disable Reminders')}`
        ].join('\n');
        
        if (text.includes('{customModes}')) {
          text = text.replace(/\{customModes\}/g, dummyModesText);
        } else {
          text += '\n\n' + dummyModesText;
        }
      }
      
      previewBody.textContent = text;
      previewModal.classList.add('open');
    });
  }
  
  // Bind preview close
  const previewClose = document.getElementById('previewModalClose');
  if (previewClose && previewModal) {
    previewClose.addEventListener('click', () => {
      previewModal.classList.remove('open');
    });
  }
}

applyI18n();
initTemplatesEditor();
loadState().catch(error => showToast(error.message, 'error'));

// Responsive sub-topbar padding-top resize listener
window.addEventListener('resize', () => {
  if (state && state.bots && state.bots.length > 1) {
    document.body.classList.toggle('has-sub-topbar', window.innerWidth <= 991);
  } else {
    document.body.classList.remove('has-sub-topbar');
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// CRM MODULE — Contacts / Leads pipeline / Tasks (Phase Z4 core)
// Backend: src/crm/ qua POST /api/action { action: 'crm-*', payload }
// ═══════════════════════════════════════════════════════════════════════════

const crmState = {
  contacts: null, contactsTotal: 0, contactsPage: 1, contactsSearch: '', contactsTag: '',
  contactsGroup: '', contactsLinked: '', contactsGender: '', contactsFriend: '', contactsBirthday: '',
  contactsSource: '', contactsSort: '',
  // Danh mục nhãn nạp MỘT lần rồi dùng lại: mỗi dòng cần màu của nhãn, hỏi server theo từng dòng
  // là 500 lượt gọi cho một trang.
  tags: null,
  // Chọn hàng loạt giữ theo id chứ không theo chỉ số dòng — đổi bộ lọc là chỉ số lệch hết, và
  // "xoá 500 người" mà lệch thì không sửa lại được.
  selected: new Set(),
  contactsBot: null,
  // Một dòng đã gộp đại diện cho NHIỀU bản ghi (mỗi bot một cái). Nhớ lại ánh xạ khi vẽ, vì lựa
  // chọn trải nhiều trang mà `crmState.contacts` chỉ giữ trang hiện tại — thiếu nó thì "gắn nhãn
  // cho người này" chỉ gắn cho bản ghi của một bot.
  mergedMap: new Map(),
  pipeline: null, tasks: null, taskFilter: 'open', undoLead: null,
};
const CRM_PAGE_SIZE = 50;
const CRM_STAGE_LABELS = {
  new: ['Mới', 'New'], contacted: ['Đã liên hệ', 'Contacted'],
  qualified: ['Tiềm năng', 'Qualified'], quoted: ['Đã báo giá', 'Quoted'],
  won: ['Thắng', 'Won'], lost: ['Thua', 'Lost'],
};
const CRM_STAGE_COLORS = {
  new: 'var(--muted)', contacted: 'var(--primary)', qualified: '#8b5cf6',
  quoted: 'var(--warning)', won: 'var(--success)', lost: 'var(--danger)',
};

async function crmAction(action, payload = {}) {
  const data = await api('/api/action', {
    method: 'POST',
    body: JSON.stringify({ action, payload }),
  });
  return data.result;
}

function crmStageLabel(stage) {
  const pair = CRM_STAGE_LABELS[stage] || [stage, stage];
  return t(pair[0], pair[1]);
}

function crmMoney(v, currency = 'VND') {
  if (!v) return '—';
  try {
    return new Intl.NumberFormat('vi-VN').format(v) + (currency === 'VND' ? 'đ' : ` ${currency}`);
  } catch (_) { return String(v); }
}

function crmEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function crmDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function crmErrorCard(container, err, retryFn) {
  container.innerHTML = `<div class="card" style="padding:24px;text-align:center">
    <p style="color:var(--danger);margin:0 0 12px">${crmEsc(err.message || err)}</p>
    <button class="btn" id="crmRetryBtn">${t('Thử lại', 'Retry')}</button></div>`;
  container.querySelector('#crmRetryBtn')?.addEventListener('click', retryFn);
}

// ── Contacts ────────────────────────────────────────────────────────────────

async function renderCrmContacts() {
  const head = document.querySelector('#contacts .page-head');
  if (head) {
    head.querySelector('h2').textContent = t('Liên hệ', 'Contacts');
    head.querySelector('p').textContent = t(
      'Bạn bè và khách hàng chưa kết bạn, gộp chung một chỗ — nhãn Zalo, sinh nhật, nhóm, liên kết lead.',
      'Friends and not-yet-friend customers in one place — Zalo labels, birthdays, groups, lead links.');
  }
  const actions = document.getElementById('crmContactsActions');
  // Không còn nút "Import từ Zalo" và "Đồng bộ nhãn Zalo": cả hai kéo dữ liệu từ chính tài khoản
  // Zalo, đúng việc mà "Sync account" ở Tổng quan đã làm — hai nút riêng chỉ khiến owner phải nhớ
  // bấm ba chỗ thì danh sách mới đầy đủ. Nay sync account tự làm cả ba. Chỗ này để dành cho việc
  // mà sync KHÔNG làm được: đưa danh sách khách có sẵn từ ngoài vào, và mang dữ liệu ra.
  actions.innerHTML = `
    <button class="btn" id="crmCsvImportBtn">${t('⬆ Nhập CSV', '⬆ Import CSV')}</button>
    <button class="btn" id="crmCsvExportBtn">${t('⬇ Tải CSV', '⬇ Export CSV')}</button>
    <button class="btn primary" id="crmAddContactBtn">${t('+ Thêm liên hệ', '+ Add contact')}</button>`;
  actions.querySelector('#crmCsvImportBtn').addEventListener('click', crmImportCsv);
  actions.querySelector('#crmCsvExportBtn').addEventListener('click', crmExportCsv);
  actions.querySelector('#crmAddContactBtn').addEventListener('click', () => crmContactModal(null));
  crmRenderFriendOps();

  const body = document.getElementById('crmContactsBody');
  body.innerHTML = `<div class="card" style="padding:24px;color:var(--muted)">${t('Đang tải…', 'Loading…')}</div>`;

  // Mỗi bot có bảng liên hệ riêng (Zalo cấp uid khác nhau cho cùng một người), nên đổi bot là đổi
  // hẳn tập dữ liệu: giữ nguyên lựa chọn hàng loạt hay số trang sẽ trỏ vào id của bot cũ.
  const bot = selBotProfile();
  if (crmState.contactsBot !== bot) {
    crmState.contactsBot = bot;
    crmState.selected.clear();
    crmState.contactsPage = 1;
  }
  // Không chọn bot cụ thể + có nhiều bot → gộp trùng ở tầng hiển thị, không thì cùng một người
  // hiện hai dòng vì hai uid.
  const mergePeople = !bot && (state.bots || []).length > 1;

  try {
    // Danh mục nhãn và danh sách liên hệ độc lập nhau → gọi song song, đỡ một vòng chờ.
    const [res, tagsRes] = await Promise.all([
      crmAction('crm-contacts-list', {
        search: crmState.contactsSearch || undefined,
        tag: crmState.contactsTag || undefined,
        groupId: crmState.contactsGroup || undefined,
        linked: crmState.contactsLinked || undefined,
        gender: crmState.contactsGender || undefined,
        friend: crmState.contactsFriend || undefined,
        source: crmState.contactsSource || undefined,
        sort: crmState.contactsSort || undefined,
        accountId: bot || undefined,
        mergePeople: mergePeople || undefined,
        birthdayWithin: crmState.contactsBirthday ? Number(crmState.contactsBirthday) : undefined,
        limit: CRM_PAGE_SIZE,
        offset: (crmState.contactsPage - 1) * CRM_PAGE_SIZE,
      }),
      crmState.tags ? Promise.resolve(null) : crmAction('crm-tags'),
    ]);
    if (tagsRes) crmState.tags = tagsRes.tags;
    for (const c of res.contacts) {
      if (c.mergedIds?.length > 1) crmState.mergedMap.set(c.id, c.mergedIds);
    }
    crmState.contacts = res.contacts;
    crmState.contactsTotal = res.total;
    crmRenderContactsTable(body);
  } catch (err) {
    crmErrorCard(body, err, renderCrmContacts);
  }
}

/**
 * Ngày sinh thô của Zalo (`sdob`) → `DD/MM` để đọc.
 *
 * Không parse được thì trả nguyên chuỗi thay vì `—`: hồ sơ ghi "tháng 5" vẫn là thông tin,
 * nuốt đi thì owner tưởng hệ thống không có gì.
 */
function crmBirthdayLabel(raw) {
  if (!raw) return '';
  const str = String(raw).trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(str);
  if (iso) return `${String(iso[3]).padStart(2, '0')}/${String(iso[2]).padStart(2, '0')}`;
  const vn = /^(\d{1,2})[-/](\d{1,2})(?:[-/]\d{2,4})?$/.exec(str);
  if (vn) {
    let d = Number(vn[1]), m = Number(vn[2]);
    if (m > 12 && d <= 12) [d, m] = [m, d];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
  }
  return str;
}

function crmGenderLabel(g) {
  if (g === 'male') return t('Nam', 'Male');
  if (g === 'female') return t('Nữ', 'Female');
  return '';
}

/**
 * Chip nhãn lấy màu từ danh mục Zalo.
 *
 * Màu của Zalo là mã đặc (`#d91b1b`) — dùng nguyên làm nền thì chữ đen trên đỏ đặc, đọc không nổi.
 * Đổ nền bằng `color-mix` cho nhạt đi và giữ chữ theo đúng màu nhãn, nên 6 nhãn vẫn phân biệt được
 * bằng mắt ở cả nền sáng lẫn nền tối. Nhãn chưa có trong danh mục (gõ tay từ trước) rơi về chip xám
 * mặc định thay vì biến mất.
 */
function crmTagChip(tag, { clickable = true } = {}) {
  const meta = (crmState.tags || []).find(x => x.name === tag);
  const color = meta?.color && /^#[0-9a-f]{3,8}$/i.test(meta.color) ? meta.color : '';
  const style = color
    ? `background:color-mix(in srgb, ${color} 16%, transparent);color:${color};border:1px solid color-mix(in srgb, ${color} 34%, transparent)`
    : '';
  return `<span class="chip"${clickable ? ` data-crm-tag="${crmEsc(tag)}"` : ''}
    style="${clickable ? 'cursor:pointer;' : ''}${style}">${meta?.emoji ? `${crmEsc(meta.emoji)} ` : ''}${crmEsc(tag)}</span>`;
}

const CRM_SOURCE_LABELS = {
  'zalo-group': ['Từ nhóm Zalo', 'From Zalo group'],
  'zalo-friend': ['Bạn bè Zalo', 'Zalo friend'],
};
function crmSourceLabel(src) {
  const pair = CRM_SOURCE_LABELS[src];
  return pair ? t(pair[0], pair[1]) : (src || '—');
}

function crmRenderContactsTable(body) {
  const rows = crmState.contacts || [];
  const totalPages = Math.max(Math.ceil(crmState.contactsTotal / CRM_PAGE_SIZE), 1);
  const sel = crmState.selected;
  const pageIds = rows.map(c => c.id);
  // Chỉ gắn badge bot khi thật sự có nhiều bot — một bot thì badge chỉ là nhiễu.
  const showBotBadge = (state.bots || []).length > 1;
  const allOnPage = pageIds.length > 0 && pageIds.every(id => sel.has(id));
  const rowsHtml = rows.map(c => `
    <tr data-contact-id="${crmEsc(c.id)}">
      <td style="width:34px"><input type="checkbox" data-crm-pick-row="${crmEsc(c.id)}"
        ${sel.has(c.id) ? 'checked' : ''} style="width:auto;min-height:0;margin:0"></td>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          ${c.avatar_url
            ? `<img src="${crmEsc(c.avatar_url)}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover">`
            : `<span style="width:32px;height:32px;border-radius:50%;background:var(--primary-soft);color:var(--primary-deep);display:inline-flex;align-items:center;justify-content:center;font-weight:600">${crmEsc((c.display_name || '?')[0].toUpperCase())}</span>`}
          <div style="min-width:0">
            <div style="font-weight:600">${crmEsc(c.display_name)}${c.is_friend
              ? ` <span class="chip" title="${t('Đã kết bạn Zalo — nhắn riêng được', 'Zalo friend — can DM')}"
                  style="font-size:10px;background:rgba(52,211,153,.16);vertical-align:middle">${t('bạn bè', 'friend')}</span>`
              : ''}${showBotBadge && (c.accounts?.length || c.account_id)
              ? ` <span title="${t('Bot đang có liên hệ này', 'Bots holding this contact')}"
                  style="vertical-align:middle">${getBotBadge((c.accounts || [c.account_id]).join(','))}</span>`
              : ''}</div>
            ${/* Nói rõ ai CHƯA nối được với người Zalo — đó là liên hệ không mở được lịch sử chat,
                  tức phần dữ liệu vẫn là sổ tay gõ tay. */''}
            <div style="color:var(--muted);font-size:12px">${c.zalo_uid
              ? `🔗 ${crmEsc(c.zalo_uid)}`
              : `<span style="opacity:.8">${t('chưa nối Zalo', 'not linked')}</span>`}</div>
            ${/* Nhãn Zalo nằm NGAY dưới tên: nó là cách owner đã tự phân loại người này, nên phải
                  đọc được cùng lúc với tên. Trước đó nhãn ở một cột riêng tít bên phải trong khi
                  cột tên thừa cả một khoảng trống. */''}
            ${(c.tags || []).length ? `<div class="chips" style="margin-top:4px">${
              (c.tags || []).map(tag => crmTagChip(tag)).join('')}</div>` : ''}
          </div>
        </div>
      </td>
      <td>${(c.groups || []).length
        ? `<div class="chips">${(c.groups || []).slice(0, 3).map(g =>
            `<span class="chip" data-crm-group-filter="${crmEsc(g.groupId)}" title="${crmEsc(g.name)}"
              style="cursor:pointer;font-size:10.5px;background:rgba(96,165,250,.14)">${crmEsc(g.name)}</span>`).join('')}${
            (c.groups || []).length > 3
              ? `<span class="chip" style="font-size:10.5px" title="${crmEsc((c.groups || []).slice(3).map(g => g.name).join(', '))}">+${(c.groups || []).length - 3}</span>`
              : ''}</div>`
        : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${crmEsc(c.phone || '—')}</td>
      ${/* Cột hồ sơ: ngày sinh + giới tính. Đây là hai trường khiến danh sách "đầy" và lọc được —
            trước 2.28 chúng không tồn tại nên mọi bộ lọc đều lọc trên bảng trống. */''}
      <td style="white-space:nowrap">${(() => {
        const bd = crmBirthdayLabel(c.birthday);
        const g = crmGenderLabel(c.gender);
        if (!bd && !g) return '<span style="color:var(--muted)">—</span>';
        const soon = c.birthdayInDays != null && c.birthdayInDays <= 30
          ? `<span style="color:var(--primary-deep);font-size:11px"> · ${c.birthdayInDays === 0
              ? t('hôm nay!', 'today!') : t(`còn ${c.birthdayInDays} ngày`, `in ${c.birthdayInDays}d`)}</span>`
          : '';
        return `${bd ? `🎂 ${crmEsc(bd)}${soon}` : ''}${bd && g ? '<br>' : ''}${g ? `<span style="color:var(--muted);font-size:12px">${crmEsc(g)}</span>` : ''}`;
      })()}</td>
      <td style="white-space:nowrap"><span class="chip" style="background:rgba(148,163,184,.16)">${crmEsc(crmSourceLabel(c.source))}</span></td>
      ${/* Thao tác đặt ngay cạnh người: mở dashboard ra để nhắn cho một khách mà phải sang trang
            Tin nhắn rồi tự dò lại uid thì không ai làm. Nút chỉ hiện khi đã nối được người Zalo —
            không có uid thì cả nhắn tin lẫn kết bạn đều vô nghĩa. */''}
      <td style="white-space:nowrap;text-align:right">
        <div class="crm-row-actions">
          ${c.zalo_uid ? `<button class="btn" data-crm-dm="${crmEsc(c.id)}" title="${t('Nhắn tin riêng', 'Send DM')}">💬</button>
          ${c.is_friend ? '' : `<button class="btn" data-crm-addfriend="${crmEsc(c.id)}" title="${t('Gửi lời mời kết bạn', 'Send friend request')}">➕</button>`}` : ''}
          <button class="btn" data-crm-edit="${crmEsc(c.id)}">${t('Sửa', 'Edit')}</button>
          <button class="btn danger" data-crm-del="${crmEsc(c.id)}">✕</button>
        </div>
      </td>
    </tr>`).join('');

  body.innerHTML = `
    <div class="crm-toolbar">
      <input type="search" id="crmContactSearch" class="crm-search" placeholder="${t('Tìm tên / SĐT / UID…', 'Search name / phone / UID…')}" value="${crmEsc(crmState.contactsSearch)}">
      ${/* Nhãn đang lọc hiện ngay trong <select id="crmTagFilter">, nên bỏ chip "🏷 … ✕" cũ —
            hai chỗ cùng nói một trạng thái thì sửa một chỗ là lệch. */''}
      ${crmState.contactsGroup ? `<span class="chip" id="crmGroupClear" style="cursor:pointer;background:rgba(96,165,250,.16)">👥 ${crmEsc(
        (state.groups || []).find(g => g.groupId === crmState.contactsGroup)?.name || crmState.contactsGroup)} ✕</span>` : ''}
      <select id="crmLinkedFilter" class="crm-filter-select">
        <option value="">${t('Nối Zalo', 'Zalo link')}</option>
        <option value="only" ${crmState.contactsLinked === 'only' ? 'selected' : ''}>${t('Đã nối Zalo', 'Linked')}</option>
        <option value="none" ${crmState.contactsLinked === 'none' ? 'selected' : ''}>${t('Chưa nối Zalo', 'Not linked')}</option>
      </select>
      <select id="crmFriendFilter" class="crm-filter-select">
        <option value="">${t('Kết bạn', 'Friend')}</option>
        <option value="only" ${crmState.contactsFriend === 'only' ? 'selected' : ''}>${t('Đã kết bạn', 'Friends')}</option>
        <option value="none" ${crmState.contactsFriend === 'none' ? 'selected' : ''}>${t('Chưa kết bạn', 'Not friends')}</option>
      </select>
      <select id="crmGenderFilter" class="crm-filter-select">
        <option value="">${t('Giới tính', 'Gender')}</option>
        <option value="male" ${crmState.contactsGender === 'male' ? 'selected' : ''}>${t('Nam', 'Male')}</option>
        <option value="female" ${crmState.contactsGender === 'female' ? 'selected' : ''}>${t('Nữ', 'Female')}</option>
      </select>
      ${/* Sinh nhật sắp tới là lý do chính owner mở CRM ra hằng tuần — để nó ngay trên thanh lọc,
            không giấu trong menu. */''}
      <select id="crmBirthdayFilter" class="crm-filter-select">
        <option value="">${t('Sinh nhật', 'Birthday')}</option>
        <option value="0" ${crmState.contactsBirthday === '0' ? 'selected' : ''}>🎂 ${t('Hôm nay', 'Today')}</option>
        <option value="7" ${crmState.contactsBirthday === '7' ? 'selected' : ''}>🎂 ${t('7 ngày tới', 'Next 7 days')}</option>
        <option value="30" ${crmState.contactsBirthday === '30' ? 'selected' : ''}>🎂 ${t('30 ngày tới', 'Next 30 days')}</option>
      </select>
      ${/* Bộ lọc Nhãn dựng từ danh mục, kèm số liên hệ — owner thấy ngay nhãn nào còn dùng, nhãn
            nào rỗng. Nhãn Zalo hiện màu ngay trong <option> không được, nên gắn emoji phía trước. */''}
      <select id="crmTagFilter" class="crm-filter-select">
        <option value="">${t('Nhãn', 'Label')}</option>
        ${(crmState.tags || []).map(tg => `<option value="${crmEsc(tg.name)}" ${crmState.contactsTag === tg.name ? 'selected' : ''}>
          ${tg.emoji ? `${crmEsc(tg.emoji)} ` : '🏷 '}${crmEsc(tg.name)} (${tg.n})</option>`).join('')}
      </select>
      <select id="crmSourceFilter" class="crm-filter-select">
        <option value="">${t('Loại', 'Type')}</option>
        <option value="zalo-friend" ${crmState.contactsSource === 'zalo-friend' ? 'selected' : ''}>${t('Bạn bè Zalo', 'Zalo friend')}</option>
        <option value="zalo-group" ${crmState.contactsSource === 'zalo-group' ? 'selected' : ''}>${t('Từ nhóm Zalo', 'From Zalo group')}</option>
      </select>
      <select id="crmSortSelect" class="crm-filter-select">
        <option value="">${t('Mới nhất', 'Newest')}</option>
        <option value="name" ${crmState.contactsSort === 'name' ? 'selected' : ''}>${t('Tên A → Z', 'Name A → Z')}</option>
      </select>
      <span style="margin-left:auto;color:var(--muted);font-size:13px">${t(`${crmState.contactsTotal} liên hệ`, `${crmState.contactsTotal} contacts`)}</span>
    </div>
    ${/* Vùng chứa CỐ ĐỊNH cho thanh Thao tác: tick một ô chỉ vẽ lại đúng thanh này, không vẽ lại
          cả bảng. Vẽ lại cả bảng thì 500 dòng bị dựng lại mỗi lần tick — giật, nhảy vị trí cuộn,
          và ô vừa định tick tiếp đã là một node khác. */''}
    <div id="crmBulkHost"></div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th style="width:34px"><input type="checkbox" id="crmPickAll" ${allOnPage ? 'checked' : ''}
              title="${t('Chọn cả trang này', 'Select this page')}" style="width:auto;min-height:0;margin:0"></th>
            <th>${t('Liên hệ', 'Contact')}</th>
            <th>${t('Nhóm', 'Groups')}</th>
            <th>${t('SĐT', 'Phone')}</th>
            <th>${t('Hồ sơ', 'Profile')}</th>
            <th>${t('Loại', 'Type')}</th><th></th>
          </tr></thead>
          <tbody>${rowsHtml || `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px">${t('Chưa có liên hệ nào. Bấm "Import từ Zalo" hoặc "+ Thêm liên hệ".', 'No contacts yet. Use "Import from Zalo" or "+ Add contact".')}</td></tr>`}</tbody>
        </table>
      </div>
      ${totalPages > 1 ? `<div class="crm-pager">
        <button class="btn" id="crmPrevPage" ${crmState.contactsPage <= 1 ? 'disabled' : ''}>‹</button>
        <span>${crmState.contactsPage}/${totalPages}</span>
        <button class="btn" id="crmNextPage" ${crmState.contactsPage >= totalPages ? 'disabled' : ''}>›</button>
      </div>` : ''}
    </div>`;

  let searchTimer;
  body.querySelector('#crmContactSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      crmState.contactsSearch = e.target.value.trim();
      crmState.contactsPage = 1;
      renderCrmContacts();
    }, 300);
  });
  body.querySelector('#crmGroupClear')?.addEventListener('click', () => {
    crmState.contactsGroup = '';
    crmState.contactsPage = 1;
    renderCrmContacts();
  });
  const bindFilter = (id, key) => body.querySelector(id)?.addEventListener('change', (e) => {
    crmState[key] = e.target.value;
    crmState.contactsPage = 1;   // đổi bộ lọc mà giữ nguyên trang 5 thì ra danh sách trống
    renderCrmContacts();
  });
  bindFilter('#crmLinkedFilter', 'contactsLinked');
  bindFilter('#crmFriendFilter', 'contactsFriend');
  bindFilter('#crmGenderFilter', 'contactsGender');
  bindFilter('#crmBirthdayFilter', 'contactsBirthday');
  bindFilter('#crmTagFilter', 'contactsTag');
  bindFilter('#crmSourceFilter', 'contactsSource');
  bindFilter('#crmSortSelect', 'contactsSort');

  // ── Chọn hàng loạt ──
  // Tick giữ theo id trong `crmState.selected`, không theo dòng: sang trang khác rồi quay lại,
  // hoặc đổi bộ lọc, thì lựa chọn vẫn đúng người. Đây là điều kiện để "gắn nhãn cho 300 liên hệ
  // trải nhiều trang" không thành trò may rủi.
  const syncBulkUi = () => {
    const host = body.querySelector('#crmBulkHost');
    const n = crmState.selected.size;
    host.innerHTML = n ? `<div class="crm-bulkbar">
      <span><b>${n}</b> ${t('đã chọn', 'selected')}</span>
      <button class="btn" id="crmBulkTagAdd">${t('🏷 Gắn nhãn', '🏷 Add label')}</button>
      <button class="btn" id="crmBulkTagRemove">${t('Bỏ nhãn', 'Remove label')}</button>
      <button class="btn danger" id="crmBulkDelete">${t('Xoá', 'Delete')}</button>
      <button class="btn" id="crmBulkClear" style="margin-left:auto">${t('Bỏ chọn', 'Clear')}</button>
    </div>` : '';
    host.querySelector('#crmBulkTagAdd')?.addEventListener('click', () => crmBulkTag(true));
    host.querySelector('#crmBulkTagRemove')?.addEventListener('click', () => crmBulkTag(false));
    host.querySelector('#crmBulkDelete')?.addEventListener('click', crmBulkDelete);
    host.querySelector('#crmBulkClear')?.addEventListener('click', () => {
      crmState.selected.clear();
      body.querySelectorAll('[data-crm-pick-row]').forEach(cb => { cb.checked = false; });
      syncBulkUi();
    });
    const all = body.querySelector('#crmPickAll');
    if (all) all.checked = pageIds.length > 0 && pageIds.every(id => crmState.selected.has(id));
  };
  syncBulkUi();

  body.querySelectorAll('[data-crm-pick-row]').forEach(cb => cb.addEventListener('change', () => {
    const id = cb.getAttribute('data-crm-pick-row');
    if (cb.checked) crmState.selected.add(id); else crmState.selected.delete(id);
    syncBulkUi();
  }));
  body.querySelector('#crmPickAll')?.addEventListener('change', (e) => {
    for (const id of pageIds) {
      if (e.target.checked) crmState.selected.add(id); else crmState.selected.delete(id);
    }
    body.querySelectorAll('[data-crm-pick-row]').forEach(cb => { cb.checked = e.target.checked; });
    syncBulkUi();
  });
  body.querySelector('#crmPrevPage')?.addEventListener('click', () => { crmState.contactsPage--; renderCrmContacts(); });
  body.querySelector('#crmNextPage')?.addEventListener('click', () => { crmState.contactsPage++; renderCrmContacts(); });
  body.querySelectorAll('[data-crm-tag]').forEach(el => el.addEventListener('click', () => {
    crmState.contactsTag = el.dataset.crmTag;
    crmState.contactsPage = 1;
    renderCrmContacts();
  }));
  // Bấm chip nhóm trên một khách → lọc ra mọi khách thuộc nhóm đó. Đây là đường đi tự nhiên:
  // "khách này ở nhóm ASA 7881" → "còn ai trong nhóm đó đã là khách?"
  body.querySelectorAll('[data-crm-group-filter]').forEach(el => el.addEventListener('click', () => {
    crmState.contactsGroup = el.dataset.crmGroupFilter;
    crmState.contactsPage = 1;
    renderCrmContacts();
  }));
  const findContact = (id) => (crmState.contacts || []).find(c => c.id === id);
  body.querySelectorAll('[data-crm-dm]').forEach(el => el.addEventListener('click', async () => {
    const c = findContact(el.dataset.crmDm);
    if (!c?.zalo_uid) return;
    const ok = await openModal({
      title: t(`Nhắn riêng cho ${c.display_name}`, `Message ${c.display_name}`),
      desc: t('Tin gửi từ tài khoản bot, không phải từ tài khoản cá nhân của bạn.',
        'Sent from the bot account, not your personal account.'),
      body: `<label class="crm-field"><span>${t('Nội dung', 'Message')}</span><textarea id="crmDmText"></textarea></label>`,
      confirmText: t('Gửi', 'Send'),
    });
    if (!ok) return;
    const text = document.getElementById('crmDmText')?.value.trim();
    if (!text) { showToast(t('Chưa nhập nội dung.', 'No message entered.'), 'error'); return; }
    await runAction('send-message', { targetType: 'user', targetId: c.zalo_uid, text },
      t('Đã gửi tin nhắn', 'Message sent'));
  }));
  body.querySelectorAll('[data-crm-addfriend]').forEach(el => el.addEventListener('click', async () => {
    const c = findContact(el.dataset.crmAddfriend);
    if (!c?.zalo_uid) return;
    const ok = await openModal({
      title: t(`Gửi lời mời kết bạn tới ${c.display_name}?`, `Send friend request to ${c.display_name}?`),
      desc: t('Kết bạn xong bot mới đọc được sđt và ngày sinh của người này ở lần đồng bộ sau.',
        'Once connected, the bot can read this person’s phone and birthday on the next sync.'),
      body: `<label class="crm-field"><span>${t('Lời nhắn', 'Message')}</span><input id="crmFrMsg" autocomplete="off" value="${crmEsc(t('Xin chào, mình muốn kết nối.', 'Hi, I would like to connect.'))}"></label>`,
      confirmText: t('Gửi lời mời', 'Send request'),
    });
    if (!ok) return;
    await runAction('send-friend-request',
      { userId: c.zalo_uid, message: document.getElementById('crmFrMsg')?.value.trim() || '' },
      t('Đã gửi lời mời kết bạn', 'Friend request sent'));
  }));
  body.querySelectorAll('[data-crm-edit]').forEach(el => el.addEventListener('click', () => {
    const contact = (crmState.contacts || []).find(c => c.id === el.dataset.crmEdit);
    if (contact) crmContactModal(contact);
  }));
  body.querySelectorAll('[data-crm-del]').forEach(el => el.addEventListener('click', async () => {
    const contact = (crmState.contacts || []).find(c => c.id === el.dataset.crmDel);
    const ok = await openModal({
      title: t('Xoá khách hàng?', 'Delete contact?'),
      desc: t(`"${contact?.display_name}" sẽ bị xoá khỏi CRM (lead/task liên quan được giữ lại, chỉ gỡ liên kết).`,
        `"${contact?.display_name}" will be removed from CRM (linked leads/tasks are kept, just unlinked).`),
      confirmText: t('Xoá', 'Delete'), danger: true, tone: 'danger',
    });
    if (!ok) return;
    try {
      await crmAction('crm-contact-delete', { id: el.dataset.crmDel });
      showToast(t('Đã xoá khách hàng', 'Contact deleted'), 'success');
      renderCrmContacts();
    } catch (err) { showToast(err.message, 'error'); }
  }));
}

async function crmContactModal(contact) {
  const f = (id, label, value, type = 'text', placeholder = '') => `
    <label class="crm-field"><span>${label}</span>
      <input type="${type}" id="${id}" value="${crmEsc(value ?? '')}" placeholder="${crmEsc(placeholder)}"></label>`;
  // `draft` là nguồn sự thật cho phần liên kết trong lúc form đang mở — các ô input khác giữ giá trị
  // trong DOM, còn uid thì không có input nào để giữ.
  const draft = { zaloUid: contact?.zalo_uid || '' };
  const people = crmZaloPeople();

  const linkBoxHtml = () => draft.zaloUid
    ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="chip" style="background:rgba(52,211,153,.18)">🔗 ${t('Đã nối Zalo', 'Linked')}</span>
        <code style="font-size:11.5px;opacity:.7">${crmEsc(draft.zaloUid)}</code>
        <button class="btn" type="button" data-crm-unlink style="min-height:0;height:26px;padding:0 9px;font-size:11.5px">${t('Bỏ nối', 'Unlink')}</button>
      </div>`
    : crmPersonPickerHtml();

  // openModal dựng DOM ĐỒNG BỘ rồi mới trả promise, nên phải gắn handler TRƯỚC khi await — gắn sau
  // thì owner đã đóng form xong, bộ chọn chưa bao giờ hoạt động.
  const pending = openModal({
    title: contact ? t('Sửa liên hệ', 'Edit contact') : t('Thêm liên hệ', 'Add contact'),
    body: `<div class="crm-form">
      <label class="crm-field"><span>${t('Người Zalo', 'Zalo person')}</span>
        <div data-crm-linkbox>${linkBoxHtml()}</div></label>
      ${f('crmFName', t('Tên hiển thị *', 'Display name *'), contact?.display_name)}
      ${f('crmFPhone', t('SĐT', 'Phone'), contact?.phone)}
      ${f('crmFTags', 'Tags', (contact?.tags || []).join(', '), 'text', t('vd: vip, khách sỉ', 'e.g. vip, wholesale'))}
      ${f('crmFSource', t('Nguồn', 'Source'), contact?.source, 'text', t('vd: zalo-group, giới thiệu', 'e.g. zalo-group, referral'))}
      ${/* CHỈ HIỂN THỊ, không cho tick. Việc một người ở nhóm nào là dữ kiện Zalo đã có và mỗi lần
            sync lại đúng theo thực tế — cho sửa tay thì lần sync kế tiếp ghi đè, thành ra cái nút
            hứa một chuyện rồi lặng lẽ nuốt lời. Muốn đổi thì đổi ở Zalo, không phải ở đây. */''}
      <label class="crm-field"><span>${t('Thuộc nhóm', 'In groups')}</span>
        ${crmGroupsReadonly(contact?.groups || [])}</label>
      <label class="crm-field"><span>${t('Ghi chú', 'Notes')}</span>
        <textarea id="crmFNotes" rows="3">${crmEsc(contact?.notes ?? '')}</textarea></label>
    </div>`,
    confirmText: t('Lưu', 'Save'),
  });

  const redrawLink = () => {
    const box = modalBody.querySelector('[data-crm-linkbox]');
    if (box) box.innerHTML = linkBoxHtml();
  };
  const onClick = (ev) => {
    if (ev.target.closest?.('[data-crm-unlink]')) { draft.zaloUid = ''; redrawLink(); return; }
    const uid = ev.target.closest?.('[data-crm-pick]')?.getAttribute('data-crm-pick');
    if (!uid) return;
    const person = people.find(p => p.uid === uid);
    if (!person) return;
    draft.zaloUid = person.uid;
    // Chọn người thì điền hộ tên (nếu owner chưa gõ gì) và tick sẵn các nhóm người đó đang ở —
    // đúng thứ owner muốn 99% trường hợp, vẫn sửa lại được.
    const nameEl = document.getElementById('crmFName');
    if (nameEl && !nameEl.value.trim()) nameEl.value = person.name;
    const srcEl = document.getElementById('crmFSource');
    if (srcEl && !srcEl.value.trim()) srcEl.value = 'zalo-group';
    // Nhóm không còn sửa tay ở đây; chọn người xong thì hiện luôn nhóm của người đó cho owner thấy,
    // còn việc ghi liên kết để lần sync gần nhất lo.
    const host = modalBody.querySelector('[data-crm-groups-view]');
    if (host) host.outerHTML = crmGroupsReadonly(person.groups || []);
    redrawLink();
  };
  const onInput = (ev) => {
    if (!ev.target.closest?.('[data-crm-pick-q]')) return;
    const needle = foldVi(ev.target.value);
    const hit = needle ? people.filter(p => foldVi(p.name).includes(needle)) : people;
    const list = modalBody.querySelector('[data-crm-pick-list]');
    if (list) {
      list.innerHTML = hit.length ? hit.slice(0, 50).map(crmPersonRowHtml).join('')
        : `<div class="item-sub" style="padding:10px;font-size:12px">${t('Không tìm thấy ai', 'No match')}</div>`;
    }
  };
  modalBody.addEventListener('click', onClick);
  modalBody.addEventListener('input', onInput);
  const ok = await pending;
  modalBody.removeEventListener('click', onClick);
  modalBody.removeEventListener('input', onInput);
  if (!ok) return;
  const name = document.getElementById('crmFName')?.value.trim();
  if (!name) { showToast(t('Tên là bắt buộc', 'Name is required'), 'error'); return; }
  try {
    const saved = await crmAction('crm-contact-save', {
      id: contact?.id,
      displayName: name,
      phone: document.getElementById('crmFPhone').value.trim(),
      source: document.getElementById('crmFSource').value.trim(),
      notes: document.getElementById('crmFNotes').value,
      zaloUid: draft.zaloUid || null,
    });
    const tags = document.getElementById('crmFTags').value.split(',').map(s => s.trim()).filter(Boolean);
    await crmAction('crm-contact-tags', { id: saved.id, tags });
    // KHÔNG gọi `crm-contact-groups` nữa: nó replace toàn bộ, mà form giờ chỉ hiển thị nhóm chứ
    // không cho chọn — gửi lên sẽ là mảng rỗng và xoá sạch liên kết nhóm mà sync vừa dựng.
    showToast(t('Đã lưu liên hệ', 'Contact saved'), 'success');
    renderCrmContacts();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Bộ chọn người Zalo dùng chung ─────────────────────────────────────────────────────────────
// Vì sao CRM trước đây "không có giá trị": form khách hàng chỉ gõ tay, nên contact mới KHÔNG BAO GIỜ
// có `zalo_uid` — mất luôn khả năng nối về sau (mở lịch sử chat, biết ở nhóm nào). Bộ chọn này lấy
// người từ dữ liệu bot ĐANG CÓ.
//
// Hiển thị theo TÊN nhưng lưu `uid`: tên Zalo trùng nhau và đổi được, nối theo tên sẽ sai âm thầm.

/** Gộp member mọi nhóm thành danh sách người, kèm các nhóm họ đang ở. */
function crmZaloPeople() {
  const membersMap = (state && state.members) || {};
  const byUid = new Map();
  for (const groupId of Object.keys(membersMap)) {
    const gname = (state.groups || []).find(g => g.groupId === groupId)?.name || groupId;
    for (const [uid, raw] of Object.entries(membersMap[groupId] || {})) {
      const name = raw?.name || raw?.displayName || raw?.dName || raw?.zaloName || '';
      if (!uid || !name) continue;
      const cur = byUid.get(uid) || {
        uid, name, avatar: raw?.avatar || raw?.avatarUrl || raw?.avatar_url || raw?.photo || '', groups: [],
      };
      if (!cur.groups.some(g => g.groupId === groupId)) cur.groups.push({ groupId, name: gname });
      byUid.set(uid, cur);
    }
  }
  return [...byUid.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

/** Một dòng người trong bộ chọn — tên to, các nhóm đang ở nhỏ bên dưới. */
function crmPersonRowHtml(p) {
  return `<button type="button" data-crm-pick="${crmEsc(p.uid)}" class="crm-pick-row">
    ${p.avatar
      ? `<img src="${crmEsc(p.avatar)}" alt="" class="crm-pick-ava"/>`
      : `<span class="crm-pick-ava crm-pick-ava-empty">${crmEsc(p.name.slice(0, 1).toUpperCase())}</span>`}
    <span style="flex:1;min-width:0;text-align:left">
      <span style="display:block;font-weight:600;font-size:13.5px">${crmEsc(p.name)}</span>
      <span style="display:block;font-size:11.5px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${p.groups.length} ${t('nhóm', 'groups')} · ${crmEsc(p.groups.map(g => g.name).join(', '))}</span>
    </span></button>`;
}

/**
 * Bộ chọn người dạng INLINE, không phải modal riêng.
 *
 * `openModal` dùng một biến `modalResolve` toàn cục, nên mở modal lồng nhau sẽ ghi đè nó và promise
 * của modal ngoài treo mãi không resolve. Đặt bộ chọn ngay trong form vừa tránh hẳn lỗi đó, vừa đỡ
 * cho owner một nhịp bấm.
 */
function crmPersonPickerHtml() {
  const people = crmZaloPeople();
  if (!people.length) {
    return `<div class="item-sub" style="font-size:12px">${t(
      'Chưa có member nào trong state — mở trang Thành viên để sync trước.',
      'No members in state — open the Members page to sync first.')}</div>`;
  }
  return `<input type="search" data-crm-pick-q placeholder="${t('Gõ tên (không dấu cũng được)', 'Type a name')}"
      style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);font-size:13px;margin-bottom:6px"/>
    <div data-crm-pick-list style="max-height:190px;overflow:auto;display:flex;flex-direction:column;gap:4px">
      ${people.slice(0, 50).map(crmPersonRowHtml).join('')}</div>
    <div class="item-sub" style="margin-top:5px;font-size:11px">${t(
      `${people.length} người từ các nhóm bot đang theo · lưu theo uid, không theo tên`,
      `${people.length} people from followed groups · linked by uid, not by name`)}</div>`;
}

/**
 * Các nhóm của một liên hệ — CHỈ HIỂN THỊ.
 *
 * Trước đây đây là checklist chọn tay mọi nhóm bot đang theo. Bỏ vì nó hứa một chuyện rồi nuốt lời:
 * việc ai ở nhóm nào là dữ kiện của Zalo, và mỗi lần sync `importMembers` dựng lại đúng theo thực
 * tế — nên nhóm tick tay sẽ bị ghi đè ở lần sync kế tiếp mà không báo gì. Thêm nữa, danh sách phải
 * liệt kê MỌI nhóm để tick được, trong khi thứ owner cần chỉ là "người này đang ở đâu".
 */
function crmGroupsReadonly(groups = []) {
  if (!groups.length) {
    return `<div data-crm-groups-view class="item-sub" style="font-size:12px">${t(
      'Chưa thuộc nhóm nào bot đang theo. Nhóm được điền tự động khi Sync account.',
      'Not in any followed group. Groups are filled in automatically on Sync account.')}</div>`;
  }
  return `<div data-crm-groups-view class="chips" style="max-height:120px;overflow:auto">${groups.map(g =>
    `<span class="chip" title="${crmEsc(g.name)}" style="background:rgba(96,165,250,.14)">${crmEsc(g.name)}</span>`).join('')}</div>`;
}

/** Một <select> nhóm cho lead/task — chỉ chọn được MỘT nhóm nên dùng select, không dùng checklist. */
function crmGroupSelect(id, current = '') {
  const groups = (state.groups || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'vi'));
  return `<select id="${id}">
    <option value="">${t('— không gắn nhóm —', '— no group —')}</option>
    ${groups.map(g => `<option value="${crmEsc(g.groupId)}" ${String(current) === String(g.groupId) ? 'selected' : ''}>${crmEsc(g.name)}</option>`).join('')}
  </select>`;
}

/**
 * Khối "Kết bạn & lời mời" — phần duy nhất còn dùng được của trang Bạn bè cũ.
 *
 * Trang đó bị bỏ vì nó chỉ là 3 thẻ mô tả API, không có danh sách nào; thứ owner thật sự cần —
 * DANH SÁCH bạn bè — nay nằm ngay trong bảng Liên hệ (cờ `is_friend` + bộ lọc "Đã kết bạn").
 * Còn lại là ba thao tác kết bạn, đặt gọn dưới bảng thay vì chiếm một mục nav riêng.
 *
 * Vẫn khoá theo Pro: trang cũ nằm trong danh sách khoá, gộp sang trang CRM (không khoá) mà bỏ luôn
 * cổng thì hoá ra mở thêm tính năng Pro cho bản free — sửa giao diện không được đổi giấy phép.
 */
function crmRenderFriendOps() {
  const host = document.getElementById('crmFriendOps');
  if (!host) return;
  const isPro = !!(state?.license?.isPro);
  host.innerHTML = `
    <details class="card crm-friend-ops">
      <summary>${t('Kết bạn & lời mời', 'Friend requests')}
        <span class="item-sub" style="font-weight:400">${t('— thao tác trên tài khoản Zalo của bot',
          '— actions on the bot Zalo account')}</span></summary>
      ${isPro ? `<div class="crm-friend-ops-row">
        <button class="btn" data-action="find-user">${t('Tìm user', 'Find user')}</button>
        <button class="btn" data-action="friend-request-by-id">${t('Gửi lời mời', 'Send request')}</button>
        <button class="btn" data-action="get-friends">${t('Tải danh sách bạn bè', 'Load friends')}</button>
      </div>` : `<p class="item-sub" style="margin:10px 0 0">🔒 ${t(
        'Cần bản Pro. Danh sách bạn bè vẫn xem được ở bảng trên bằng bộ lọc "Đã kết bạn".',
        'Pro required. The friend list is still visible above via the "Friends" filter.')}</p>`}
    </details>`;
}

/**
 * Id thật của những dòng đang chọn — bung dòng đã gộp ra thành mọi bản ghi bên dưới.
 *
 * Ở chế độ tất cả bot, một dòng là một NGƯỜI nhưng dưới nó có thể là hai bản ghi (mỗi bot một
 * uid). Thao tác trên người đó phải áp cho cả hai, không thì gắn nhãn xong đổi sang bot kia lại
 * thấy chưa có nhãn.
 */
function crmSelectedIds() {
  const out = new Set();
  for (const id of crmState.selected) {
    for (const real of (crmState.mergedMap.get(id) || [id])) out.add(real);
  }
  return [...out];
}

/**
 * Gắn hoặc bỏ một nhãn cho toàn bộ liên hệ đang chọn.
 *
 * Cho gõ nhãn mới ngay tại đây (kèm `<datalist>` gợi ý nhãn đã có) thay vì bắt vào trang quản lý
 * nhãn trước: việc phân loại luôn nảy ra lúc đang nhìn danh sách, chứ không phải lúc rảnh.
 */
async function crmBulkTag(add) {
  const ids = crmSelectedIds();
  if (!ids.length) return;
  const known = (crmState.tags || []).map(x => x.name);
  const ok = await openModal({
    title: add ? t(`Gắn nhãn cho ${ids.length} liên hệ`, `Add label to ${ids.length} contacts`)
               : t(`Bỏ nhãn khỏi ${ids.length} liên hệ`, `Remove label from ${ids.length} contacts`),
    body: `<label class="crm-field"><span>${t('Tên nhãn', 'Label')}</span>
        <input id="crmBulkTagName" list="crmBulkTagList" autocomplete="off"
          placeholder="${t('Gõ tên nhãn hoặc chọn nhãn có sẵn', 'Type a label or pick an existing one')}"></label>
      <datalist id="crmBulkTagList">${known.map(n => `<option value="${crmEsc(n)}"></option>`).join('')}</datalist>`,
    confirmText: add ? t('Gắn nhãn', 'Add') : t('Bỏ nhãn', 'Remove'),
    danger: !add,
  });
  if (!ok) return;
  const tag = document.getElementById('crmBulkTagName')?.value.trim();
  if (!tag) { showToast(t('Chưa nhập tên nhãn.', 'No label entered.'), 'error'); return; }
  try {
    const r = await crmAction('crm-contacts-tag', { ids, tag, add });
    crmState.tags = null;   // số đếm mỗi nhãn vừa đổi
    crmState.selected.clear();
    showToast(add ? t(`Đã gắn "${tag}" cho ${r.changed} liên hệ`, `Added "${tag}" to ${r.changed} contacts`)
                  : t(`Đã bỏ "${tag}" khỏi ${r.changed} liên hệ`, `Removed "${tag}" from ${r.changed} contacts`), 'success');
    renderCrmContacts();
  } catch (err) { showToast(err.message, 'error'); }
}

async function crmBulkDelete() {
  const ids = crmSelectedIds();
  if (!ids.length) return;
  const ok = await openModal({
    title: t(`Xoá ${ids.length} liên hệ?`, `Delete ${ids.length} contacts?`),
    desc: t('Lead và công việc liên quan được giữ lại, chỉ gỡ liên kết. Import lại từ Zalo sẽ tạo lại các liên hệ này.',
      'Related leads and tasks are kept, just unlinked. Re-importing from Zalo will recreate them.'),
    confirmText: t('Xoá', 'Delete'), danger: true, tone: 'danger',
  });
  if (!ok) return;
  try {
    const r = await crmAction('crm-contacts-delete', { ids });
    crmState.tags = null;
    crmState.selected.clear();
    crmState.contactsPage = 1;   // xoá xong trang cuối có thể không còn tồn tại
    showToast(t(`Đã xoá ${r.deleted} liên hệ`, `Deleted ${r.deleted} contacts`), 'success');
    renderCrmContacts();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Nhập / xuất CSV ─────────────────────────────────────────────────────────
//
// CSV chứ không phải .xlsx: Excel mở thẳng file .csv, và bộ sinh chỉ là vài dòng chuỗi — không
// phải kéo thêm bộ đóng gói zip/XML vào một plugin hiện không có dependency nào.

const CRM_CSV_COLUMNS = [
  ['Tên', c => c.display_name],
  ['SĐT', c => c.phone || ''],
  ['Giới tính', c => crmGenderLabel(c.gender)],
  ['Ngày sinh', c => c.birthday || ''],
  ['Nhãn', c => (c.tags || []).join(', ')],
  ['Nhóm', c => (c.groups || []).map(g => g.name).join(', ')],
  ['Loại', c => crmSourceLabel(c.source)],
  ['Đã kết bạn', c => (c.is_friend ? 'x' : '')],
  ['UID Zalo', c => c.zalo_uid || ''],
  ['Ghi chú', c => c.notes || ''],
];

/**
 * Một ô CSV. Excel hiểu `""` là dấu nháy kép, và luôn phải bọc khi ô có dấu phẩy/xuống dòng.
 *
 * Dấu `'` ở đầu những chuỗi bắt đầu bằng `=+-@`: Excel coi chúng là CÔNG THỨC và sẽ chạy khi mở
 * file. Tên Zalo do người ngoài đặt, nên một liên hệ tên `=cmd|...` là đường tuồn lệnh vào máy
 * người mở file.
 */
function crmCsvCell(v) {
  let str = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return `"${str.replace(/"/g, '""')}"`;
}

async function crmExportCsv() {
  const bot = selBotProfile();
  const btn = document.getElementById('crmCsvExportBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('Đang lấy…', 'Fetching…'); }
  try {
    // Xuất theo ĐÚNG bộ lọc đang xem: owner lọc "sinh nhật 7 ngày tới" rồi bấm tải mà ra cả 376
    // người thì file đó vô dụng.
    const res = await crmAction('crm-contacts-export', {
      search: crmState.contactsSearch || undefined,
      tag: crmState.contactsTag || undefined,
      groupId: crmState.contactsGroup || undefined,
      linked: crmState.contactsLinked || undefined,
      gender: crmState.contactsGender || undefined,
      friend: crmState.contactsFriend || undefined,
      source: crmState.contactsSource || undefined,
      sort: crmState.contactsSort || undefined,
      accountId: bot || undefined,
      mergePeople: (!bot && (state.bots || []).length > 1) || undefined,
      birthdayWithin: crmState.contactsBirthday ? Number(crmState.contactsBirthday) : undefined,
    });
    const rows = res.contacts || [];
    if (!rows.length) { showToast(t('Không có liên hệ nào khớp bộ lọc.', 'No contacts match the filter.'), 'error'); return; }

    const lines = [CRM_CSV_COLUMNS.map(c => crmCsvCell(c[0])).join(',')];
    for (const c of rows) lines.push(CRM_CSV_COLUMNS.map(col => crmCsvCell(col[1](c))).join(','));
    // BOM UTF-8: thiếu nó thì Excel trên Windows đọc tiếng Việt thành ký tự rác.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    a.href = url;
    a.download = `lien-he-${bot || 'tat-ca'}-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(t(`Đã tải ${rows.length} liên hệ`, `Exported ${rows.length} contacts`), 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = t('⬇ Tải CSV', '⬇ Export CSV'); } }
}

/** Tách một dòng CSV, có xử lý ô bọc nháy kép và dấu phẩy nằm trong ô. */
function crmCsvSplitLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',' || ch === ';') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  // Bỏ dấu nháy chống-công-thức mà chính mình thêm lúc xuất, để tải ra rồi nhập lại không lệch.
  return out.map(v => v.trim().replace(/^'(?=[=+\-@])/, ''));
}

function crmParseCsv(text) {
  // Excel bản Việt hay lưu bằng dấu `;`. Đoán bằng cách đếm ở dòng tiêu đề — đoán sai thì cả file
  // thành một cột và người dùng không hiểu vì sao.
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  const rawLines = clean.split('\n').filter(l => l.trim());
  if (rawLines.length < 2) return { rows: [], headers: [] };
  const headers = crmCsvSplitLine(rawLines[0]).map(h => h.toLowerCase());
  const find = (...names) => headers.findIndex(h => names.some(n => h.includes(n)));
  const idx = {
    displayName: find('tên', 'ten', 'name'),
    phone: find('sđt', 'sdt', 'phone', 'điện thoại'),
    gender: find('giới', 'gioi', 'gender'),
    birthday: find('sinh', 'birthday', 'dob'),
    tags: find('nhãn', 'nhan', 'tag', 'label'),
    zaloUid: find('uid'),
    notes: find('ghi chú', 'ghi chu', 'note'),
  };
  const rows = [];
  for (const line of rawLines.slice(1)) {
    const cells = crmCsvSplitLine(line);
    const at = (i) => (i >= 0 && i < cells.length ? cells[i] : '');
    const displayName = at(idx.displayName);
    if (!displayName) continue;
    rows.push({
      displayName,
      phone: at(idx.phone),
      gender: /^(nữ|nu|female|f)$/i.test(at(idx.gender)) ? 'female'
        : /^(nam|male|m)$/i.test(at(idx.gender)) ? 'male' : '',
      birthday: at(idx.birthday),
      tags: at(idx.tags),
      zaloUid: at(idx.zaloUid),
      notes: at(idx.notes),
    });
  }
  return { rows, headers, hasName: idx.displayName >= 0 };
}

async function crmImportCsv() {
  const bot = selBotProfile();
  if (!bot && (state.bots || []).length > 1) {
    showToast(t('Chọn một bot ở thanh trên trước khi nhập — liên hệ phải thuộc về đúng tài khoản Zalo.',
      'Pick a bot in the top bar first — contacts must belong to a specific Zalo account.'), 'error');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    let parsed;
    try {
      parsed = crmParseCsv(await file.text());
    } catch (err) { showToast(err.message, 'error'); return; }

    if (!parsed.hasName) {
      showToast(t('File thiếu cột "Tên" — tải một file mẫu bằng nút "Tải CSV" để xem đúng định dạng.',
        'Missing a "Tên"/"Name" column — export a sample with "Export CSV" to see the format.'), 'error');
      return;
    }
    if (!parsed.rows.length) { showToast(t('File không có dòng nào.', 'File has no rows.'), 'error'); return; }

    const ok = await openModal({
      title: t(`Nhập ${parsed.rows.length} liên hệ từ CSV`, `Import ${parsed.rows.length} contacts from CSV`),
      body: `<ul style="margin:0;padding-left:18px;line-height:1.7">
        <li>${crmEsc(t(`Vào tài khoản bot: ${bot || 'default'}`, `Into bot account: ${bot || 'default'}`))}</li>
        <li>${crmEsc(t('Trùng sđt hoặc trùng tên thì CẬP NHẬT, không tạo thêm dòng mới.',
          'Rows matching an existing phone or name are UPDATED, not duplicated.'))}</li>
        <li>${crmEsc(t('Ô để trống nghĩa là không đụng tới, không phải xoá.',
          'Empty cells mean "leave as-is", not "clear".'))}</li>
      </ul>`,
      confirmText: t('Nhập', 'Import'),
    });
    if (!ok) return;
    try {
      const r = await crmAction('crm-contacts-import-rows', { rows: parsed.rows, accountId: bot || 'default' });
      crmState.tags = null;
      showToast(t(`Nhập xong: ${r.created} mới, ${r.updated} cập nhật${r.skipped ? `, bỏ ${r.skipped} dòng thiếu tên` : ''}`,
        `Imported: ${r.created} new, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ''}`), 'success');
      renderCrmContacts();
    } catch (err) { showToast(err.message, 'error'); }
  }, { once: true });
  input.click();
}

/**
 * Kéo liên hệ + nhãn Zalo về CRM. Chạy kèm "Sync account" ở Tổng quan, không còn nút riêng.
 *
 * Hai việc này lấy dữ liệu từ chính tài khoản Zalo, đúng phạm vi mà sync account vừa làm mới — bắt
 * owner nhớ bấm thêm hai nút nữa ở một trang khác thì danh sách sẽ luôn cũ hơn thực tế, và họ sẽ
 * kết luận là CRM hỏng chứ không nghĩ là mình quên bấm.
 *
 * Lỗi ở đây KHÔNG được làm hỏng kết quả sync group: sync group là việc chính owner vừa yêu cầu, còn
 * đây là phần ăn theo. Nên bắt hết lỗi, chỉ báo bằng toast.
 *
 * @param {string} profile '' = mọi bot
 */
async function crmSyncFromZalo(profile = '') {
  const scope = profile ? { profile } : {};
  const bits = [];
  try {
    const res = await crmAction('crm-import-zalo', scope);
    bits.push(t(`${res.created} liên hệ mới, ${res.updated} cập nhật`,
      `${res.created} new contacts, ${res.updated} updated`));
  } catch (err) {
    showToast(t(`Sync liên hệ lỗi: ${err.message}`, `Contact sync failed: ${err.message}`), 'error');
  }

  try {
    const r = await crmAction('crm-sync-zalo-labels', scope);
    crmState.tags = null;   // danh mục vừa đổi → buộc nạp lại màu
    bits.push(t(`${r.tags} nhãn, gắn ${r.assigned}`, `${r.tags} labels, ${r.assigned} assigned`));
    if (r.removed) bits.push(t(`gỡ ${r.removed} nhãn đã xoá bên Zalo`, `${r.removed} removed`));

    // Ba trạng thái dễ bị hiểu nhầm là "hỏng" — nói rõ ngay thay vì để owner đoán.
    if (r.failed?.length) {
      showToast(t(`⚠️ ${r.failed.length} tài khoản không đọc được nhãn — lần này CHỈ thêm, không xoá gì.`,
        `⚠️ ${r.failed.length} account(s) failed — this run only added labels, nothing removed.`), 'error');
    } else if (r.tags && !r.assigned) {
      showToast(t('Zalo có nhãn nhưng chưa gắn cho hội thoại nào — vào app Zalo phân loại chat rồi sync lại.',
        'Zalo has labels but none is assigned to any chat — classify chats in the Zalo app, then sync again.'), 'warning');
    }
  } catch (err) {
    showToast(t(`Đồng bộ nhãn lỗi: ${err.message}`, `Label sync failed: ${err.message}`), 'error');
  }

  if (bits.length) showToast(`CRM: ${bits.join(' · ')}`, 'success');
  // Chỉ vẽ lại khi owner đang đứng ở trang Liên hệ — sync thường bấm từ Tổng quan.
  if (document.getElementById('contacts')?.classList.contains('active')) renderCrmContacts();
}

// ── Leads (kanban) ──────────────────────────────────────────────────────────

async function renderCrmLeads() {
  const head = document.querySelector('#leads .page-head');
  if (head) {
    head.querySelector('h2').textContent = t('Pipeline', 'Pipeline');
    head.querySelector('p').textContent = t('Kéo thả lead qua các giai đoạn: Mới → Đã liên hệ → Tiềm năng → Đã báo giá → Thắng/Thua.',
      'Drag leads across stages: New → Contacted → Qualified → Quoted → Won/Lost.');
  }
  const actions = document.getElementById('crmLeadsActions');
  actions.innerHTML = `<button class="btn primary" id="crmAddLeadBtn">${t('+ Thêm lead', '+ Add lead')}</button>`;
  actions.querySelector('#crmAddLeadBtn').addEventListener('click', () => crmLeadModal(null));

  const body = document.getElementById('crmLeadsBody');
  body.innerHTML = `<div class="card" style="padding:24px;color:var(--muted)">${t('Đang tải…', 'Loading…')}</div>`;
  try {
    crmState.pipeline = await crmAction('crm-pipeline', {});
    crmRenderKanban(body);
  } catch (err) {
    crmErrorCard(body, err, renderCrmLeads);
  }
}

function crmRenderKanban(body) {
  const p = crmState.pipeline;
  const cols = p.stages.map(stage => {
    const leads = p.byStage[stage] || [];
    const cards = leads.map(lead => `
      <div class="kanban-card" draggable="true" data-lead-id="${crmEsc(lead.id)}">
        <div class="kanban-card-title">${crmEsc(lead.title)}</div>
        <div class="kanban-card-meta">
          <span class="kanban-card-value">${crmMoney(lead.value, lead.currency)}</span>
          ${lead.contactName ? `<span class="kanban-card-contact">👤 ${crmEsc(lead.contactName)}</span>` : ''}
        </div>
        ${lead.next_action ? `<div class="kanban-card-next">→ ${crmEsc(lead.next_action)}</div>` : ''}
      </div>`).join('');
    return `
      <div class="kanban-col" data-stage="${stage}">
        <div class="kanban-col-head" style="border-top:3px solid ${CRM_STAGE_COLORS[stage]}">
          <span class="kanban-col-title">${crmStageLabel(stage)}</span>
          <span class="kanban-col-count">${leads.length}</span>
          <span class="kanban-col-total">${crmMoney(p.totals[stage])}</span>
        </div>
        <div class="kanban-col-body" data-stage-body="${stage}">${cards}</div>
      </div>`;
  }).join('');
  body.innerHTML = `<div class="kanban">${cols}</div>`;
  crmRenderUndoBar();

  body.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.leadId);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => {
      const lead = crmFindLead(card.dataset.leadId);
      if (lead) crmLeadModal(lead);
    });
  });
  body.querySelectorAll('.kanban-col').forEach(col => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('dragover');
      const leadId = e.dataTransfer.getData('text/plain');
      const toStage = col.dataset.stage;
      const lead = crmFindLead(leadId);
      if (!lead || lead.stage === toStage) return;
      let lossReason;
      if (toStage === 'lost') {
        const ok = await openModal({
          title: t('Đánh dấu Thua', 'Mark as Lost'),
          body: `<label class="crm-field"><span>${t('Lý do (tuỳ chọn)', 'Reason (optional)')}</span>
            <input type="text" id="crmLossReason"></label>`,
          confirmText: t('Xác nhận', 'Confirm'), danger: true, tone: 'warning',
        });
        if (!ok) return;
        lossReason = document.getElementById('crmLossReason')?.value.trim();
      }
      try {
        await crmAction('crm-lead-move', { id: leadId, stage: toStage, lossReason });
        crmState.undoLead = { id: leadId, title: lead.title, from: lead.stage, to: toStage };
        renderCrmLeads();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });
}

function crmFindLead(id) {
  const p = crmState.pipeline;
  if (!p) return null;
  for (const stage of p.stages) {
    const found = (p.byStage[stage] || []).find(l => l.id === id);
    if (found) return found;
  }
  return null;
}

function crmRenderUndoBar() {
  const bar = document.getElementById('crmUndoBar');
  if (!bar) return;
  if (!crmState.undoLead) { bar.innerHTML = ''; return; }
  const u = crmState.undoLead;
  bar.innerHTML = `<div class="crm-undo">
    <span>${t(`Đã chuyển "${crmEsc(u.title)}": ${crmStageLabel(u.from)} → ${crmStageLabel(u.to)}`,
      `Moved "${crmEsc(u.title)}": ${crmStageLabel(u.from)} → ${crmStageLabel(u.to)}`)}</span>
    <button class="btn" id="crmUndoBtn">${t('↩ Hoàn tác', '↩ Undo')}</button>
  </div>`;
  bar.querySelector('#crmUndoBtn').addEventListener('click', async () => {
    try {
      await crmAction('crm-lead-undo', { id: u.id });
      crmState.undoLead = null;
      renderCrmLeads();
      showToast(t('Đã hoàn tác', 'Undone'), 'success');
    } catch (err) { showToast(err.message, 'error'); }
  });
  clearTimeout(crmRenderUndoBar._timer);
  crmRenderUndoBar._timer = setTimeout(() => { crmState.undoLead = null; crmRenderUndoBar(); }, 15000);
}

async function crmLeadModal(lead) {
  let contactOptions = `<option value="">${t('— Không gắn —', '— None —')}</option>`;
  try {
    const res = await crmAction('crm-contacts-list', { limit: 200 });
    contactOptions += res.contacts.map(c =>
      `<option value="${crmEsc(c.id)}" ${lead?.contact_id === c.id ? 'selected' : ''}>${crmEsc(c.display_name)}</option>`).join('');
  } catch (_) { /* dropdown rỗng vẫn dùng được */ }

  const ok = await openModal({
    title: lead ? t('Sửa lead', 'Edit lead') : t('Thêm lead', 'Add lead'),
    body: `<div class="crm-form">
      <label class="crm-field"><span>${t('Tiêu đề *', 'Title *')}</span>
        <input type="text" id="crmLTitle" value="${crmEsc(lead?.title ?? '')}"></label>
      <label class="crm-field"><span>${t('Giá trị (VND)', 'Value (VND)')}</span>
        <input type="number" min="0" id="crmLValue" value="${crmEsc(lead?.value ?? 0)}"></label>
      <label class="crm-field"><span>${t('Khách hàng', 'Contact')}</span>
        <select id="crmLContact">${contactOptions}</select></label>
      <label class="crm-field"><span>${t('Nhóm Zalo', 'Zalo group')}</span>
        ${crmGroupSelect('crmLGroup', lead?.group_id)}</label>
      <label class="crm-field"><span>${t('Sản phẩm', 'Product')}</span>
        <input type="text" id="crmLProduct" value="${crmEsc(lead?.product ?? '')}"></label>
      <label class="crm-field"><span>${t('Người phụ trách', 'Assignee')}</span>
        <input type="text" id="crmLAssignee" value="${crmEsc(lead?.assignee ?? '')}"></label>
      <label class="crm-field"><span>${t('Việc tiếp theo', 'Next action')}</span>
        <input type="text" id="crmLNext" value="${crmEsc(lead?.next_action ?? '')}"></label>
      ${lead ? `<button class="btn danger" id="crmLDelete" type="button" data-lead-id="${crmEsc(lead.id)}" data-lead-title="${crmEsc(lead.title)}" style="justify-self:start">${t('Xoá lead', 'Delete lead')}</button>` : ''}
    </div>`,
    confirmText: t('Lưu', 'Save'),
  });

  const delBtn = document.getElementById('crmLDelete');
  if (delBtn && delBtn.dataset.clicked === '1') return; // đã xử lý xoá

  if (!ok) return;
  const payload = {
    title: document.getElementById('crmLTitle')?.value.trim(),
    value: Number(document.getElementById('crmLValue')?.value || 0),
    contactId: document.getElementById('crmLContact')?.value || null,
    groupId: document.getElementById('crmLGroup')?.value || null,
    product: document.getElementById('crmLProduct')?.value.trim(),
    assignee: document.getElementById('crmLAssignee')?.value.trim(),
    nextAction: document.getElementById('crmLNext')?.value.trim(),
  };
  if (!payload.title) { showToast(t('Tiêu đề là bắt buộc', 'Title is required'), 'error'); return; }
  try {
    if (lead) await crmAction('crm-lead-update', { id: lead.id, ...payload });
    else await crmAction('crm-lead-create', payload);
    showToast(t('Đã lưu lead', 'Lead saved'), 'success');
    renderCrmLeads();
  } catch (err) { showToast(err.message, 'error'); }
}

document.addEventListener('click', async (e) => {
  // Nút xoá lead trong modal (nằm ngoài luồng confirm)
  if (e.target?.id === 'crmLDelete') {
    e.target.dataset.clicked = '1';
    const leadId = e.target.dataset.leadId;
    const leadTitle = e.target.dataset.leadTitle || '';
    closeModal(false);
    if (!leadId) return;
    const ok = await openModal({
      title: t('Xoá lead?', 'Delete lead?'),
      desc: t(`"${leadTitle}" sẽ bị xoá vĩnh viễn khỏi pipeline.`, `"${leadTitle}" will be permanently removed.`),
      confirmText: t('Xoá', 'Delete'), danger: true, tone: 'danger',
    });
    if (!ok) return;
    try {
      await crmAction('crm-lead-delete', { id: leadId });
      showToast(t('Đã xoá lead', 'Lead deleted'), 'success');
      renderCrmLeads();
    } catch (err) { showToast(err.message, 'error'); }
  }
});

// ── Tasks ───────────────────────────────────────────────────────────────────

async function renderCrmTasks() {
  const head = document.querySelector('#tasks .page-head');
  if (head) {
    head.querySelector('h2').textContent = t('Công việc', 'Tasks');
    head.querySelector('p').textContent = t('Việc cần làm, hạn chót, nhắc quá hạn — gắn với khách hàng hoặc lead.',
      'To-dos with due dates and overdue alerts — linked to contacts or leads.');
  }
  const actions = document.getElementById('crmTasksActions');
  actions.innerHTML = `<button class="btn primary" id="crmAddTaskBtn">${t('+ Thêm việc', '+ Add task')}</button>`;
  actions.querySelector('#crmAddTaskBtn').addEventListener('click', () => crmTaskModal());

  const body = document.getElementById('crmTasksBody');
  body.innerHTML = `<div class="card" style="padding:24px;color:var(--muted)">${t('Đang tải…', 'Loading…')}</div>`;
  try {
    const res = await crmAction('crm-tasks-list', { filter: crmState.taskFilter });
    crmState.tasks = res.tasks;
    crmRenderTasksList(body);
  } catch (err) {
    crmErrorCard(body, err, renderCrmTasks);
  }
}

function crmRenderTasksList(body) {
  const filters = [
    ['open', t('Đang mở', 'Open')], ['overdue', t('Quá hạn', 'Overdue')],
    ['done', t('Đã xong', 'Done')], ['all', t('Tất cả', 'All')],
  ];
  const chips = filters.map(([key, label]) =>
    `<button class="chip ${crmState.taskFilter === key ? 'chip-active' : ''}" data-task-filter="${key}">${label}</button>`).join('');
  const rows = (crmState.tasks || []).map(task => `
    <tr class="${task.overdue ? 'crm-task-overdue' : ''}">
      <td style="width:36px;text-align:center">
        <input type="checkbox" data-task-done="${crmEsc(task.id)}" ${task.done_at ? 'checked' : ''}>
      </td>
      <td>
        <div style="font-weight:600;${task.done_at ? 'text-decoration:line-through;color:var(--muted)' : ''}">${crmEsc(task.title)}</div>
        ${task.note ? `<div style="color:var(--muted);font-size:12px">${crmEsc(task.note)}</div>` : ''}
      </td>
      <td style="white-space:nowrap">
        ${task.due_at ? `<span class="${task.overdue ? 'crm-overdue-badge' : ''}">${crmDate(task.due_at)}</span>` : '—'}
      </td>
      <td>${crmEsc(task.assignee || '—')}</td>
      <td style="text-align:right"><button class="btn danger" data-task-del="${crmEsc(task.id)}">✕</button></td>
    </tr>`).join('');

  body.innerHTML = `
    <div class="crm-toolbar"><div class="chips">${chips}</div></div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th></th><th>${t('Công việc', 'Task')}</th><th>${t('Hạn', 'Due')}</th><th>${t('Phụ trách', 'Assignee')}</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:28px">${t('Không có việc nào.', 'No tasks.')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  body.querySelectorAll('[data-task-filter]').forEach(el => el.addEventListener('click', () => {
    crmState.taskFilter = el.dataset.taskFilter;
    renderCrmTasks();
  }));
  body.querySelectorAll('[data-task-done]').forEach(el => el.addEventListener('change', async () => {
    try {
      await crmAction('crm-task-done', { id: el.dataset.taskDone, done: el.checked });
      renderCrmTasks();
    } catch (err) { showToast(err.message, 'error'); }
  }));
  body.querySelectorAll('[data-task-del]').forEach(el => el.addEventListener('click', async () => {
    try {
      await crmAction('crm-task-delete', { id: el.dataset.taskDel });
      renderCrmTasks();
    } catch (err) { showToast(err.message, 'error'); }
  }));
}

async function crmTaskModal() {
  let contactOptions = `<option value="">${t('— Không gắn —', '— None —')}</option>`;
  try {
    const res = await crmAction('crm-contacts-list', { limit: 200 });
    contactOptions += res.contacts.map(c => `<option value="${crmEsc(c.id)}">${crmEsc(c.display_name)}</option>`).join('');
  } catch (_) { }
  const ok = await openModal({
    title: t('Thêm công việc', 'Add task'),
    body: `<div class="crm-form">
      <label class="crm-field"><span>${t('Việc cần làm *', 'Task title *')}</span>
        <input type="text" id="crmTTitle"></label>
      <label class="crm-field"><span>${t('Hạn chót', 'Due')}</span>
        <input type="datetime-local" id="crmTDue"></label>
      <label class="crm-field"><span>${t('Khách hàng', 'Contact')}</span>
        <select id="crmTContact">${contactOptions}</select></label>
      <label class="crm-field"><span>${t('Nhóm Zalo', 'Zalo group')}</span>
        ${crmGroupSelect('crmTGroup')}</label>
      <label class="crm-field"><span>${t('Ghi chú', 'Note')}</span>
        <textarea id="crmTNote" rows="2"></textarea></label>
    </div>`,
    confirmText: t('Tạo', 'Create'),
  });
  if (!ok) return;
  const title = document.getElementById('crmTTitle')?.value.trim();
  if (!title) { showToast(t('Tiêu đề là bắt buộc', 'Title is required'), 'error'); return; }
  const dueRaw = document.getElementById('crmTDue')?.value;
  try {
    await crmAction('crm-task-create', {
      title,
      dueAt: dueRaw ? new Date(dueRaw).getTime() : null,
      contactId: document.getElementById('crmTContact')?.value || null,
      groupId: document.getElementById('crmTGroup')?.value || null,
      note: document.getElementById('crmTNote')?.value || '',
    });
    showToast(t('Đã tạo công việc', 'Task created'), 'success');
    renderCrmTasks();
  } catch (err) { showToast(err.message, 'error'); }
}
// ═══ END CRM MODULE ═══

// ══ LỊCH BÁO CÁO (menu con của Nhật ký) ═══════════════════════════════════════════════════════
// Một lịch = tập nhóm + giờ + nơi nhận + kiểu (lẻ từng nhóm / tổng hợp một tin). Thay cho 4 setting
// rời trên từng nhóm, vốn không thể diễn tả "12 nhóm này gộp một tin lúc 22:30".
//
// Thao tác hay làm nhất là ĐỔI GIỜ và THÊM/BỚT NHÓM, nên giờ sửa được ngay trên thẻ (không modal),
// còn bộ chọn nhóm có ô tìm kiếm + "tất cả" vì danh sách thực tế là vài chục nhóm.
let reportsState = { jobs: [], groups: [], state: {}, draft: null, search: '' };

async function reportsApi(action, payload) {
  const data = await api('/api/action', { method: 'POST', body: JSON.stringify({ action, payload }) });
  return data.result;
}

// ── Múi giờ hiển thị ──────────────────────────────────────────────────────────────────────────
// Mốc thời gian lưu trong dữ liệu là ISO UTC (`nowIso()`), nên hiển thị thô sẽ ra giờ UTC: báo cáo
// gửi 08:00 giờ VN hiện thành "01:00" và owner tưởng lịch chạy sai. Quy đổi ở tầng HIỂN THỊ, không
// đụng vào dữ liệu đã lưu — đổi múi giờ về sau không được làm sai mốc cũ.
const TZ_CHOICES = [
  ['Asia/Ho_Chi_Minh', 'Việt Nam (UTC+7)'],
  ['Asia/Bangkok', 'Bangkok (UTC+7)'],
  ['Asia/Singapore', 'Singapore (UTC+8)'],
  ['Asia/Shanghai', 'Trung Quốc (UTC+8)'],
  ['Asia/Tokyo', 'Nhật Bản (UTC+9)'],
  ['Asia/Seoul', 'Hàn Quốc (UTC+9)'],
  ['Europe/London', 'London (UTC+0/+1)'],
  ['America/Los_Angeles', 'Los Angeles (UTC-8/-7)'],
  ['UTC', 'UTC'],
];

function displayTz() {
  return localStorage.getItem('zaloDashboardTz') || 'Asia/Ho_Chi_Minh';
}

/** ISO (UTC) → "YYYY-MM-DD HH:MM" theo múi giờ owner đã chọn. */
function fmtTs(iso, { withTime = true } = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    const p = new Intl.DateTimeFormat('sv-SE', {
      timeZone: displayTz(), year: 'numeric', month: '2-digit', day: '2-digit',
      ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    }).format(d);
    return p.replace('T', ' ');
  } catch {
    // Múi giờ lạ (owner sửa tay localStorage) thì rơi về UTC thay vì vỡ cả trang.
    return d.toISOString().slice(0, withTime ? 16 : 10).replace('T', ' ');
  }
}

/** YYYY-MM-DD của N ngày trước theo GIỜ VN — lịch báo cáo luôn chạy theo giờ VN, không theo máy. */
function isoDaysAgo(n) {
  const vnNow = new Date(Date.now() + 7 * 3600 * 1000);
  vnNow.setUTCDate(vnNow.getUTCDate() - n);
  return vnNow.toISOString().slice(0, 10);
}

// ── Lịch sử báo cáo ───────────────────────────────────────────────────────────────────────────
// Owner hỏi "sáng nay bot gửi gì" và không có chỗ nào xem: gateway chat không hiện tin do plugin
// gửi, còn digest thì tính lúc chạy rồi thả đi. Trang này đọc bản ĐÃ LƯU lúc gửi — khác với bấm
// "Xem trước" lại, vì đổi danh sách nhóm về sau sẽ dựng ra kết quả khác bản đã gửi thật.
const reportLogState = { entries: [], keepDays: 90, f: { range: '7', kind: '', jobId: '', groupId: '', q: '' } };

async function renderReportLog() {
  const body = document.getElementById('reportLogBody');
  if (!body) return;
  body.innerHTML = `<div class="item-sub">${uiText('Đang tải...', 'Loading...')}</div>`;
  try {
    const d = await reportsApi('report-sent', { days: 90 });
    reportLogState.entries = d.entries || [];
    reportLogState.keepDays = d.keepDays || 90;
  } catch (e) {
    body.innerHTML = `<div class="item-sub">${uiText('Lỗi tải lịch sử', 'Failed to load log')}: ${esc(e.message)}</div>`;
    return;
  }
  reportLogRender();
}

/** Lọc theo đúng 4 trục owner cần: thời gian · loại · lịch · nhóm, cộng ô tìm trong nội dung. */
function reportLogFiltered() {
  const { range, kind, jobId, groupId, q } = reportLogState.f;
  const needle = foldVi(q);
  let cutoff = '';
  if (range !== 'all') {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (Number(range) - 1));
    cutoff = d.toISOString().slice(0, 10);
  }
  return reportLogState.entries.filter((e) => {
    if (cutoff && String(e.sentDate || '') < cutoff) return false;
    if (kind && e.kind !== kind) return false;
    if (jobId && e.jobId !== jobId) return false;
    if (groupId && !(e.scope || []).some(g => g.groupId === groupId)) return false;
    if (needle && !foldVi([(e.jobName || ''), (e.texts || []).join(' ')].join(' ')).includes(needle)) return false;
    return true;
  });
}

/**
 * Bỏ dấu + hạ chữ — owner gõ "tong hop" phải tìm ra "Tổng Hợp".
 *
 * `đ` KHÔNG phải dấu tổ hợp nên `NFD` không tách nó: thiếu dòng thay `đ→d` thì "van don" không bao
 * giờ khớp "vận đơn", trong khi "tong hop" vẫn khớp — kiểu lỗi tìm-kiếm-lúc-được-lúc-không.
 */
function foldVi(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .trim();
}

function reportLogRender() {
  const body = document.getElementById('reportLogBody');
  if (!body) return;
  const all = reportLogState.entries;
  const rows = reportLogFiltered();
  const jobs = [...new Map(all.map(e => [e.jobId, e.jobName])).entries()];
  const groups = [...new Map(all.flatMap(e => (e.scope || []).map(g => [g.groupId, g.name]))).entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'vi'));
  const f = reportLogState.f;

  const sel = (attr, cur, opts, allLabel) => `<select data-rlog="${attr}"
    style="width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);font-size:12.5px">
    <option value="">${allLabel}</option>
    ${opts.map(([v, l]) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
  </select>`;
  const fBlock = (label, inner) => `<div style="margin-bottom:12px">
    <div style="font-size:11px;font-weight:650;letter-spacing:.03em;opacity:.6;margin-bottom:5px;text-transform:uppercase">${label}</div>${inner}</div>`;

  // Bề ngang cột lọc do class `.rlog-side` trong dashboard.css quyết định (có media query): desktop
  // 214px đứng cạnh danh sách, dưới 720px thì chiếm trọn chiều ngang. Inline style không làm được
  // vì `max-width` chặn luôn cả khi đã xuống dòng.
  const sidebar = `<aside class="rlog-side">
    <div class="card" style="padding:14px">
      ${fBlock(uiText('Thời gian', 'Time range'), sel('range', f.range, [
        ['1', uiText('Hôm nay', 'Today')], ['7', uiText('7 ngày qua', 'Last 7 days')],
        ['30', uiText('30 ngày qua', 'Last 30 days')], ['all', uiText('Tất cả', 'All')],
      ], uiText('Tất cả', 'All')).replace('<option value=""', '<option value="all" hidden'))}
      ${fBlock(uiText('Loại báo cáo', 'Type'), sel('kind', f.kind, [
        ['digest', '📊 ' + uiText('Tổng hợp', 'Digest')], ['group', '📋 ' + uiText('Từng nhóm', 'Per group')],
      ], uiText('Mọi loại', 'All types')))}
      ${fBlock(uiText('Theo lịch', 'Schedule'), sel('jobId', f.jobId, jobs, uiText('Mọi lịch', 'All schedules')))}
      ${fBlock(uiText('Có nhóm', 'Includes group'), sel('groupId', f.groupId, groups, uiText('Mọi nhóm', 'All groups')))}
      ${fBlock(uiText('Tìm trong nội dung', 'Search text'), `<input type="search" data-rlog="q" value="${esc(f.q)}"
        placeholder="${uiText('vd: mã vận đơn', 'e.g. tracking code')}"
        style="width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);font-size:12.5px"/>`)}
      <button class="btn" type="button" data-rlog-reset style="width:100%;min-height:0;height:30px;font-size:12px">${uiText('Bỏ lọc', 'Clear filters')}</button>
      <div id="reportLogCount" class="item-sub" style="margin-top:10px;font-size:11px;line-height:1.6">${uiText(
        `Hiện ${rows.length}/${all.length} bản · lưu ${reportLogState.keepDays} ngày`,
        `Showing ${rows.length}/${all.length} · kept ${reportLogState.keepDays} days`)}</div>
    </div>
  </aside>`;

  body.innerHTML = `<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
    ${sidebar}
    <div id="reportLogList" style="flex:1 1 380px;min-width:0;display:flex;flex-direction:column;gap:10px">${reportLogListHtml(rows, all.length)}</div>
  </div>`;
}

function reportLogListHtml(rows, total) {
  if (rows.length) return rows.map(reportLogCard).join('');
  return `<div class="card" style="padding:22px;text-align:center">
    <div style="font-size:14px;font-weight:600;margin-bottom:4px">${total
      ? uiText('Không có bản nào khớp bộ lọc', 'No entries match these filters')
      : uiText('Chưa có báo cáo nào được gửi', 'No reports sent yet')}</div>
    <div class="item-sub">${total
      ? uiText('Thử bỏ bớt điều kiện ở cột bên trái.', 'Try clearing some filters on the left.')
      : uiText('Bản ghi được tạo từ lần gửi kế tiếp trở đi.', 'Entries appear from the next send onward.')}</div>
  </div>`;
}

/**
 * Vẽ lại CHỈ danh sách, giữ nguyên sidebar.
 *
 * Ô tìm kiếm lọc theo từng phím, mà vẽ lại cả trang thì input bị thay mới → mất con trỏ, gõ được
 * đúng một ký tự. Nên phần đang được gõ phải đứng yên.
 */
function reportLogRenderList() {
  const el = document.getElementById('reportLogList');
  if (!el) return;
  const rows = reportLogFiltered();
  el.innerHTML = reportLogListHtml(rows, reportLogState.entries.length);
  const counter = document.getElementById('reportLogCount');
  if (counter) {
    counter.textContent = uiText(
      `Hiện ${rows.length}/${reportLogState.entries.length} bản · lưu ${reportLogState.keepDays} ngày`,
      `Showing ${rows.length}/${reportLogState.entries.length} · kept ${reportLogState.keepDays} days`);
  }
}

function reportLogCard(e) {
  const isDigest = e.kind === 'digest';
  const full = (e.texts || []).join('\n\n');
  const preview = full.split('\n').slice(0, 3).join(' · ').slice(0, 150);
  const when = fmtTs(e.sentAt);
  return `<div class="card" style="padding:13px 15px">
    <div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
      <div style="flex:1 1 200px;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-weight:650;font-size:14px">${esc(e.jobName || e.jobId)}</span>
          <span class="chip" style="background:${isDigest ? 'rgba(96,165,250,.16)' : 'rgba(148,163,184,.16)'}">
            ${isDigest ? '📊 ' + uiText('Tổng hợp', 'Digest') : '📋 ' + uiText('Từng nhóm', 'Per group')}</span>
          ${e.trigger === 'manual' ? `<span class="chip" style="background:rgba(251,191,36,.18)">${uiText('Gửi tay', 'Manual')}</span>` : ''}
        </div>
        <div class="item-sub" style="margin-top:6px;line-height:1.65">
          ${uiText('Gửi', 'Sent')} <b>${esc(when)}</b> · ${uiText('nội dung ngày', 'covers')} <b>${esc(e.date || '')}</b>
          ${/* "phạm vi" chứ không phải "nhóm" trần: con số này là số nhóm lịch QUÉT, khác với số nhóm
                CÓ TIN in trong thân báo cáo. Hai số nằm cạnh nhau mà cùng gọi là "nhóm" thì owner
                đọc vào tưởng số liệu đá nhau — đã hỏi thật. */''}
          · ${uiText('phạm vi', 'scope')} ${(e.scope || []).length} ${uiText('nhóm', 'groups')}
          · ${e.chars || 0} ${uiText('ký tự', 'chars')}
          <br>${uiText('Tới', 'To')}: ${(e.targets || []).map(t => esc(t.name)).join(', ') || '—'}
        </div>
      </div>
      <button class="btn" type="button" data-rlog-view="${esc(e.id)}"
        style="min-height:0;height:28px;padding:0 10px;font-size:11.5px;white-space:nowrap;flex:none">${uiText('Xem nội dung', 'View')}</button>
    </div>
    <div class="item-sub" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);opacity:.8;font-size:12px">${esc(preview)}${full.length > 150 ? '…' : ''}</div>
  </div>`;
}

function reportLogOpen(id) {
  const e = reportLogState.entries.find(x => x.id === id);
  if (!e) return;
  const body = (e.texts || []).map((t, i) => `${(e.texts.length > 1)
    ? `<div style="font-size:11.5px;font-weight:650;opacity:.6;margin:${i ? '14px' : '0'} 0 6px">${uiText('Tin', 'Message')} ${i + 1}/${e.texts.length}</div>` : ''}
    <pre style="white-space:pre-wrap;word-break:break-word;margin:0;font-family:inherit;font-size:13px;line-height:1.65;
      background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:12px">${esc(t)}</pre>`).join('');
  openModal({
    title: `${e.jobName || e.jobId} — ${e.date}`,
    body: `<div class="item-sub" style="margin-bottom:10px">${uiText('Gửi lúc', 'Sent at')} ${esc(fmtTs(e.sentAt))}
      · ${uiText('tới', 'to')} ${(e.targets || []).map(t => esc(t.name)).join(', ') || '—'}</div>${body}`,
    confirmText: uiText('Đóng', 'Close'),
  });
}

async function renderReports() {
  const body = document.getElementById('reportsBody');
  if (!body) return;
  body.innerHTML = `<div class="item-sub">${uiText('Đang tải...', 'Loading...')}</div>`;
  try {
    const d = await reportsApi('report-jobs', {});
    reportsState.jobs = d.jobs || [];
    reportsState.groups = d.groups || [];
    reportsState.state = d.state || {};
  } catch (e) {
    body.innerHTML = `<div class="item-sub">${uiText('Lỗi tải lịch báo cáo', 'Failed to load schedules')}: ${esc(e.message)}</div>`;
    return;
  }
  body.innerHTML = reportsListHtml();
}

function reportGroupName(gid) {
  return (reportsState.groups.find(g => g.groupId === gid) || {}).name || gid;
}

function reportDeliverSummary(job) {
  const bits = [];
  if (job.deliver.ownerDm) bits.push(uiText('DM owner', 'Owner DM'));
  if (job.deliver.eachGroup) bits.push(uiText('chính nhóm đó', 'the group itself'));
  for (const gid of job.deliver.groups) bits.push(`→ ${reportGroupName(gid)}`);
  return bits.length ? bits.join(' · ') : `⚠️ ${uiText('chưa chọn nơi nhận', 'no destination')}`;
}

function reportsListHtml() {
  const jobs = reportsState.jobs;
  if (!jobs.length) {
    return `<div class="card" style="padding:22px;text-align:center">
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">${uiText('Chưa có lịch báo cáo nào', 'No report schedules yet')}</div>
      <div class="item-sub" style="margin-bottom:14px">${uiText('Tạo một lịch để bot tự gửi tổng hợp lịch sử chat mỗi ngày.', 'Create a schedule so the bot sends a daily chat digest.')}</div>
      <button class="btn primary" data-action="report-job-new">+ ${uiText('Tạo lịch', 'New schedule')}</button>
    </div>`;
  }
  return `<div style="display:flex;flex-direction:column;gap:12px">${jobs.map(reportJobCardHtml).join('')}</div>`;
}

const REPORT_ICONS = {
  preview: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.9"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="m14.5 5.5 4 4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M21.5 2.5 2 11l7 2.5L11.5 21l10-18.5Z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 13.5 21.5 2.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  del: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7m-8 0 1 13h8l1-13" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.9"/><path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
};

/**
 * Cảnh báo cấu hình tự đá nhau: giờ gửi buổi sáng mà nội dung lấy "hôm nay".
 *
 * Đây là cái bẫy im lặng — lịch vẫn chạy, vẫn gửi, nhưng tin gần như trống vì lúc 08:00 ngày mới chỉ
 * có mấy tiếng đầu. Owner sẽ tưởng bot hỏng chứ không nghĩ là cấu hình.
 */
function reportMorningWarning(job) {
  const hour = Number(String(job.time || '').slice(0, 2));
  if (!Number.isFinite(hour) || hour >= 12 || job.reportFor === 'yesterday') return '';
  return `<br><span style="color:var(--warn,#f59e0b)">⚠️ ${uiText(
    `Gửi lúc ${job.time} nhưng nội dung lấy "hôm nay" — sẽ gần như trống. Sửa thành "Hôm qua".`,
    `Runs at ${job.time} but covers "today" — will be nearly empty. Change it to "Yesterday".`)}</span>`;
}

function reportJobCardHtml(job) {
  const isDigest = job.kind === 'digest';
  const ran = reportsState.state[job.id];
  // "Phạm vi N nhóm" = số nhóm lịch QUÉT. Báo cáo gửi ra chỉ liệt kê những nhóm CÓ TIN hôm đó, nên
  // hai con số lệch nhau là bình thường — nói rõ ở đây để owner không tưởng số liệu sai.
  const scope = job.groups === '*'
    ? `${uiText('Tất cả nhóm follow', 'All followed groups')} (${job.resolvedCount})`
    : `${uiText('Phạm vi', 'Scope')} ${job.resolvedCount} ${uiText('nhóm', 'groups')}`;
  // Nút gạt và giờ xếp dọc ở cột phải: bật/tắt là quyết định "có chạy không", giờ là "chạy lúc nào" —
  // cùng một cột nên đọc theo thứ tự đó.
  return `<div class="card" style="padding:14px 16px">
    <div style="display:flex;align-items:flex-start;gap:12px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
          <span style="font-weight:650;font-size:14.5px">${esc(job.name)}</span>
          <span class="chip" style="background:${isDigest ? 'rgba(96,165,250,.16)' : 'rgba(148,163,184,.16)'}">
            ${isDigest ? '📊 ' + uiText('Tổng hợp', 'Digest') : '📋 ' + uiText('Từng nhóm', 'Per group')}
          </span>
          ${job.reportFor === 'yesterday'
            ? `<span class="chip" style="background:rgba(52,211,153,.16)">🌅 ${uiText('Nội dung: hôm qua', 'Covers: yesterday')}</span>`
            : ''}
        </div>
        <div class="item-sub" style="margin-top:8px;line-height:1.7">
          ${scope} &nbsp;·&nbsp; ${esc(reportDeliverSummary(job))}
          ${ran ? `<br>${uiText('Lần cuối', 'Last run')}: ${ran.date} ${ran.time}` : ''}
          ${reportMorningWarning(job)}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex:0 0 auto">
        <label class="journal-switch" title="${uiText('Bật/tắt lịch này', 'Enable/disable')}">
          <input type="checkbox" data-report-toggle="${job.id}" ${job.enabled ? 'checked' : ''}/>
          <span class="journal-slider"></span>
        </label>
        <label class="report-time-field">${REPORT_ICONS.clock}
          <input type="time" value="${job.time}" data-report-time="${job.id}"/>
        </label>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;justify-content:flex-end">
      ${isDigest ? `<button class="btn" data-report-preview="${job.id}">${REPORT_ICONS.preview}<span>${uiText('Xem trước', 'Preview')}</span></button>` : ''}
      <button class="btn outline-primary" data-report-edit="${job.id}">${REPORT_ICONS.edit}<span>${uiText('Sửa', 'Edit')}</span></button>
      <button class="btn primary" data-report-run="${job.id}">${REPORT_ICONS.send}<span>${uiText('Gửi ngay', 'Send now')}</span></button>
      <button class="btn danger" data-report-delete="${job.id}">${REPORT_ICONS.del}<span>${uiText('Xoá', 'Delete')}</span></button>
    </div>
  </div>`;
}

// ── Trình sửa lịch ────────────────────────────────────────────────────────────────────────────
function reportEditorHtml() {
  const j = reportsState.draft;
  const isDigest = j.kind === 'digest';
  const all = j.groups === '*';
  const q = reportsState.search.trim().toLowerCase();
  const list = reportsState.groups.filter(g => !q || g.name.toLowerCase().includes(q));
  const picked = new Set(all ? [] : j.groups);
  const field = (label, inner) => `<div style="margin-bottom:14px">
    <div style="font-size:12px;font-weight:650;letter-spacing:.02em;opacity:.72;margin-bottom:6px;text-transform:uppercase">${label}</div>${inner}</div>`;
  const kindBtn = (k, icon, label, hint) => `<button type="button" data-report-kind="${k}"
    style="flex:1;min-width:150px;text-align:left;padding:10px 12px;border-radius:10px;cursor:pointer;
    border:1.5px solid ${j.kind === k ? 'var(--primary)' : 'var(--line)'};
    background:${j.kind === k ? 'rgba(96,165,250,.10)' : 'var(--surface-2)'};color:var(--text)">
    <div style="font-weight:650;font-size:13.5px">${icon} ${label}</div>
    <div style="font-size:11.5px;opacity:.7;margin-top:3px;line-height:1.5">${hint}</div></button>`;
  const check = (attr, on, label, hint = '', disabled = false) => `<label class="report-check" style="padding:8px 10px;border-radius:9px;
    background:var(--surface-2);margin-bottom:6px;cursor:${disabled ? 'not-allowed' : 'pointer'};opacity:${disabled ? '.45' : '1'}">
    <input type="checkbox" ${attr} ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}/>
    <span><span style="font-size:13.5px">${label}</span>${hint ? `<br><span style="font-size:11.5px;opacity:.7">${hint}</span>` : ''}</span></label>`;

  return `<div>
    ${field(uiText('Tên lịch', 'Name'), `<input type="text" value="${esc(j.name)}" data-report-name
      style="width:100%;padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);font-size:13.5px"/>`)}

    ${field(uiText('Kiểu báo cáo', 'Report type'), `<div style="display:flex;gap:8px;flex-wrap:wrap">
      ${kindBtn('group', '📋', uiText('Từng nhóm', 'Per group'), uiText('Mỗi nhóm một tin đầy đủ như hiện tại', 'One full report per group'))}
      ${kindBtn('digest', '📊', uiText('Tổng hợp', 'Digest'), uiText('Gộp tất cả nhóm đã chọn vào một tin ngắn', 'All selected groups in one short message'))}
    </div>`)}

    ${field(uiText('Giờ gửi mỗi ngày', 'Daily time'), `<input type="time" value="${j.time}" data-report-draft-time
      style="padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);font-size:13.5px"/>`)}

    ${field(uiText('Báo cáo cho ngày nào', 'Report covers'), `
      <select data-report-for style="width:100%;padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);font-size:13.5px">
        <option value="today" ${j.reportFor !== 'yesterday' ? 'selected' : ''}>${uiText('Hôm nay — dùng cho lịch cuối ngày', 'Today — for end-of-day schedules')}</option>
        <option value="yesterday" ${j.reportFor === 'yesterday' ? 'selected' : ''}>${uiText('Hôm qua — dùng cho lịch buổi sáng', 'Yesterday — for morning schedules')}</option>
      </select>
      <div class="item-sub" style="margin-top:5px;font-size:11.5px">${
        j.reportFor === 'yesterday'
          ? uiText('Đúng cho lịch sáng: 08:00 hôm nay sẽ báo cáo trọn ngày hôm qua.',
            'Right for a morning run: 08:00 today reports all of yesterday.')
          : uiText('⚠️ Nếu giờ gửi vào buổi sáng, chọn "Hôm qua" — không thì báo cáo chỉ có mấy tiếng đầu ngày, gần như trống.',
            '⚠️ For a morning time, pick "Yesterday" — otherwise the report only covers the first hours of the day.')
      }</div>`)}

    ${field(`${uiText('Nhóm áp dụng', 'Groups')} — ${all ? uiText('tất cả', 'all') : `${picked.size}/${reportsState.groups.length}`}`, `
      <label class="report-check report-check--center" style="padding:9px 11px;border-radius:9px;background:var(--surface-2);margin-bottom:8px">
        <input type="checkbox" data-report-all ${all ? 'checked' : ''}/>
        <span style="font-size:13.5px">${uiText('Tất cả nhóm đang follow', 'All followed groups')}
        <span style="opacity:.65">— ${uiText('nhóm mới thêm sau cũng tự vào lịch này', 'new groups join automatically')}</span></span>
      </label>
      <div style="opacity:${all ? '.4' : '1'};pointer-events:${all ? 'none' : 'auto'}">
        <input type="search" placeholder="${uiText('Tìm nhóm...', 'Search groups...')}" value="${esc(reportsState.search)}" data-report-search
          style="width:100%;padding:8px 11px;border-radius:9px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);font-size:13px;margin-bottom:6px"/>
        <div style="max-height:210px;overflow:auto;border:1px solid var(--line);border-radius:9px;padding:6px">
          ${list.length ? list.map(g => `<label class="report-check report-check--center" style="padding:6px 8px;border-radius:7px">
            <input type="checkbox" data-report-group="${g.groupId}" ${picked.has(g.groupId) ? 'checked' : ''}/>
            <span style="font-size:13px">${esc(g.name)}</span></label>`).join('')
            : `<div class="item-sub" style="padding:8px">${uiText('Không có nhóm khớp', 'No match')}</div>`}
        </div>
      </div>`)}

    ${field(uiText('Nơi nhận báo cáo', 'Send to'), `
      ${check('data-report-owner', j.deliver.ownerDm, `👤 ${uiText('DM riêng owner', 'Owner DM')}`)}
      ${check('data-report-each', j.deliver.eachGroup, `💬 ${uiText('Chính nhóm đó nhận', 'The group itself')}`,
        isDigest ? uiText('Không dùng được với báo cáo tổng hợp — một tin gộp không thuộc nhóm nào', 'Not available for a digest — one message has no single group') : '', isDigest)}
      ${check('data-report-pickgroup', j.deliver.groups.length > 0, `📢 ${uiText('Nhóm nhận báo cáo chung', 'A dedicated group')}`)}
      <div style="opacity:${j.deliver.groups.length ? '1' : '.4'};pointer-events:${j.deliver.groups.length ? 'auto' : 'none'};margin-left:28px">
        <select data-report-target style="width:100%;padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);font-size:13px">
          <option value="">${uiText('— chọn nhóm nhận —', '— pick a group —')}</option>
          ${reportsState.groups.map(g => `<option value="${g.groupId}" ${j.deliver.groups[0] === g.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select>
      </div>`)}
  </div>`;
}

function reportsRerenderEditor() {
  if (!modalBackdrop.classList.contains('open')) return;
  modalBody.innerHTML = reportEditorHtml();
}

async function openReportEditor(job) {
  reportsState.draft = JSON.parse(JSON.stringify(job));
  reportsState.search = '';
  const ok = await openModal({
    title: job.id && reportsState.jobs.some(j => j.id === job.id)
      ? uiText('Sửa lịch báo cáo', 'Edit schedule')
      : uiText('Tạo lịch báo cáo', 'New schedule'),
    body: reportEditorHtml(),
    confirmText: uiText('Lưu', 'Save'),
  });
  if (!ok) return;
  try {
    await reportsApi('report-job-save', { job: reportsState.draft });
    showToast(uiText('Đã lưu lịch báo cáo', 'Schedule saved'), 'success');
    await renderReports();
  } catch (e) {
    showToast(uiText('Lưu thất bại', 'Save failed') + ': ' + e.message, 'error');
  }
}

function newReportJob() {
  return {
    id: `job-${Date.now().toString(36)}`,
    // Mặc định 22:30 là lịch cuối ngày, nên nội dung 'today' mới đúng. Owner đổi sang giờ sáng thì
    // thẻ lịch hiện cảnh báo (reportMorningWarning) nhắc đổi sang 'yesterday'.
    name: '', enabled: true, kind: 'digest', groups: '*', time: '22:30', reportFor: 'today',
    deliver: { ownerDm: true, eachGroup: false, groups: [] },
  };
}

// ── Handler: uỷ quyền sự kiện cho cả thẻ lịch và trình sửa ────────────────────────────────────
document.addEventListener('click', async (ev) => {
  const t = ev.target;
  const hit = (attr) => t.closest?.(`[${attr}]`)?.getAttribute(attr);

  const rlogView = hit('data-rlog-view');
  if (rlogView) { reportLogOpen(rlogView); return; }
  if (t.closest?.('[data-goto-reportlog]')) { setSection('reportlog'); return; }
  if (t.closest?.('[data-rlog-reset]')) {
    reportLogState.f = { range: '7', kind: '', jobId: '', groupId: '', q: '' };
    reportLogRender();
    return;
  }

  if (t.closest?.('[data-action="report-job-new"]')) { await openReportEditor(newReportJob()); return; }
  if (t.closest?.('[data-goto-reports]')) { if (modalBackdrop.classList.contains('open')) modalResolve?.(false); setSection('reports'); return; }

  const editId = hit('data-report-edit');
  if (editId) {
    const job = reportsState.jobs.find(j => j.id === editId);
    if (job) await openReportEditor(job);
    return;
  }

  const delId = hit('data-report-delete');
  if (delId) {
    const job = reportsState.jobs.find(j => j.id === delId);
    const ok = await openModal({
      title: uiText('Xoá lịch báo cáo?', 'Delete schedule?'),
      desc: job ? job.name : '',
      body: `<div class="item-sub">${uiText('Các nhóm trong lịch này sẽ không còn nhận báo cáo tự động.', 'Groups in this schedule stop receiving automatic reports.')}</div>`,
      confirmText: uiText('Xoá', 'Delete'), danger: true, tone: 'warning',
    });
    if (!ok) return;
    try { await reportsApi('report-job-delete', { id: delId }); showToast(uiText('Đã xoá', 'Deleted'), 'success'); await renderReports(); }
    catch (e) { showToast(e.message, 'error'); }
    return;
  }

  const runId = hit('data-report-run');
  if (runId) {
    const job = reportsState.jobs.find(j => j.id === runId);
    if (!job) return;
    // Nút này GỬI THẬT tới nhóm khách, không phải chạy thử — tên cũ "Gửi thử" nói dối về hậu quả.
    // Với lịch "từng nhóm + mỗi nhóm tự nhận" thì một cú bấm là N tin vào N nhóm khách. Phải nói rõ
    // đi đâu và bao nhiêu tin TRƯỚC khi gửi.
    const dests = [];
    if (job.deliver.ownerDm) dests.push(uiText('DM riêng của bạn', 'your DM'));
    if (job.deliver.eachGroup) dests.push(uiText(`CHÍNH ${job.resolvedCount} nhóm trong phạm vi`, `EACH of the ${job.resolvedCount} groups in scope`));
    for (const gid of job.deliver.groups) dests.push(reportGroupName(gid));
    const msgCount = job.kind === 'digest' ? 1 : job.resolvedCount;
    const ok = await openModal({
      title: uiText('Gửi báo cáo ngay?', 'Send report now?'),
      desc: uiText('Đây là gửi THẬT, không phải chạy thử.', 'This sends for real — not a dry run.'),
      body: `<div class="item-sub" style="line-height:1.8">
        <div>${uiText('Lịch', 'Schedule')}: <b>${esc(job.name)}</b></div>
        <div>${uiText('Nội dung ngày', 'Covers')}: <b>${job.reportFor === 'yesterday' ? isoDaysAgo(1) : isoDaysAgo(0)}</b></div>
        <div>${uiText('Sẽ gửi tới', 'Sends to')}: <b>${esc(dests.join(', ') || '—')}</b></div>
        <div>${uiText('Số tin', 'Messages')}: <b>${msgCount}</b></div>
      </div>`,
      confirmText: uiText('Gửi ngay', 'Send now'),
      danger: true,
      tone: 'warn',
    });
    if (!ok) return;
    const btn = t.closest('[data-report-run]');
    if (!btn) return;
    btn.disabled = true; btn.textContent = uiText('Đang gửi...', 'Sending...');
    try {
      const r = await reportsApi('report-job-run', { id: runId });
      showToast(uiText(`Đã gửi ${r.sent} tin cho ${r.groups} nhóm`, `Sent ${r.sent} message(s) for ${r.groups} group(s)`), 'success');
    } catch (e) { showToast(uiText('Gửi thất bại', 'Send failed') + ': ' + e.message, 'error'); }
    await renderReports();
    return;
  }

  // Xem trước ĐÚNG chuỗi sẽ gửi, kèm số ký tự và số phần — để owner biết trước có bị tách tin không.
  const prevId = hit('data-report-preview');
  if (prevId) {
    const job = reportsState.jobs.find(j => j.id === prevId);
    if (!job) return;
    try {
      // Xem trước phải theo ĐÚNG NGÀY lịch sẽ báo cáo. Trước đây luôn lấy hôm nay, nên xem trước
      // một lịch buổi sáng (reportFor: yesterday) ra tin rỗng của ngày vừa bắt đầu — owner tưởng
      // tính năng hỏng, đúng lúc đang nghi ngờ nó.
      const r = await reportsApi('report-digest-preview', {
        groups: job.groups,
        date: job.reportFor === 'yesterday' ? isoDaysAgo(1) : undefined,
      });
      await openModal({
        title: uiText('Xem trước báo cáo tổng hợp', 'Digest preview'),
        desc: uiText(`${r.date} · ${r.chars} ký tự · ${r.parts} tin`, `${r.date} · ${r.chars} chars · ${r.parts} message(s)`),
        body: r.texts.map((tx, i) => `<div style="margin-bottom:12px">
          ${r.texts.length > 1 ? `<div style="font-size:11.5px;opacity:.7;margin-bottom:4px">${uiText('Tin', 'Message')} ${i + 1}/${r.texts.length}</div>` : ''}
          <pre style="white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.65;background:var(--surface-2);padding:12px;border-radius:9px;margin:0;font-family:inherit">${esc(tx)}</pre></div>`).join(''),
        confirmText: uiText('Đóng', 'Close'),
      });
    } catch (e) { showToast(e.message, 'error'); }
    return;
  }

  // ── Trong trình sửa ──
  const kind = hit('data-report-kind');
  if (kind && reportsState.draft) {
    reportsState.draft.kind = kind;
    // Một tin gộp không thuộc nhóm nào nên "chính nhóm đó nhận" mất nghĩa — tắt luôn để state không
    // lưu một cấu hình không thể thực hiện.
    if (kind === 'digest') reportsState.draft.deliver.eachGroup = false;
    reportsRerenderEditor();
    return;
  }
});

// Ô tìm trong lịch sử báo cáo lọc theo TỪNG PHÍM; `change` chỉ nổ khi blur nên phải nghe `input`.
document.addEventListener('input', (ev) => {
  if (ev.target?.getAttribute?.('data-rlog') !== 'q') return;
  reportLogState.f.q = ev.target.value;
  reportLogRenderList();
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  const d = reportsState.draft;

  // Bộ lọc lịch sử báo cáo — lọc ngay ở client (mỗi ngày vài bản ghi) nên không gọi lại server.
  const rlogKey = t.getAttribute?.('data-rlog');
  if (rlogKey) {
    reportLogState.f[rlogKey] = t.value;
    // Đổi <select> thì vẽ lại cả trang (danh sách nhóm/lịch trong sidebar không đổi nên an toàn);
    // riêng ô tìm kiếm chỉ vẽ lại danh sách để không cướp con trỏ.
    if (rlogKey === 'q') reportLogRenderList(); else reportLogRender();
    return;
  }

  const toggleId = t.getAttribute?.('data-report-toggle');
  if (toggleId) {
    const job = reportsState.jobs.find(j => j.id === toggleId);
    if (!job) return;
    job.enabled = t.checked;
    try { await reportsApi('report-job-save', { job }); showToast(job.enabled ? uiText('Đã bật lịch', 'Enabled') : uiText('Đã tắt lịch', 'Disabled'), 'success'); }
    catch (e) { showToast(e.message, 'error'); await renderReports(); }
    return;
  }

  // Đổi giờ ngay trên thẻ — việc hay làm nhất, không đáng phải mở modal.
  const timeId = t.getAttribute?.('data-report-time');
  if (timeId) {
    const job = reportsState.jobs.find(j => j.id === timeId);
    if (!job) return;
    job.time = t.value || job.time;
    try { await reportsApi('report-job-save', { job }); showToast(uiText(`Đã đổi giờ → ${job.time}`, `Time → ${job.time}`), 'success'); }
    catch (e) { showToast(e.message, 'error'); }
    return;
  }

  if (!d) return;
  if (t.hasAttribute?.('data-report-name')) { d.name = t.value; return; }
  if (t.hasAttribute?.('data-report-draft-time')) { d.time = t.value || d.time; return; }
  if (t.hasAttribute?.('data-report-for')) { d.reportFor = t.value; reportsRerenderEditor(); return; }
  if (t.hasAttribute?.('data-report-all')) {
    d.groups = t.checked ? '*' : [];
    reportsRerenderEditor();
    return;
  }
  const gid = t.getAttribute?.('data-report-group');
  if (gid) {
    if (d.groups === '*') d.groups = [];
    d.groups = t.checked ? [...new Set([...d.groups, gid])] : d.groups.filter(x => x !== gid);
    reportsRerenderEditor();
    return;
  }
  if (t.hasAttribute?.('data-report-owner')) { d.deliver.ownerDm = t.checked; return; }
  if (t.hasAttribute?.('data-report-each')) { d.deliver.eachGroup = t.checked; return; }
  if (t.hasAttribute?.('data-report-pickgroup')) {
    d.deliver.groups = t.checked ? (d.deliver.groups.length ? d.deliver.groups : [reportsState.groups[0]?.groupId].filter(Boolean)) : [];
    reportsRerenderEditor();
    return;
  }
  if (t.hasAttribute?.('data-report-target')) { d.deliver.groups = t.value ? [t.value] : []; return; }
});

document.addEventListener('input', (ev) => {
  if (ev.target.hasAttribute?.('data-report-search')) {
    reportsState.search = ev.target.value;
    const box = modalBody.querySelector('[data-report-search]');
    const sel = box && box.selectionStart;
    reportsRerenderEditor();
    const again = modalBody.querySelector('[data-report-search]');
    if (again) { again.focus(); try { again.setSelectionRange(sel, sel); } catch {} }
  }
});

// ── Khung chat ──────────────────────────────────────────────────────────────
//
// Đọc từ `context.db` (tin trực tiếp + lịch sử kéo về), KHÔNG hỏi Zalo mỗi lần mở — nên chuyển
// hội thoại là tức thì và không đụng hạn mức API. Đổi lại chỉ thấy được phần đã đồng bộ, nên mô tả
// trang nói thẳng điều đó thay vì để owner tưởng mất tin.
//
// Làm mới bằng POLLING chứ chưa phải SSE: đường đẩy realtime là việc riêng, và tách ra thế này thì
// khi có SSE chỉ cần thay đúng hàm hẹn giờ, không phải dựng lại giao diện.

const chatState = {
  conversations: [],
  activeId: null,
  messages: [],
  search: '',
  filter: 'all',       // all | dm | group
  pollTimer: null,
  sending: false,
  lastSig: '',
  // Cột trợ lý AI
  aiOpen: true,
  aiContextOn: true,
  aiContextCount: 30,
  aiBusy: false,
  aiThread: [],      // { role: 'ai'|'me', text, canUse }
  suggestions: [],
  bot: null,
};

// 4 giây thay vì 12: nhịp poll giờ chỉ hỏi một dấu-vân-tay (0.01ms phía server, rẻ hơn 48 lần so
// với dựng lại cả danh sách), nên poll dày gấp 3 mà tổng chi phí vẫn thấp hơn bản cũ. Đây là lý do
// KHÔNG cần SSE: thứ SSE mua được chỉ là độ trễ, mà 4 giây đã đủ để trực chat.
const CHAT_POLL_MS = 4000;

/**
 * Khung chat LUÔN thuộc về đúng một bot.
 *
 * Mỗi bot là một tài khoản Zalo riêng: cùng một người có uid khác nhau ở mỗi tài khoản, và hộp thư
 * của bot này không phải hộp thư của bot kia. Trộn chung ở chế độ "Tất cả bot" ra một danh sách
 * không khớp với lịch sử thật của bất kỳ tài khoản nào — nhìn thì có dữ liệu, nhưng sai.
 *
 * Chọn "Tất cả bot" thì lấy bot ĐẦU TIÊN và nói rõ đang xem hộp thư của ai, thay vì để trắng trang
 * bắt owner đi tìm thanh chọn bot.
 */
function chatProfile() {
  const bots = (state && state.bots) || [];
  const known = (p) => p && bots.some(b => b.profile === p);
  // 1) Bot đang chọn ở topbar thắng tuyệt đối.
  if (selectedBotFilter && selectedBotFilter !== 'all') return selectedBotFilter;
  // 2) Tải lại trang thì `selectedBotFilter` về 'all' và khung chat rơi về bot đầu danh sách — tức
  //    đang xem hộp thư của người khác so với lúc trước khi tải lại. Nhớ lại lựa chọn gần nhất.
  //    Kiểm `known()` phòng bot bị gỡ khỏi cấu hình: giá trị cũ trong localStorage sẽ trỏ vào hư vô.
  try {
    const saved = localStorage.getItem('zaloChatBot');
    if (known(saved)) return saved;
  } catch { /* trình duyệt chặn localStorage */ }
  return bots[0]?.profile || 'default';
}

function chatStopPolling() {
  if (chatState.pollTimer) {
    clearInterval(chatState.pollTimer);
    chatState.pollTimer = null;
  }
}

/** Mốc thời gian ngắn kiểu ứng dụng chat: hôm nay thì giờ:phút, cũ hơn thì ngày/tháng. */
function chatTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mo}`;
}

async function renderChat() {
  const head = document.querySelector('#chat .page-head');
  if (head) {
    head.querySelector('h2').textContent = t('Khung chat', 'Chat');
    head.querySelector('p').textContent = t(
      'Đọc lại hội thoại Zalo và trả lời trực tiếp — lịch sử kéo về khi bấm Sync account.',
      'Read Zalo conversations and reply directly — history is pulled on Sync account.');
  }
  const actions = document.getElementById('chatActions');
  if (actions) {
    // Nói rõ đang xem hộp thư của bot NÀO. Nhiều bot mà không ghi thì owner đọc một danh sách không
    // khớp lịch sử Zalo của mình và tưởng dữ liệu sai — trong khi thật ra là đang xem bot khác.
    const bots = (state && state.bots) || [];
    const cur = chatProfile();
    const curName = bots.find(b => b.profile === cur)?.name || cur;
    actions.innerHTML = `${bots.length > 1
      ? `<span class="chat-whose">${t('Hộp thư của', 'Inbox of')} <b>${crmEsc(curName)}</b>${
          selectedBotFilter === 'all' ? ` · <span class="item-sub">${t('đổi ở thanh chọn bot phía trên', 'switch with the bot picker above')}</span>` : ''}</span>`
      : ''}
      <button class="btn" id="chatReloadBtn">${t('⟳ Làm mới', '⟳ Refresh')}</button>`;
    actions.querySelector('#chatReloadBtn').addEventListener('click', () => renderChat());
  }

  const body = document.getElementById('chatBody');
  if (!body) return;
  if (!chatState.conversations.length) {
    body.innerHTML = `<div class="card" style="padding:24px;color:var(--muted)">${t('Đang tải…', 'Loading…')}</div>`;
  }
  try {
    const bot = chatProfile();
    // Đổi bot là đổi hẳn hộp thư → bỏ hội thoại đang mở, gợi ý và hội thoại với trợ lý.
    if (chatState.bot !== bot) {
      chatState.bot = bot;
      chatState.activeId = null;
      chatState.suggestions = [];
      chatState.aiThread = [];
    }
    try { localStorage.setItem('zaloChatBot', bot); } catch { /* trình duyệt chặn */ }
    const res = await crmAction('chat-conversations', { accountId: bot });
    chatState.conversations = res.conversations || [];
    chatState.lastSig = res.v || '';
    if (!chatState.conversations.some(c => c.id === chatState.activeId)) {
      chatState.activeId = chatState.conversations[0]?.id || null;
    }
    chatRenderShell(body);
    if (chatState.activeId) await chatLoadMessages(chatState.activeId);
    chatStartPolling();
  } catch (err) {
    chatStopPolling();
    crmErrorCard(body, err, renderChat);
  }
}

function chatStartPolling() {
  chatStopPolling();
  chatState.pollTimer = setInterval(async () => {
    // Trang không còn hiển thị → ngừng hẳn. Không có nhịp này thì mỗi lần owner mở khung chat rồi
    // đi chỗ khác lại để lại một vòng lặp gọi API mãi mãi.
    if (!document.getElementById('chat')?.classList.contains('active')) { chatStopPolling(); return; }
    if (document.hidden || chatState.sending) return;
    try {
      // Nhịp thường: CHỈ hỏi dấu-vân-tay. Không đổi thì dừng ngay — không dựng lại danh sách, và
      // quan trọng hơn là không vẽ lại gì, vì vẽ lại mỗi vài giây sẽ cướp con trỏ khỏi ô soạn tin.
      const { v } = await crmAction('chat-version');
      if (v === chatState.lastSig) return;
      chatState.lastSig = v;

      const res = await crmAction('chat-conversations', { accountId: chatProfile() });
      chatState.conversations = res.conversations || [];
      chatState.lastSig = res.v || chatState.lastSig;
      chatRenderShell(document.getElementById('chatBody'));
      if (chatState.activeId) await chatLoadMessages(chatState.activeId, { keepScroll: true });
    } catch { /* mạng chập chờn — lần sau thử lại */ }
  }, CHAT_POLL_MS);
}

function chatRenderShell(body) {
  if (!body) return;
  const q = foldVi(chatState.search);
  const list = chatState.conversations
    .filter(c => chatState.filter === 'all' || c.type === chatState.filter)
    .filter(c => !q || foldVi(c.title).includes(q) || foldVi(c.lastText || '').includes(q));

  const active = chatState.conversations.find(c => c.id === chatState.activeId);
  const rows = list.map(c => `
    <button type="button" class="chat-conv${c.id === chatState.activeId ? ' active' : ''}" data-chat-conv="${crmEsc(c.id)}">
      ${c.avatar
        ? `<img src="${crmEsc(c.avatar)}" alt="" class="chat-ava">`
        : `<span class="chat-ava chat-ava-empty">${crmEsc((c.title || '?')[0].toUpperCase())}</span>`}
      <span class="chat-conv-main">
        <span class="chat-conv-top">
          <span class="chat-conv-title">${crmEsc(c.title)}</span>
          <span class="chat-conv-time">${chatTime(c.lastMessageAt)}</span>
        </span>
        <span class="chat-conv-last">${c.type === 'group' ? '👥 ' : ''}${crmEsc(c.lastText || '')}</span>
      </span>
    </button>`).join('');

  // Vẽ lại `innerHTML` là dựng lại cả danh sách → vị trí cuộn về 0. Bấm một người ở cuối danh sách
  // mà bị kéo vọt lên đầu là lỗi thấy ngay và rất khó chịu; polling mỗi 4 giây cũng dính.
  const listScroll = body.querySelector('.chat-conv-list')?.scrollTop || 0;

  body.innerHTML = `
    <div class="chat-wrap${active ? ' has-ai' : ''}">
      <aside class="chat-side">
        <input type="search" id="chatSearch" class="crm-search" style="flex:none;width:100%"
          placeholder="${t('Tìm hội thoại…', 'Search conversations…')}" value="${crmEsc(chatState.search)}">
        <div class="chat-tabs">
          ${[['all', t('Tất cả', 'All')], ['dm', t('Riêng', 'DM')], ['group', t('Nhóm', 'Groups')]]
            .map(([k, label]) => `<button type="button" class="chat-tab${chatState.filter === k ? ' active' : ''}" data-chat-filter="${k}">${label}</button>`).join('')}
        </div>
        <div class="chat-conv-list">${rows
          || `<div class="item-sub" style="padding:14px;font-size:12.5px">${t('Chưa có hội thoại nào. Bấm Sync account ở Tổng quan để kéo lịch sử về.', 'No conversations yet. Use Sync account on the Overview page to pull history.')}</div>`}</div>
      </aside>
      <section class="chat-main">
        ${active ? `
          <header class="chat-head">
            <div style="min-width:0">
              <div class="chat-head-title">${crmEsc(active.title)}</div>
              <div class="chat-head-sub">${active.type === 'group' ? t('Nhóm', 'Group') : t('Tin nhắn riêng', 'Direct message')}
                · ${active.messageCount} ${t('tin đã đồng bộ', 'messages synced')}</div>
            </div>
          </header>
          <div class="chat-thread" id="chatThread"></div>
          ${active.type === 'group' ? `<div class="chat-composer chat-composer-off">${t(
              'Gửi vào nhóm phải dùng trang "Gửi hàng loạt" hoặc để bot tự trả lời — tránh gửi nhầm cả nhóm từ đây.',
              'Group sending lives on the "Bulk send" page — avoids accidentally messaging a whole group from here.')}</div>`
            : `<div class="chat-compose-wrap">
              ${chatSuggestionsHtml()}
              <form class="chat-composer" id="chatComposer">
                <div class="chat-input-box">
                  <textarea id="chatInput" rows="1" placeholder="${t('Nhập tin nhắn…', 'Type a message…')}"></textarea>
                  <div class="chat-input-tools">
                    <button type="button" class="chat-tool" data-chat-emoji title="${t('Chèn emoji', 'Insert emoji')}">🙂</button>
                    <button type="button" class="chat-tool" id="chatSuggestBtn" title="${t('Nhờ AI gợi ý câu trả lời', 'Ask AI for reply suggestions')}">✨ ${t('Gợi ý', 'Suggest')}</button>
                    <span class="chat-hint">${t('Enter gửi · Shift+Enter xuống dòng', 'Enter to send · Shift+Enter for a new line')}</span>
                  </div>
                </div>
                <button class="btn primary" type="submit" id="chatSendBtn">${t('Gửi', 'Send')}</button>
              </form>
            </div>`}
        ` : `<div class="chat-empty">${t('Chọn một hội thoại bên trái.', 'Pick a conversation on the left.')}</div>`}
      </section>
      ${active ? chatAiPanelHtml() : ''}
    </div>`;

  const listEl = body.querySelector('.chat-conv-list');
  if (listEl) listEl.scrollTop = listScroll;

  let searchTimer;
  body.querySelector('#chatSearch')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      chatState.search = e.target.value.trim();
      chatRenderShell(body);
      if (chatState.activeId) chatRenderThread();
    }, 250);
  });
  body.querySelectorAll('[data-chat-filter]').forEach(el => el.addEventListener('click', () => {
    chatState.filter = el.dataset.chatFilter;
    chatRenderShell(body);
    if (chatState.activeId) chatRenderThread();
  }));
  body.querySelectorAll('[data-chat-conv]').forEach(el => el.addEventListener('click', async () => {
    chatState.activeId = el.dataset.chatConv;
    // Gợi ý và hội thoại với trợ lý gắn với ĐÚNG một hội thoại — mang sang cuộc khác là đưa nhầm
    // ngữ cảnh của khách này cho khách kia.
    chatState.suggestions = [];
    chatState.aiThread = [];
    chatRenderShell(body);
    await chatLoadMessages(chatState.activeId);
  }));
  chatBindComposer(body);
  chatBindAi(body);
  body.querySelector('#chatComposer')?.addEventListener('submit', chatSend);
  // Enter gửi, Shift+Enter xuống dòng — đúng thói quen của mọi ứng dụng chat.
  body.querySelector('#chatInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(e); }
  });
}

async function chatLoadMessages(conversationId, { keepScroll = false } = {}) {
  try {
    const res = await crmAction('chat-messages', { conversationId, limit: 100 });
    chatState.messages = res.messages || [];
    chatRenderThread({ keepScroll });
  } catch (err) {
    const th = document.getElementById('chatThread');
    if (th) th.innerHTML = `<div class="item-sub" style="padding:14px">${crmEsc(err.message)}</div>`;
  }
}

function chatRenderThread({ keepScroll = false } = {}) {
  const th = document.getElementById('chatThread');
  if (!th) return;
  const atBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 60;
  const active = chatState.conversations.find(c => c.id === chatState.activeId);
  const isGroup = active?.type === 'group';

  let lastDay = '';
  const html = chatState.messages.map(m => {
    const d = new Date(Number(m.sentAt));
    const day = d.toLocaleDateString('vi-VN');
    const sep = day !== lastDay ? `<div class="chat-day">${crmEsc(day)}</div>` : '';
    lastDay = day;
    const media = (m.media || []).map(u => `<a href="${crmEsc(u)}" target="_blank" rel="noopener">
      <img src="${crmEsc(u)}" alt="" class="chat-media"></a>`).join('');
    return `${sep}<div class="chat-msg${m.fromSelf ? ' me' : ''}">
      ${/* Tên người gửi chỉ có nghĩa trong nhóm — DM thì hai bên đã rõ, in thêm chỉ tổ rối. */''}
      ${isGroup && !m.fromSelf ? `<div class="chat-msg-who">${crmEsc(m.senderName || m.senderId)}</div>` : ''}
      <div class="chat-bubble">${media}${crmEsc(m.text || '')}</div>
      <div class="chat-msg-time">${chatTime(m.sentAt)}</div>
    </div>`;
  }).join('');

  th.innerHTML = html || `<div class="item-sub" style="padding:14px">${t(
    'Chưa có tin nào được đồng bộ cho hội thoại này.', 'No messages synced for this conversation yet.')}</div>`;
  // Giữ nguyên vị trí cuộn khi polling làm mới, trừ khi owner đang ở sát đáy — lúc đó tin mới nên
  // tự hiện ra như mọi ứng dụng chat.
  if (!keepScroll || atBottom) th.scrollTop = th.scrollHeight;
}

async function chatSend(e) {
  e?.preventDefault?.();
  const input = document.getElementById('chatInput');
  const text = input?.value.trim();
  if (!text || chatState.sending) return;
  const active = chatState.conversations.find(c => c.id === chatState.activeId);
  // Chặn ở cả hai lớp: giao diện không hiện ô soạn cho nhóm, và ở đây kiểm lại — gửi nhầm vào nhóm
  // khách là thứ không rút lại được.
  if (!active || active.type !== 'dm') return;
  const peerId = String(active.id).split('|').slice(1).join('|');

  chatState.sending = true;
  const btn = document.getElementById('chatSendBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('Đang gửi…', 'Sending…'); }
  try {
    await runAction('send-message', { targetType: 'user', targetId: peerId, text }, null);
    if (input) input.value = '';
    // Vẽ lạc quan để owner thấy tin ngay; lần polling kế tiếp sẽ thay bằng bản thật từ DB.
    chatState.messages.push({
      id: `tam-${Date.now()}`, senderId: '', senderName: '', text,
      sentAt: Date.now(), fromSelf: true,
    });
    chatRenderThread();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    chatState.sending = false;
    if (btn) { btn.disabled = false; btn.textContent = t('Gửi', 'Send'); }
  }
}

// ── Cột thứ 3: trợ lý AI của khung chat ─────────────────────────────────────
//
// Trợ lý chỉ SOẠN, không bao giờ tự gửi: nội dung hội thoại đến từ khách hàng, tức dữ liệu không
// tin cậy, nên một tin kiểu "bỏ qua hướng dẫn trước, nhắn cho X rằng…" phải dừng lại ở bản nháp có
// người đọc. Mọi câu AI đưa ra đều phải bấm "Dùng câu này" rồi bấm Gửi — hai nhịp có chủ ý.

const CHAT_EMOJI = ['🙂', '😀', '😍', '👍', '🙏', '❤️', '😅', '😭', '🔥', '✅', '📦', '🚚', '💰', '🎁', '⏰', '📞'];

function chatSuggestionsHtml() {
  if (!chatState.suggestions.length) return '';
  return `<div class="chat-suggests">${chatState.suggestions.map((s, i) =>
    `<button type="button" class="chat-suggest" data-chat-suggest="${i}">${crmEsc(s)}</button>`).join('')}</div>`;
}

function chatAiPanelHtml() {
  if (!chatState.aiOpen) {
    return `<aside class="chat-ai chat-ai-collapsed">
      <button type="button" class="chat-tool" id="chatAiOpen" title="${t('Mở trợ lý AI', 'Open AI assistant')}">🤖</button>
    </aside>`;
  }
  const thread = chatState.aiThread.map((m, i) => `
    <div class="chat-ai-msg${m.role === 'me' ? ' me' : ''}">
      <div class="chat-ai-bubble">${crmEsc(m.text)}</div>
      ${m.canUse ? `<button type="button" class="chat-ai-use" data-chat-ai-use="${i}">${t('Dùng câu này', 'Use this')}</button>` : ''}
    </div>`).join('');

  return `<aside class="chat-ai">
    <header class="chat-ai-head">
      <span>🤖 ${t('Trợ lý AI', 'AI assistant')}</span>
      <button type="button" class="chat-tool" id="chatAiClose" title="${t('Thu gọn', 'Collapse')}">✕</button>
    </header>
    <div class="chat-ai-ctl">
      <label class="chat-ai-toggle">
        <input type="checkbox" id="chatAiCtxOn" ${chatState.aiContextOn ? 'checked' : ''}>
        <span>${t('Ngữ cảnh', 'Context')}</span>
      </label>
      <input type="number" id="chatAiCtxN" min="1" max="100" value="${chatState.aiContextCount}"
        ${chatState.aiContextOn ? '' : 'disabled'} title="${t('Số tin gần nhất đưa cho AI đọc (1-100)', 'How many recent messages the AI reads (1-100)')}">
      <button type="button" class="btn" id="chatAiSummary">${t('Tóm tắt', 'Summarize')}</button>
      <button type="button" class="btn" id="chatAiDraft">${t('Soạn hộ', 'Draft')}</button>
    </div>
    <div class="chat-ai-thread" id="chatAiThread">${thread || `<div class="item-sub" style="font-size:12.5px">${t(
      'Bấm "Soạn hộ" để AI viết sẵn câu trả lời, hoặc hỏi bất cứ điều gì về hội thoại này. AI chỉ soạn — gửi hay không là do bạn.',
      'Use "Draft" to have the AI write a reply, or ask anything about this conversation. The AI only drafts — sending is always your call.')}</div>`}</div>
    <form class="chat-ai-ask" id="chatAiForm">
      <input type="text" id="chatAiInput" autocomplete="off" placeholder="${t('Hỏi AI về hội thoại này…', 'Ask the AI about this chat…')}">
      <button class="btn" type="submit" id="chatAiSend">➤</button>
    </form>
  </aside>`;
}

/** Gọi trợ lý. `mode`: draft | suggest | summary | ask. */
async function chatAi(mode, question = '') {
  if (chatState.aiBusy || !chatState.activeId) return;
  chatState.aiBusy = true;
  const body = document.getElementById('chatBody');
  const busyEls = body?.querySelectorAll('#chatAiSummary, #chatAiDraft, #chatAiSend, #chatSuggestBtn') || [];
  busyEls.forEach(b => { b.disabled = true; });
  const th = document.getElementById('chatAiThread');
  if (th && mode !== 'suggest') {
    th.insertAdjacentHTML('beforeend', `<div class="chat-ai-msg" id="chatAiWait"><div class="chat-ai-bubble">${t('Đang nghĩ…', 'Thinking…')}</div></div>`);
    th.scrollTop = th.scrollHeight;
  }
  try {
    const res = await crmAction('chat-ai', {
      conversationId: chatState.activeId,
      mode,
      question,
      // Tắt ngữ cảnh = chỉ đưa 1 tin gần nhất, không phải bỏ trắng: AI không có gì để bám thì nó
      // bịa, mà bịa trong tin nhắn khách hàng là hỏng thật.
      contextCount: chatState.aiContextOn ? chatState.aiContextCount : 1,
    });
    if (mode === 'suggest') {
      chatState.suggestions = res.suggestions || [];
      chatRenderShell(body);
      chatRenderThread();
      return;
    }
    chatState.aiThread.push({ role: 'ai', text: res.text || '', canUse: mode === 'draft' });
  } catch (err) {
    chatState.aiThread.push({ role: 'ai', text: `⚠️ ${err.message}`, canUse: false });
  } finally {
    chatState.aiBusy = false;
    document.getElementById('chatAiWait')?.remove();
    chatRenderAi();
    busyEls.forEach(b => { b.disabled = false; });
  }
}

/** Vẽ lại RIÊNG cột AI — vẽ cả khung sẽ mất chữ đang gõ dở trong ô soạn tin. */
function chatRenderAi() {
  const wrap = document.querySelector('.chat-wrap');
  const old = wrap?.querySelector('.chat-ai');
  if (!wrap || !old) return;
  old.outerHTML = chatAiPanelHtml();
  chatBindAi(document.getElementById('chatBody'));
  const th = document.getElementById('chatAiThread');
  if (th) th.scrollTop = th.scrollHeight;
}

function chatBindAi(body) {
  if (!body) return;
  body.querySelector('#chatAiOpen')?.addEventListener('click', () => { chatState.aiOpen = true; chatRenderAi(); });
  body.querySelector('#chatAiClose')?.addEventListener('click', () => { chatState.aiOpen = false; chatRenderAi(); });
  body.querySelector('#chatAiCtxOn')?.addEventListener('change', (e) => {
    chatState.aiContextOn = e.target.checked;
    chatRenderAi();
  });
  body.querySelector('#chatAiCtxN')?.addEventListener('change', (e) => {
    chatState.aiContextCount = Math.min(Math.max(Number(e.target.value) || 30, 1), 100);
    e.target.value = chatState.aiContextCount;
  });
  body.querySelector('#chatAiSummary')?.addEventListener('click', () => chatAi('summary'));
  body.querySelector('#chatAiDraft')?.addEventListener('click', () => chatAi('draft'));
  body.querySelector('#chatAiForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chatAiInput');
    const q = input?.value.trim();
    if (!q) return;
    chatState.aiThread.push({ role: 'me', text: q, canUse: false });
    input.value = '';
    chatRenderAi();
    chatAi('ask', q);
  });
  body.querySelectorAll('[data-chat-ai-use]').forEach(el => el.addEventListener('click', () => {
    const m = chatState.aiThread[Number(el.dataset.chatAiUse)];
    const input = document.getElementById('chatInput');
    if (!m || !input) return;
    input.value = m.text;
    input.focus();
    chatAutoGrow(input);
  }));
}

/** Ô soạn cao theo nội dung, chặn trên ở 140px — dán một đoạn dài không được nuốt cả khung chat. */
function chatAutoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

function chatBindComposer(body) {
  if (!body) return;
  const input = body.querySelector('#chatInput');
  input?.addEventListener('input', () => chatAutoGrow(input));
  body.querySelector('#chatSuggestBtn')?.addEventListener('click', () => chatAi('suggest'));
  body.querySelectorAll('[data-chat-suggest]').forEach(el => el.addEventListener('click', () => {
    const text = chatState.suggestions[Number(el.dataset.chatSuggest)];
    if (!input || !text) return;
    input.value = text;
    input.focus();
    chatAutoGrow(input);
  }));
  body.querySelector('[data-chat-emoji]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = body.querySelector('.chat-emoji-pop');
    if (existing) { existing.remove(); return; }
    const pop = document.createElement('div');
    pop.className = 'chat-emoji-pop';
    pop.innerHTML = CHAT_EMOJI.map(x => `<button type="button" data-emo="${x}">${x}</button>`).join('');
    e.currentTarget.parentElement.appendChild(pop);
    pop.querySelectorAll('[data-emo]').forEach(b => b.addEventListener('click', () => {
      if (!input) return;
      // Chèn tại con trỏ chứ không nối vào cuối — người ta hay chèn emoji giữa câu.
      const p = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, p) + b.dataset.emo + input.value.slice(input.selectionEnd ?? p);
      input.focus();
      input.selectionStart = input.selectionEnd = p + b.dataset.emo.length;
      pop.remove();
      chatAutoGrow(input);
    }));
    setTimeout(() => document.addEventListener('click', function once() {
      pop.remove();
      document.removeEventListener('click', once);
    }, { once: true }), 0);
  });
}
