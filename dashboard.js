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
const pluginVersion = '2.11.1';
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
  setAttr('#search', 'placeholder', 'Tìm group, member, userId, API...', 'Search group, member, userId, API...');
  setAttr('[data-open-menu]', 'aria-label', 'More menu', 'Open more menu');
  setAttr('#themeToggle', 'aria-label', 'Theme switch', 'Switch theme');
  setAttr('#langToggle', 'aria-label', 'Đổi ngôn ngữ', 'Switch language');

  setText('[data-i18n="dropdownPlanLabel"]', 'Gói:', 'Plan:');
  setText('[data-i18n="dropdownExpiryLabel"]', 'Hạn dùng:', 'Expires:');

  setText('.brand h1', 'Zalo Owner', 'Zalo Owner');
  setText('.brand p', 'Quản trị Bot Zalo', 'Zalo Bot Management');
  setAllText('[data-nav] button > span.nav-label', [
    ['Tổng quan', 'Overview'],
    ['Nhóm', 'Groups'],
    ['Thành viên', 'Members'],
    ['Bạn bè', 'Friends'],
    ['Tin nhắn', 'Messages'],
    ['Lệnh & Rules', 'Rules & Cmds'],
    ['Tiện ích', 'Utilities'],
    ['Facebook Crawler', 'Facebook Crawler'],
    ['Nâng cấp', 'Upgrade'],
    ['Khu nguy hiểm', 'Danger Zone'],
  ]);
  setAllText('[data-drawer-nav] button > span.nav-label', [
    ['Tổng quan', 'Overview'],
    ['Nhóm', 'Groups'],
    ['Thành viên', 'Members'],
    ['Bạn bè', 'Friends'],
    ['Tin nhắn', 'Messages'],
    ['Lệnh & Rules', 'Rules & Cmds'],
    ['Facebook Crawler', 'Facebook Crawler'],
    ['Nâng cấp', 'Upgrade'],
    ['Khu nguy hiểm', 'Danger Zone'],
  ]);
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
  setText('#members .page-head h2', 'Thành viên & Pending', 'Members & Pending');
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
  setText('#friends .page-head h2', 'Bạn bè', 'Friends');
  setText('#friends .page-head p', 'Quản lý kết bạn, lời mời đã gửi, request đang chờ và danh bạ của tài khoản Zalo bot.', 'Manage friend requests, sent requests, pending requests, and the bot account contact list.');
  setAllText('#friends .actions .btn', [['Tìm user', 'Find user'], ['Gửi lời mời', 'Send request']]);
  setAllText('#friends .api-card h4', [['Friend requests', 'Friend requests'], ['Lời mời đã gửi', 'Sent requests'], ['Tất cả bạn bè', 'All friends']]);
  setAllText('#friends .api-card p', [
    ['Accept hoặc reject lời mời kết bạn bằng `acceptFriendRequest` và `rejectFriendRequest`.', 'Accept or reject friend requests with `acceptFriendRequest` and `rejectFriendRequest`.'],
    ['Theo dõi lời mời đã gửi, thu hồi khi cần bằng `undoFriendRequest`.', 'Track sent requests and revoke them when needed with `undoFriendRequest`.'],
    ['Search, alias, remove friend và phân nhóm danh bạ.', 'Search, alias, remove friends, and organize contacts.'],
  ]);
  setAllText('#friends .api-card .btn', [['Xử lý bằng ID', 'Handle by ID'], ['Gửi mới', 'Send new'], ['Tải bạn bè', 'Load friends']]);
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
  setText('#danger .page-head h2', 'Khu nguy hiểm', 'Danger Zone');
  setText('#danger .page-head p', 'Các action có thể gây mất dữ liệu hoặc ảnh hưởng group. Bắt buộc xác nhận 2 bước và ghi audit log.', 'Actions that can affect groups or data. Two-step confirmation and audit logging are required.');
  setAllText('#danger .api-card h4', [['Giải tán group', 'Disperse group'], ['Chuyển owner', 'Change owner'], ['Xóa chat/message', 'Delete chat/message']]);
  setAllText('#danger .api-card p', [
    ['Giải tán group bằng `disperseGroup`. Chỉ cho owner, bắt nhập lại groupId.', 'Disperse a group with `disperseGroup`. Owner-only and requires retyping groupId.'],
    ['Chuyển owner group bằng `changeGroupOwner`. Cần xác nhận userId đích.', 'Transfer group ownership with `changeGroupOwner`. Requires confirming the target userId.'],
    ['Xóa chat hoặc message bằng `deleteChat`, `deleteMessage`, `undo`.', 'Delete chats or messages with `deleteChat`, `deleteMessage`, and `undo`.'],
  ]);
  setAllText('#danger .api-card .btn', [['Khóa', 'Locked'], ['Khóa', 'Locked'], ['Khóa', 'Locked']]);
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
  setText('[data-i18n-feature="free-3"]', 'Giới hạn tính năng điều khiển', 'Limited advanced controls');
  setText('[data-i18n-btn="free"]', 'Trải nghiệm ngay', 'Try now');

  setText('[data-i18n-badge="personal"]', 'Cá nhân', 'Personal');
  setText('[data-i18n-title="personal"]', 'Gói Cá nhân', 'Personal Plan');
  setText('[data-i18n-sub="personal"]', 'hoặc 990.000đ / 12 tháng', 'or 990,000đ / 12 months');
  setText('[data-i18n-feature="personal-1"]', 'Mở khóa điều khiển nâng cao', 'Unlock advanced control features');
  setText('[data-i18n-feature="personal-2"]', 'Ưu tiên cập nhật tính năng mới', 'Priority new feature updates');
  setText('[data-i18n-feature="personal-3"]', 'Dùng cho 1 owner account', 'Use for 1 owner account');
  setText('[data-i18n-btn="personal"]', 'Nâng cấp Cá nhân', 'Upgrade Personal');

  setText('[data-i18n-badge="team"]', 'Team', 'Team');
  setText('[data-i18n-title="team"]', 'Gói Team', 'Team Plan');
  setText('[data-i18n-sub="team"]', 'hoặc 2.990.000đ / 12 tháng', 'or 2,990,000đ / 12 months');
  setText('[data-i18n-feature="team-1"]', 'Dành cho nhiều thành viên', 'For multiple team operators');
  setText('[data-i18n-feature="team-2"]', 'Ưu tiên hỗ trợ nhanh hơn', 'Priority faster support');
  setText('[data-i18n-feature="team-3"]', 'Phù hợp team growth/ops', 'Suited for growth/ops teams');
  setText('[data-i18n-btn="team"]', 'Đăng ký Team', 'Register Team');

  setText('[data-i18n-badge="lifetime"]', 'Vĩnh viễn', 'Lifetime');
  setText('[data-i18n-title="lifetime"]', 'Gói Lifetime', 'Lifetime Plan');
  setText('[data-i18n-sub="lifetime"]', 'Thanh toán một lần duy nhất', 'One-time payment only');
  setText('[data-i18n-feature="lifetime-1"]', 'Sử dụng vĩnh viễn trọn đời', 'Lifetime perpetual usage');
  setText('[data-i18n-feature="lifetime-2"]', 'Kích hoạt theo chính sách plugin', 'Activated per plugin policy');
  setText('[data-i18n-feature="lifetime-3"]', 'Phù hợp sử dụng lâu dài ổn định', 'Best for long-term stable use');
  setText('[data-i18n-btn="lifetime"]', 'Mua Lifetime', 'Buy Lifetime');

    setAllText('[data-i18n-period="month"]', [['/tháng', '/month']]);

  // --- Facebook Crawler Tab Translations ---
  setText('[data-i18n="fbTitle"]', 'Facebook Crawler', 'Facebook Crawler');
  setText('[data-i18n="fbDesc"]', 'Quản lý group Facebook, điều kiện lọc, lịch quét tự động và mẫu báo cáo.', 'Manage Facebook groups, filter conditions, automatic cron scheduler, and report template.');
  setText('[data-i18n="fbProfileLabel"]', 'Profile (Agent ID):', 'Profile (Agent ID):');
  setText('#btnFbRefresh', 'Làm mới', 'Refresh');
  setText('#btnFbRunAll', 'Quét tất cả', 'Crawl All');

  // Tabs
  setText('[data-i18n-tab="targets"]', 'Plugin Targets', 'Plugin Targets');
  setText('[data-i18n-tab="filters"]', 'Filter Conditions', 'Filter Conditions');
  setText('[data-i18n-tab="cron"]', 'Cron Scheduler', 'Cron Scheduler');
  setText('[data-i18n-tab="notify"]', 'Nhóm nhận báo cáo', 'Report Targets');
  setText('[data-i18n-tab="template"]', 'Report Template', 'Report Template');
  setText('[data-i18n-tab="cookies"]', 'Facebook Cookies', 'Facebook Cookies');

  // Cookies panel
  setText('[data-i18n="fbCookiesTitle"]', 'Cấu hình Cookies đăng nhập', 'Configure Login Cookies');
  setText('[data-i18n="fbCookiesDesc"]', 'Cookies giúp giả lập trạng thái đăng nhập để cuộn cào tin không giới hạn trong các Group.', 'Cookies help simulate login status to crawl posts without limits in Groups.');
  setText('[data-i18n="fbCookiesBtnChooseFile"]', '📂 Chọn file JSON', '📂 Choose JSON File');
  setText('#btnFbSaveCookies', 'Lưu & Áp dụng', 'Save & Apply');
  setHtml('[data-i18n="fbCookieWarningTitle"]', 'Cảnh báo bảo mật:', 'Security Warning:');
  setHtml('[data-i18n="fbCookieWarningText"]', 'Vui lòng <strong>không sử dụng tài khoản Facebook chính (acc chính)</strong> để lấy cookie. Hãy sử dụng tài khoản phụ (clone) để tránh rủi ro bị checkpoint hoặc khóa tài khoản. Chúng tôi hoàn toàn miễn trừ trách nhiệm đối với bất kỳ rủi ro nào liên quan đến tài khoản Facebook của bạn.', 'Please <strong>do not use your main Facebook account (main acc)</strong> to get cookies. Use a secondary account (clone) to avoid checkpoint or account lock risks. We are completely exempt from any liability regarding your Facebook accounts.');
  setHtml('[data-i18n="fbCookiesHint"]', '💡 Mẹo: Sử dụng extension Chrome như <strong>Get Cookie</strong> hoặc <strong>J2TEAM Cookie</strong> để xuất file cookie dạng JSON.', '💡 Tip: Use a Chrome extension like <strong>Get Cookie</strong> or <strong>J2TEAM Cookie</strong> to export cookies as a JSON file.');
  setText('[data-i18n="fbCookiesStatusLabel"]', 'Trạng thái hoạt động:', 'Operating Status:');
  setText('#btnFbClearCookies', '🗑️ Xóa Cookie', '🗑️ Clear Cookie');

  // Targets panel
  setText('[data-i18n="fbTargetsTitle"]', 'Danh sách Group Facebook', 'Facebook Group List');
  setText('[data-i18n="fbTargetsDesc"]', 'Thêm URL group FB cần quét. Hệ thống sẽ tự phân batch theo lịch cron.', 'Add Facebook group URLs to crawl. The system will automatically batch them by cron schedule.');
  setText('[data-i18n="fbTargetsBtnDownload"]', 'Tải mẫu CSV', 'Download CSV Sample');
  setText('[data-i18n="fbTargetsBtnImport"]', 'Import CSV/Excel', 'Import CSV/Excel');
  setText('[data-i18n="fbTargetsLabelShortKey"]', 'Key ngắn', 'Short Key');
  setText('[data-i18n="fbTargetsLabelDisplayName"]', 'Tên hiển thị', 'Display Name');
  setText('[data-i18n="fbTargetsLabelGroupUrl"]', 'URL Group Facebook', 'Facebook Group URL');
  setText('[data-i18n="fbTargetsLabelKeywords"]', 'Từ khoá xe (cách bằng ;)', 'Vehicle Keywords (separated by ;)');
  setText('[data-i18n="fbTargetsBtnAdd"]', 'Thêm Group', 'Add Group');
  setText('[data-i18n="fbTargetsThKey"]', 'Key', 'Key');
  setText('[data-i18n="fbTargetsThGroupName"]', 'Tên Group', 'Group Name');
  setText('[data-i18n="fbTargetsThUrl"]', 'URL', 'URL');
  setText('[data-i18n="fbTargetsThKeywords"]', 'Từ khoá xe', 'Vehicle Keywords');
  setText('[data-i18n="fbTargetsThDelete"]', 'Xóa', 'Delete');
  setText('[data-i18n="fbTargetsEmptyRow"]', 'Chưa có group nào. Thêm group hoặc import file CSV.', 'No groups yet. Add a group or import a CSV file.');
  setText('[data-i18n="fbTargetsBtnSave"]', 'Lưu danh sách', 'Save List');

  // Filters panel
  setText('[data-i18n="fbFiltersTitle"]', 'Điều kiện lọc bài viết', 'Post Filter Conditions');
  setText('[data-i18n="fbFiltersDesc"]', 'Từ khoá bắt buộc, từ khoá chặn, khu vực và dữ liệu trích xuất tự động.', 'Required keywords, block keywords, regions, and auto-extracted data.');
  setText('[data-i18n="fbFiltersBtnSave"]', 'Lưu điều kiện', 'Save Conditions');
  setHtml('[data-i18n="fbFiltersAiTitle"]', '<span class="util-dot util-dot-purple"></span>Phân loại & Kiểm duyệt bằng AI', '<span class="util-dot util-dot-purple"></span>AI Classification & Moderation');
  setText('[data-i18n="fbFiltersAiProductDesc"]', 'Nhu cầu sản phẩm cần AI kiểm duyệt (Mô tả chi tiết sản phẩm/nhu cầu)', 'Product requirement for AI moderation (Detailed product/need description)');
  setText('[data-i18n="fbFiltersAiHint"]', '💡 AI sẽ dùng mô tả này để tự động phân loại đúng bài viết theo nhu cầu của bạn. Nếu để trống, hệ thống sẽ tự động dùng "Từ khoá bắt buộc" ở dưới để đối chiếu.', '💡 AI will use this description to automatically classify posts matching your needs. If empty, the system will fallback to "Required keywords" below.');
  setHtml('[data-i18n="fbFiltersRequireKeywords"]', '<span class="util-dot util-dot-green"></span>Từ khoá bắt buộc <small>(mỗi từ 1 dòng)</small>', '<span class="util-dot util-dot-green"></span>Required Keywords <small>(one word per line)</small>');
  setHtml('[data-i18n="fbFiltersBlockKeywords"]', '<span class="util-dot util-dot-red"></span>Từ khoá chặn <small>(mỗi từ 1 dòng)</small>', '<span class="util-dot util-dot-red"></span>Blocked Keywords <small>(one word per line)</small>');
  setHtml('[data-i18n="fbFiltersLocation"]', '<span class="util-dot util-dot-blue"></span>Khu vực lọc <small>— click chọn tỉnh/thành, để trống = chấp nhận mọi nơi</small>', '<span class="util-dot util-dot-blue"></span>Filter Region <small>— click to select province/city, leave empty = accept all</small>');
  setText('[data-i18n="fbFiltersBtnClearLocations"]', 'Bỏ chọn tất cả', 'Clear All');
  setText('[data-i18n="fbFiltersLocationEmpty"]', 'Chưa chọn khu vực nào — hệ thống chấp nhận mọi tỉnh thành', 'No region selected — system accepts all provinces/cities');
  setHtml('[data-i18n="fbFiltersExtractor"]', '<span class="util-dot util-dot-purple"></span>Trích xuất dữ liệu tự động <small>— bật/tắt trường cần lấy</small>', '<span class="util-dot util-dot-purple"></span>Auto Data Extraction <small>— toggle fields to extract</small>');
  setText('[data-i18n="fbFiltersExtractorHint"]', 'Hệ thống tự nhận dạng pattern. Không cần nhập regex thủ công.', 'The system automatically detects patterns. No manual regex entry needed.');
  setHtml('[data-i18n="fbFiltersMaxPosts"]', '<span class="util-dot util-dot-orange"></span>Giới hạn bài mỗi lần quét', '<span class="util-dot util-dot-orange"></span>Post Limit per Crawl');
  setText('#fbFiltersMaxPostsUnit', 'bài / group · 0 = không giới hạn', 'posts / group · 0 = unlimited');

  // Cron panel
  setText('[data-i18n="fbCronTitle"]', 'Hẹn lịch quét tự động', 'Schedule Auto Crawl');
  setText('[data-i18n="fbCronDesc"]', 'Mỗi session quét một batch group theo lịch cron. AI tự đề xuất phân bổ tối ưu.', 'Each session crawls a batch of groups by cron schedule. AI recommends optimal distribution.');
  setText('[data-i18n="fbCronBtnAi"]', 'AI Đề xuất lịch', 'AI Suggest Schedule');
  setText('[data-i18n="fbCronBtnSave"]', 'Lưu lịch', 'Save Schedule');
  setText('[data-i18n="fbCronLabelId"]', 'ID', 'ID');
  setText('[data-i18n="fbCronLabelTime"]', 'Giờ chạy (VN)', 'Execution Time (VN)');
  setText('[data-i18n="fbCronLabelFrom"]', 'Group từ', 'Group from');
  setText('[data-i18n="fbCronLabelTo"]', 'đến', 'to');
  setText('[data-i18n="fbCronBtnAdd"]', 'Thêm', 'Add');
  setText('[data-i18n="fbCronThTime"]', 'Giờ chạy (VN)', 'Execution Time (VN)');
  setText('[data-i18n="fbCronThSlice"]', 'Group slice', 'Group slice');
  setText('[data-i18n="fbCronThActions"]', 'Thao tác', 'Actions');

  // Notify panel
  setText('[data-i18n="fbNotifyEyebrow"]', 'REPORT TARGETS', 'REPORT TARGETS');
  setText('[data-i18n="fbNotifyTitle"]', 'Nhóm nhận báo cáo', 'Report Target Groups');
  setText('[data-i18n="fbNotifyDesc"]', 'Chọn các nhóm Zalo hoặc người dùng nhận báo cáo kết quả quét tự động.', 'Select Zalo groups or users to receive automatic crawl report notifications.');
  setText('#btnFbSaveNotify', 'Lưu cấu hình', 'Save Configuration');
  setText('#fbNotifySubTabGroupBtn', 'Nhóm (Group)', 'Group');
  setText('#fbNotifySubTabUserBtn', 'Cá nhân (User)', 'User');
  setText('[data-i18n="thAvatar"]', 'Avatar', 'Avatar');
  setText('[data-i18n="thGroupName"]', 'Tên nhóm', 'Group Name');
  setText('[data-i18n="thMemberCount"]', 'Số thành viên', 'Member Count');
  setText('[data-i18n="thFriendName"]', 'Tên bạn bè', 'Friend Name');
  setText('[data-i18n="thUserId"]', 'User ID', 'User ID');

  // Template panel
  setText('[data-i18n="fbTemplateTitle"]', 'Mẫu template báo cáo', 'Report Template');
  setText('[data-i18n="fbTemplateDesc"]', 'Tuỳ chỉnh định dạng báo cáo kết quả gửi qua Zalo. Template lưu ngoài plugin, không mất khi update.', 'Customize Zalo report format. Template is saved outside the plugin, preserved across updates.');
  setText('[data-i18n="fbTemplateBtnReset"]', 'Reset mặc định', 'Reset Default');
  setText('[data-i18n="fbTemplateBtnPreview"]', '👁️ Preview', '👁️ Preview');
  setText('[data-i18n="fbTemplateBtnSave"]', 'Lưu template', 'Save Template');
  setText('[data-i18n="fbTemplateVarHint"]', '📌 Biến có thể dùng — click để chèn vào template:', '📌 Available variables — click to insert:');
  setText('[data-i18n="fbTemplateVarItems"]', '← ds kết quả', '← result list');
  setHtml('[data-i18n="fbTemplateBottomHint"]', '💡 Dùng <code>*text*</code> để in đậm trong Zalo. Template lưu tại <code>plugins-data/zalo-mod/report-template.txt</code>', '💡 Use <code>*text*</code> for bold formatting in Zalo. Template saved at <code>plugins-data/zalo-mod/report-template.txt</code>');

  // Placeholders
  setAttr('#fbReportTemplate', 'placeholder', 'Nhập template báo cáo...', 'Enter report template...');
  setAttr('#fbCookiesTextarea', 'placeholder', 'Dán nội dung JSON Cookie vào đây (ví dụ: [{"domain": ".facebook.com", "name": "c_user", "value": "..."}]) hoặc chọn file tải lên ở trên...', 'Paste JSON Cookie here (e.g., [{"domain": ".facebook.com", "name": "c_user", "value": "..."}]) or choose a file to upload above...');
  setAttr('#fbAiProductDesc', 'placeholder', 'Ví dụ: robot hút bụi lau nhà Xiaomi, Ecovacs, Dreame, Roborock (thanh lý hoặc tìm mua)', 'e.g., Xiaomi robot vacuum cleaner, Ecovacs, Dreame, Roborock (used or looking to buy)');
  setAttr('#fbNewGroupKey', 'placeholder', 'vd: nvx', 'e.g., nvx');
  setAttr('#fbNewGroupName', 'placeholder', 'Yamaha NVX - Mua bán xe', 'Yamaha NVX - Sell/Buy');
  setAttr('#fbNewGroupUrl', 'placeholder', 'https://www.facebook.com/groups/...', 'https://www.facebook.com/groups/...');
  setAttr('#fbNewGroupVK', 'placeholder', 'nvx;nvx 155', 'nvx;nvx 155');
  setAttr('#fbLocationSearch', 'placeholder', 'Tìm tỉnh/thành...', 'Search province/city...');
  setAttr('#fbNewCronId', 'placeholder', 'A', 'A');

  // --- Rules & Cmds Tab Translations ---
  setText('#templates .page-head h2', 'Quản lý Lệnh & Rules', 'Manage Rules & Commands');
  setText('#templates .page-head p', 'Tùy chỉnh nội dung phản hồi của bot cho các lệnh slash commands.', 'Customize bot response content for slash commands.');
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
  if (typeof fbState !== 'undefined' && fbState) {
    renderFbGroups();
    renderFbCronTable();
    renderFbLocationSelected();
    renderFbExtractors();
    renderFbNotifyGroupList();
    renderFbNotifyUserList();
  }
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
      if (lic.plan === 'personal') planName = t('Cá nhân Pro', 'Personal Pro');
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
      if (lic.plan === 'personal') planName = t('Cá nhân Pro', 'Personal Pro');
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
    if (lic.plan === 'personal') planName = t('Cá nhân Pro', 'Personal Pro');
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
    if (['members', 'friends', 'api', 'danger'].includes(sec)) {
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

  ['members', 'friends', 'api', 'danger'].forEach(secId => {
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
function getBotBadge(profile) {
  const bot = state.bots?.find(b => b.profile === profile);
  const name = bot ? (bot.name || bot.id) : (profile || 'default');
  const isWholesale = bot
    ? (bot.id.includes('si') || bot.id.includes('2') || bot.name.includes('2') || bot.name.toLowerCase().includes('si'))
    : (profile || '').includes('si');
  const badgeClass = isWholesale ? 'si' : 'le';
  return `<span class="bot-badge badge-${badgeClass}">${esc(name)}</span>`;
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
          <td class="col-overview-mode" data-label="${esc(t('Mode', 'Mode'))}">${status(group.settings.silent, 'Silent', 'Normal')} ${status(group.settings.welcome, 'Welcome', t('\u004b\u0068\u00f4\u006e\u0067 welcome', 'No welcome'))}</td>
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
function featureToggle(group, key, label) {
  const on = !!group.settings[key];
  return `<button class="feature-toggle ${on ? 'on' : 'off'}" type="button" data-toggle="${esc(group.groupId)}:${key}:${!on}">${label}</button>`;
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
  if (selectedBotFilter !== 'all' && group.profile !== selectedBotFilter) return false;
  if (currentGroupFilter === 'silent') return !!group.settings.silent;
  if (currentGroupFilter === 'welcome') return !!group.settings.welcome;
  if (currentGroupFilter === 'muted') return !!group.settings.muted;
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
              ${featureToggle(group, 'tracking', 'Tracking')}
              ${featureToggle(group, 'follow', 'Follow')}
              ${featureToggle(group, 'pendingAuto', uiText('Tự duyệt', 'Auto approve'))}
              <button class="feature-toggle off" type="button" data-add-mode="${esc(group.groupId)}">${uiText('Thêm mode', 'Add mode')}</button>
            </div>
          </td>
          <td class="col-actions" data-label="${esc(uiText('Thao tác', 'Actions'))}">
            ${renderGroupModePills(group)}
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
  const defs = [
    ['muted', 'Mute'],
    ['silent', 'Silent'],
    ['welcome', 'Welcome'],
    ['tracking', 'Tracking'],
    ['follow', 'Follow'],
    ['pendingAuto', 'Auto approve'],
  ];
  actions.innerHTML = `
        <button class="btn" type="button" data-select-all-groups>Select all</button>
        ${defs.map(([key, label]) => {
    const allOn = selectedVisible.length > 0 && selectedVisible.every(group => !!group.settings[key]);
    return `<button class="feature-toggle ${allOn ? 'on' : 'off'}" type="button" data-bulk-feature="${key}:${!allOn}">${label}</button>`;
  }).join('')}
      `;
}
async function renderMembers() {
  const container = document.getElementById('membersTableWrapper') || document.querySelector('#members .mobile-stack');
  if (!container) return;

  const select = document.getElementById('membersGroupSelect');
  if (select && state) {
    let groups = state.groups || [];
    if (selectedMemberBotFilter !== 'all') {
      groups = groups.filter(g => g.profile === selectedMemberBotFilter);
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

    // Custom Dropdown Populating
    const dropdown = document.getElementById('membersGroupSelectDropdown');
    if (dropdown) {
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

      // Update selected trigger contents
      const activeGroup = groups.find(g => g.groupId === activeGroupId);
      if (activeGroup) {
        const avatar = avatarMeta(activeGroup, activeGroup.name);
        const avatarNode = document.getElementById('selectedGroupAvatar');
        if (avatarNode) {
          avatarNode.innerHTML = avatar.src
            ? `<img src="${esc(avatar.src)}" alt="${esc(avatar.name || 'avatar')}" onerror="const p=this.parentElement; this.remove(); if(p)p.textContent='${esc(avatar.initials)}'">`
            : esc(avatar.initials);
        }
        document.getElementById('selectedGroupName').innerHTML = `
              ${esc(repairText(activeGroup.name))}
              ${getBotBadge(activeGroup.profile)}
            `;
        document.getElementById('selectedGroupBadge').textContent = `${activeGroup.memberCount} members`;
      }

      // Bind click handlers to custom pills inside dropdown
      dropdown.querySelectorAll('[data-select-group-id]').forEach(pill => {
        pill.addEventListener('click', event => {
          event.stopPropagation();
          const gid = event.currentTarget.dataset.selectGroupId;
          activeGroupId = gid;
          select.value = gid;
          document.getElementById('membersGroupSelectContainer').classList.remove('open');
          currentMembersPage = 1;
          renderMembers();
        });
      });
    }
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
                <button class="btn danger" type="button" data-kick-member="${esc(m.userId)}" style="padding: 4px 8px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;">
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
      const userId = event.target.dataset.kickMember;
      if (confirm(t('Bạn có chắc chắn muốn kick thành viên này khỏi group?', 'Are you sure you want to kick this member?'))) {
        try {
          await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'remove-user', groupId: activeGroupId, userId }) });
          showToast(t('Đã xóa thành viên', 'Member removed'), 'success');
          if (state.members[activeGroupId]) {
            delete state.members[activeGroupId][userId];
          }
          renderMembers();
        } catch (e) {
          showToast(e.message, 'error');
        }
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
          <div><div class="item-title">${esc(item.action)}</div><div class="item-sub">${esc(item.ts || '')}</div></div>
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
  const group = state.groups.find(item => item.groupId === groupId) || {};
  return {
    ...group,
    settings: group.settings || {},
    admins: group.admins || [],
    pending: pendingResult,
  };
}
function refreshDetailModal() {
  if (!currentDetailGroupId || !modalBackdrop.classList.contains('open')) return;
  currentDetailPayload = buildLocalGroupDetail(currentDetailGroupId, currentDetailPayload?.pending || null);
  modalTitle.textContent = uiText('Chi tiết group', 'Group details');
  modalBody.innerHTML = groupDetailBody(currentDetailPayload);
  modalConfirm.textContent = uiText('Đóng', 'Close');
  modalConfirm.classList.remove('danger');
  modalConfirm.classList.add('primary');
}
function groupDetailBody(detail) {
  const pending = pendingMembersFromDetail(detail);
  const pendingCount = Number(detail.pendingCount || pending.length || 0);
  const modes = Array.isArray(detail.customModes) ? detail.customModes : [];
  const people = groupPeople(detail);
  return `
        <div class="list" style="padding:0">
          <div class="item"><div><div class="item-title">${esc(repairText(detail.name))} <span class="member-badge">${detail.memberCount || 0} ${uiText('members', 'members')}</span></div><div class="item-sub">${esc(detail.groupId)} - ${detail.admins?.length || 0} admins</div></div><span class="status ${detail.settings?.pendingAuto ? 'on' : 'off'}">${detail.settings?.pendingAuto ? uiText('Tự duyệt', 'Auto approve') : uiText('Duyệt tay', 'Manual')}</span></div>
          <div class="item"><div><div class="item-title">${uiText('Owner/Admin', 'Owner/Admin')}</div><div class="avatar-stack" style="margin-top:10px">${people.map(personChip).join('') || `<small>${uiText('Chưa có owner/admin', 'No owner/admin')}</small>`}</div></div></div>
          <div class="item"><div><div class="item-title">${uiText('Tính năng', 'Features')}</div><div class="feature-toggles" style="margin-top:8px">
            ${[
      ['muted', 'Mute'],
      ['silent', 'Silent'],
      ['welcome', 'Welcome'],
      ['tracking', 'Tracking'],
      ['follow', 'Follow'],
      ['pendingAuto', uiText('Tự duyệt', 'Auto approve')],
    ].map(([key, label]) => `<button class="feature-toggle ${detail.settings?.[key] ? 'on' : 'off'}" type="button" data-toggle="${esc(detail.groupId)}:${key}:${!detail.settings?.[key]}">${label}</button>`).join('')}
          </div></div></div>
          <div class="item"><div><div class="item-title">${uiText('Chế độ thông minh', 'Smart modes')}</div><div class="item-sub">${modes.length ? modes.map(mode => `${esc(repairText(mode.label))} (${mode.enabled ? 'on' : 'off'}) -> ${esc(repairText(mode.skill))}`).join('<br>') : uiText('Chưa có custom mode.', 'No custom modes yet.')}</div></div></div>
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
      if (target.dataset.bulkMemberAction === 'friend') {
        await Promise.all(selected.map(userId => runAction('send-friend-request', { userId, message: 'Xin chào, mình là Williams bot owner.' }, 'Friend request sent')));
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
          await Promise.all(selected.map(userId => runAction('send-message', { targetType: 'user', targetId: userId, text }, 'Bulk DM sent')));
          showToast(t('Đã gửi DM hàng loạt', 'Bulk DM sent'), 'success');
        }
      }
    }
    if (target.dataset.bulkFeature) {
      if (!state.license?.isPro) {
        showToast(t('Thao tác hàng loạt cho nhiều group yêu cầu bản quyền PRO!', 'Bulk operations for multiple groups require a PRO license!'), 'error');
        setSection('upgrade');
        return;
      }
      if (!selectedGroups.size) return showToast('Select at least one group first.', 'warning');
      const [key, rawValue] = target.dataset.bulkFeature.split(':');
      const value = rawValue === 'true';
      await Promise.all([...selectedGroups].map(groupId => runAction('toggle-setting', { groupId, key, value }, 'Bulk groups updated')));
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
      const groupId = target.dataset.groupDetail;
      let detail = null;
      try { detail = await runAction('group-detail', { groupId }, 'Group detail loaded'); } catch (_) { }
      if (!detail) {
        let pendingResult = null;
        try { pendingResult = await runAction('get-pending', { groupId }, 'Pending members loaded'); } catch (_) { }
        detail = buildLocalGroupDetail(groupId, pendingResult);
      }
      currentDetailGroupId = groupId;
      currentDetailPayload = detail;
      await openModal({ title: uiText('Chi tiết group', 'Group details'), body: groupDetailBody(detail), confirmText: uiText('Đóng', 'Close') });
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
      await runAction('toggle-setting', { groupId, key, value: rawValue === 'true' }, t(`${key} đã cập nhật`, `${key} updated`));
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
        const payload = {};
        await runAction('sync-groups', payload, t('Đã sync group từ ZCA', 'Synced groups from ZCA'));
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

        const isPro = !!(state?.license?.isPro);
        if (targets.length > 1 && !isPro) {
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
        for (let i = 0; i < targets.length; i++) {
          const { targetType, targetId } = targets[i];
          try {
            if (i > 0) await new Promise(r => setTimeout(r, 300));
            await runAction('send-message', { targetType, targetId, text }, null);
            successCount++;
          } catch (err) {
            console.error(err);
            failCount++;
          }
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

const themeToggle = document.getElementById('themeToggle');
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('zaloDashboardTheme', next);
    syncChromeState();
    showToast(next === 'dark' ? t('Đã bật dark mode', 'Dark mode enabled') : t('Đã chuyển sang light mode', 'Light mode enabled'), 'success');
  });
}
const langToggle = document.getElementById('langToggle');
if (langToggle) {
  langToggle.addEventListener('click', () => {
    lang = lang === 'vi' ? 'en' : 'vi';
    localStorage.setItem('zaloDashboardLang', lang);
    applyI18n();
    if (state) renderState();
    showToast(lang === 'vi' ? 'Ngôn ngữ: Tiếng Việt' : 'Language: English', 'info');
  });
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
    'menu': t('Menu lệnh', 'Slash Commands Menu')
  };
  
  titleEl.textContent = titles[activeTemplateKey] || activeTemplateKey;
  fileEl.textContent = `${activeTemplateKey}.txt`;
  
  // 3. Set text content
  const textarea = document.getElementById('template-textarea');
  textarea.value = state.templates[activeTemplateKey] || '';
  
  // 4. Custom modes only shown for menu
  const menuOnlyVars = document.querySelectorAll('#templates .var-menu-only');
  menuOnlyVars.forEach(el => {
    el.style.display = (activeTemplateKey === 'menu') ? 'inline-flex' : 'none';
  });
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
  
  // Bind save button
  const saveBtn = document.getElementById('btn-save-template');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const textarea = document.getElementById('template-textarea');
      const content = textarea.value;
      
      setButtonLoading(saveBtn, true);
      try {
        const res = await api('/api/action', {
          method: 'POST',
          body: JSON.stringify({
            action: 'save-templates',
            payload: { key: activeTemplateKey, content }
          })
        });
        if (res.ok) {
          showToast(t('Lưu cấu hình thành công!', 'Template saved successfully!'), 'success');
          // Update in local state object too
          state.templates[activeTemplateKey] = content;
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
        cmdPrefix: state.bot?.cmdPrefix || '/bot-'
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

// FB CRAWLER MANAGER MODULE
// ═══════════════════════════════════════════════════════════════════════════

var fbState = null; // { config, reportTemplate, defaultTemplate }
var fbGroupsList = []; // in-memory group list (pending save)
var fbCronList = [];   // in-memory cron list (pending save)
var fbNotifySelectedGroupIds = [];
var fbNotifySelectedDmUserIds = [];

// Helper to populate profile dropdown select
function populateFbProfileSelect() {
  const select = document.getElementById('fbProfileSelect');
  if (!select) return;
  const currentVal = select.value;
  const botsList = (window.state && window.state.bots) ? window.state.bots : [];
  let optionsHtml = '';
  if (botsList.length === 0) {
    optionsHtml = '<option value="default">Default Bot</option>';
  } else {
    optionsHtml = botsList.map(bot => {
      return `<option value="${esc(bot.id)}">${esc(bot.name)} (${esc(bot.id)})</option>`;
    }).join('');
  }
  select.innerHTML = optionsHtml;
  if (currentVal && Array.from(select.options).some(opt => opt.value === currentVal)) {
    select.value = currentVal;
  } else {
    select.selectedIndex = 0;
  }
}

window.fbProfileChanged = async function () {
  await window.loadFbCrawlerState();
};

window.fbToggleUseAi = function (val) {
  const settingsGroup = document.getElementById('fbAiSettingsGroup');
  if (settingsGroup) {
    if (val) {
      settingsGroup.style.opacity = '1';
      settingsGroup.style.pointerEvents = 'auto';
    } else {
      settingsGroup.style.opacity = '0.5';
      settingsGroup.style.pointerEvents = 'none';
    }
  }
};

// ─── Load state ───────────────────────────────────────────────────────────────
window.loadFbCrawlerState = async function () {
  const selectEl = document.getElementById('fbProfileSelect');
  if (selectEl && selectEl.options.length === 0) {
    populateFbProfileSelect();
  }
  const profile = selectEl ? selectEl.value : 'banxe';

  const bar = document.getElementById('fbCrawlerStatusBar');
  try {
    const data = await api('/api/fb-crawler/state?profile=' + encodeURIComponent(profile));
    fbState = data;
    fbGroupsList = (data.config?.groups || []).map(g => ({ ...g }));
    fbCronList = (data.config?.cronSchedule || []).map(s => ({ ...s }));

    // Status bar
    if (bar) {
      bar.style.display = 'flex';
      document.getElementById('fbCrawlerStatusText').textContent =
        `FB Crawler (${profile}): ${fbGroupsList.length} ${t('nhóm', 'groups')}, ${fbCronList.length} ${t('phiên', 'sessions')} cron`;
    }

    renderFbGroups();
    renderFbCronTable();
    renderFbRules(data.config?.rules || {});
    renderFbNotify(data.config || {});
    renderFbTemplate(data.reportTemplate || data.defaultTemplate || '');

    // Render Cookies Status
    const statusEl = document.getElementById('fbCookiesStatus');
    const clearBtn = document.getElementById('btnFbClearCookies');
    const ta = document.getElementById('fbCookiesTextarea');
    if (statusEl) {
      if (data.hasCookies) {
        statusEl.textContent = `${t('Đã nạp Cookies', 'Cookies loaded')} (${data.cookiesCount || 0} ${t('mục', 'items')})`;
        statusEl.style.color = 'var(--success, #10b981)';
        if (clearBtn) clearBtn.style.display = 'inline-block';
      } else {
        statusEl.textContent = t('Chưa nạp Cookies (Trình duyệt sẽ chạy ẩn danh không đăng nhập)', 'No Cookies loaded (Browser will run in incognito mode without logging in)');
        statusEl.style.color = 'var(--text-muted)';
        if (clearBtn) clearBtn.style.display = 'none';
        if (ta) ta.value = '';
      }
    }
  } catch (e) {
    if (bar) {
      bar.style.display = 'flex';
      document.getElementById('fbCrawlerStatusDot').style.background = '#ef4444';
      document.getElementById('fbCrawlerStatusText').textContent = t('Lỗi tải FB Crawler: ', 'Error loading FB Crawler: ') + e.message;
    }
  }
};

// ─── PANEL 1: Groups ─────────────────────────────────────────────────────────
function renderFbGroups() {
  const tbody = document.getElementById('fbGroupsTbody');
  const countEl = document.getElementById('fbGroupsCount');
  if (!tbody) return;

  if (!fbGroupsList.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px;">${t('Chưa có group nào. Thêm group hoặc import file CSV.', 'No groups yet. Add a group or import a CSV file.')}</td></tr>`;
    if (countEl) countEl.textContent = '0 groups';
    return;
  }

  tbody.innerHTML = fbGroupsList.map((g, i) => `
    <tr>
      <td style="color:var(--text-muted);font-size:12px;">${i + 1}</td>
      <td><code style="font-size:12px;background:var(--bg-hover);padding:2px 6px;border-radius:4px;">${esc(g.key || '')}</code></td>
      <td style="font-size:13px;">${esc(g.name || '')}</td>
      <td style="font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        <a href="${esc(g.url)}" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:none;" title="${esc(g.url)}">${esc(g.url.replace('https://www.facebook.com/groups/', 'fb.com/groups/'))}</a>
      </td>
      <td style="font-size:12px;color:var(--text-muted);">${(g.vehicleKeywords || []).join('; ') || '-'}</td>
      <td>
        <button class="btn" type="button" style="padding:3px 8px;font-size:12px;" onclick="fbDeleteGroup(${i})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:13px;height:13px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6m4-6v6"/></svg>
        </button>
      </td>
    </tr>`).join('');

  if (countEl) countEl.textContent = `${fbGroupsList.length} ${t('nhóm', 'groups')}`;
}

window.fbAddGroup = function () {
  const key = document.getElementById('fbNewGroupKey')?.value.trim();
  const name = document.getElementById('fbNewGroupName')?.value.trim();
  const url = document.getElementById('fbNewGroupUrl')?.value.trim();
  const vkStr = document.getElementById('fbNewGroupVK')?.value.trim();

  if (!url || !url.startsWith('http')) {
    showToast(t('Vui lòng nhập URL group Facebook hợp lệ!', 'Please enter a valid Facebook group URL!'), 'warning'); return;
  }
  if (fbGroupsList.some(g => g.url === url)) {
    showToast(t('Group này đã tồn tại trong danh sách!', 'This group already exists in the list!'), 'warning'); return;
  }

  const vehicleKeywords = vkStr ? vkStr.split(';').map(s => s.trim()).filter(Boolean) : [];
  fbGroupsList.push({
    id: Date.now(),
    key: key || `grp${fbGroupsList.length + 1}`,
    name: name || url,
    url,
    vehicleKeywords
  });
  renderFbGroups();

  // Clear inputs
  ['fbNewGroupKey', 'fbNewGroupName', 'fbNewGroupUrl', 'fbNewGroupVK'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  showToast(t('Đã thêm group vào danh sách. Nhớ nhấn "Lưu danh sách"!', 'Group added to list. Remember to click "Save list"!'), 'info');
};

window.fbDeleteGroup = function (index) {
  fbGroupsList.splice(index, 1);
  renderFbGroups();
};

window.fbSaveGroups = async function () {
  const btn = document.getElementById('btnFbSaveGroups');
  const profile = document.getElementById('fbProfileSelect') ? document.getElementById('fbProfileSelect').value : 'banxe';
  setButtonLoading(btn, true);
  try {
    const data = await api('/api/fb-crawler/save-groups?profile=' + encodeURIComponent(profile), {
      method: 'POST',
      body: JSON.stringify({ groups: fbGroupsList }),
    });
    showToast(t('Đã lưu ', 'Saved ') + data.count + t(' groups thành công!', ' groups successfully!'), 'success');
    await loadFbCrawlerState();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
};

// ─── Import / Export CSV ──────────────────────────────────────────────────────
window.fbDownloadSampleExcel = function () {
  const a = document.createElement('a');
  a.href = (location.protocol === 'file:' ? 'http://127.0.0.1:19790' : '') + '/api/fb-crawler/sample-excel';
  a.download = 'fb-groups-sample.csv';
  const currentToken = token || localStorage.getItem('zaloDashboardToken') || 'openclaw-zalo-mod';
  // Add auth header via fetch blob
  api('/api/fb-crawler/sample-excel').then(() => {
    fetch((location.protocol === 'file:' ? 'http://127.0.0.1:19790' : '') + '/api/fb-crawler/sample-excel', {
      headers: { 'authorization': `Bearer ${currentToken}` }
    }).then(r => r.blob()).then(blob => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'fb-groups-sample.csv';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }).catch(() => {
    // Fallback: generate client-side
    // Fallback: generate client-side with semicolon separator (Excel VN compatible)
    const csvRows = ['sep=;', 'Key;T\u00ean Group;URL;T\u1eeb kho\u00e1 xe (ng\u0103n c\u00e1ch b\u1eb1ng d\u1ea5u c\u00e1ch)', 'nvx;Yamaha NVX - Mua b\u00e1n xe;https://www.facebook.com/groups/example1/;nvx nvx155', 'wave;Honda Wave - Group b\u00e1n xe;https://www.facebook.com/groups/example2/;wave alpha', 'airb;Yamaha Airblade Group;https://www.facebook.com/groups/example3/;airblade airblade155', 'sh;Honda SH - Mua b\u00e1n SH;https://www.facebook.com/groups/example4/;sh sh150 sh160'];
    const blob = new Blob(['\uFEFF' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fb-groups-sample.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
};

window.fbImportExcelFile = async function (input) {
  const file = input.files[0];
  if (!file) return;
  const btn = document.getElementById('btnFbImportExcel');
  setButtonLoading(btn, true);
  try {
    // Read as base64 — works for both CSV and XLSX binary
    const arrayBuf = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuf);
    let binary = '';
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
    const b64 = btoa(binary);
    const data = await api('/api/fb-crawler/import-excel', {
      method: 'POST',
      body: JSON.stringify({ csvBase64: b64 }),
    });
    if (!data.groups || data.groups.length === 0) {
      showToast(t('Không parse được group nào. Kiểm tra lại định dạng file!', 'No groups parsed. Check the file format!'), 'warning');
      return;
    }
    fbShowImportModal(data.groups);
  } catch (e) {
    showToast(t('Lỗi import: ', 'Import error: ') + e.message, 'error');
  } finally {
    setButtonLoading(btn, false);
    input.value = '';
  }
};

// ─── Import modal ──────────────────────────────────────────────────────────────
let fbImportParsedGroups = [];
let fbImportSelected = new Set();

function fbShowImportModal(groups) {
  fbImportParsedGroups = groups;
  fbImportSelected = new Set();
  const existingUrls = new Set(fbGroupsList.map(function(g) { return g.url; }));

  // Default: select all non-duplicates
  groups.forEach(function(g, i) {
    if (!existingUrls.has(g.url)) fbImportSelected.add(i);
  });

  const rows = groups.map(function(g, i) {
    const isDup = existingUrls.has(g.url);
    const checked = fbImportSelected.has(i);
    const shortUrl = g.url.replace('https://www.facebook.com/groups/', 'fb.com/groups/');
    const kws = (g.vehicleKeywords || []).join(', ') || '-';
    return [
      '<tr class="fb-import-row' + (isDup ? ' dup' : '') + '" data-idx="' + i + '">',
        '<td style="width:36px;text-align:center;padding:8px 6px">',
          '<input type="checkbox"' + (checked ? ' checked' : '') + (isDup ? ' title="URL đã tồn tại"' : '') + ' onchange="fbImportToggle(' + i + ',this.checked)">',
        '</td>',
        '<td style="width:100px;padding:8px 6px"><code style="font-size:11px;background:var(--bg);border:1px solid var(--line);padding:1px 5px;border-radius:3px">' + esc(g.key) + '</code></td>',
        '<td style="padding:8px 6px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px" title="' + esc(g.name) + '">' + esc(g.name) + '</td>',
        '<td style="padding:8px 6px;font-size:11px;color:var(--muted);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(g.url) + '">',
          '<a href="' + esc(g.url) + '" target="_blank" style="color:var(--primary)">' + esc(shortUrl) + '</a>',
        '</td>',
        '<td style="padding:8px 6px;font-size:11px;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(kws) + '">' + esc(kws) + '</td>',
        '<td style="padding:8px 6px;width:60px;font-size:11px;color:var(--warning);white-space:nowrap">' + (isDup ? t('⚠ Trùng', '⚠ Duplicate') : '') + '</td>',
      '</tr>',
    ].join('');
  }).join('');

  const dupCount = groups.filter(function(g) { return existingUrls.has(g.url); }).length;
  const newCount = groups.length - dupCount;

  const body = [
    '<div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">',
      '<span style="font-size:13px">',
        t('Tìm thấy', 'Found') + ' <strong>' + groups.length + '</strong> ' + t('groups', 'groups'),
        (dupCount ? ' &nbsp;·&nbsp; <span style="color:var(--warning)">' + dupCount + ' ' + t('trùng', 'duplicates') + '</span>' : ''),
        ' &nbsp;·&nbsp; <span style="color:var(--success)">' + newCount + ' ' + t('mới', 'new') + '</span>',
      '</span>',
      '<label style="font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer">',
        '<input type="checkbox" id="fbImportSelectAllCb" checked onchange="fbImportSelectAll(this.checked)"> ' + t('Chọn tất cả', 'Select all'),
      '</label>',
    '</div>',
    '<div class="table-wrap" style="max-height:340px;overflow-y:auto;border:1px solid var(--line);border-radius:var(--radius)">',
      '<table style="width:100%;border-collapse:collapse">',
        '<thead><tr style="background:var(--surface-2,var(--bg));font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">',
          '<th style="width:36px;padding:8px 6px"></th>',
          '<th style="padding:8px 6px;text-align:left">Key</th>',
          '<th style="padding:8px 6px;text-align:left">' + t('Tên Group', 'Group Name') + '</th>',
          '<th style="padding:8px 6px;text-align:left">URL</th>',
          '<th style="padding:8px 6px;text-align:left">' + t('Từ khóa', 'Keywords') + '</th>',
          '<th style="width:52px;padding:8px 6px"></th>',
        '</tr></thead>',
        '<tbody id="fbImportModalBody">' + rows + '</tbody>',
      '</table>',
    '</div>',
    '<p style="margin:10px 0 0;font-size:12px;color:var(--muted)">' + t('Bỏ tích những group không muốn thêm. Nhấn <strong>Thêm vào danh sách</strong> để xác nhận.', 'Uncheck groups you do not want to add. Press <strong>Add to list</strong> to confirm.') + '</p>',
  ].join('');

  openModal({
    title: t('📥 Import Group Facebook', '📥 Import Facebook Groups'),
    desc: t('Chọn các group muốn thêm vào danh sách quét.', 'Select groups to add to crawl list.'),
    body: body,
    confirmText: t('Thêm vào danh sách', 'Add to list'),
    tone: 'info',
    large: true,
  }).then(function(confirmed) {
    if (confirmed === false) return;
    fbImportConfirm();
  });
}

window.fbImportToggle = function(idx, val) {
  if (val) { fbImportSelected.add(idx); } else { fbImportSelected.delete(idx); }
  // Update "select all" checkbox state
  const cb = document.getElementById('fbImportSelectAllCb');
  if (cb) {
    const existingUrls = new Set(fbGroupsList.map(function(g) { return g.url; }));
    const selectableCount = fbImportParsedGroups.filter(function(g) { return !existingUrls.has(g.url); }).length;
    cb.checked = fbImportSelected.size === selectableCount;
  }
};

window.fbImportSelectAll = function(val) {
  const existingUrls = new Set(fbGroupsList.map(function(g) { return g.url; }));
  fbImportParsedGroups.forEach(function(g, i) {
    if (!existingUrls.has(g.url)) {
      if (val) { fbImportSelected.add(i); } else { fbImportSelected.delete(i); }
      const row = document.querySelector('#fbImportModalBody tr[data-idx="' + i + '"] input[type=checkbox]');
      if (row) row.checked = val;
    }
  });
};

function fbImportConfirm() {
  const existingUrls = new Set(fbGroupsList.map(function(g) { return g.url; }));
  let added = 0;
  Array.from(fbImportSelected).forEach(function(idx) {
    const g = fbImportParsedGroups[idx];
    if (g && !existingUrls.has(g.url)) {
      fbGroupsList.push(Object.assign({}, g, { id: Date.now() + added }));
      existingUrls.add(g.url);
      added++;
    }
  });
  renderFbGroups();
  if (added > 0) {
    showToast(t('Đã thêm ', 'Added ') + added + t(' group mới! Nhấn "Lưu danh sách" để lưu.', ' new groups! Click "Save list" to save.'), 'success');
  } else {
    showToast(t('Không có group mới nào được chọn.', 'No new groups selected.'), 'warning');
  }
}


// — PANEL 2: Rules — Province pills + Extractor toggles ——————————————————————

// 63 provinces of Vietnam with search keywords
const FB_PROVINCES = [
  { id: 'hanoi',      label: 'Hà Nội',         kw: ['hà nội','hanoi','hn'] },
  { id: 'hcm',        label: 'TP.HCM',          kw: ['hồ chí minh','hcm','sài gòn','saigon','tphcm'] },
  { id: 'danang',     label: 'Đà Nẵng',         kw: ['đà nẵng','da nang','đn'] },
  { id: 'haiphong',   label: 'Hải Phòng',       kw: ['hải phòng','hai phong','hp'] },
  { id: 'cantho',     label: 'Cần Thơ',         kw: ['cần thơ','can tho','ct'] },
  { id: 'binhduong',  label: 'Bình Dương',      kw: ['bình dương','binh duong','bd','thủ dầu một'] },
  { id: 'dongnai',    label: 'Đồng Nai',        kw: ['đồng nai','dong nai','dn','biên hòa'] },
  { id: 'longan',     label: 'Long An',         kw: ['long an','tân an'] },
  { id: 'angiang',    label: 'An Giang',        kw: ['an giang','long xuyên','châu đốc'] },
  { id: 'bariavungtau', label: 'BR-Vũng Tàu',  kw: ['bà rịa','vũng tàu','brvt'] },
  { id: 'bacgiang',   label: 'Bắc Giang',      kw: ['bắc giang','bac giang'] },
  { id: 'backan',     label: 'Bắc Kạn',        kw: ['bắc kạn','bac kan'] },
  { id: 'baclieu',    label: 'Bạc Liêu',       kw: ['bạc liêu','bac lieu'] },
  { id: 'bacninh',    label: 'Bắc Ninh',       kw: ['bắc ninh','bac ninh'] },
  { id: 'bentre',     label: 'Bến Tre',        kw: ['bến tre','ben tre'] },
  { id: 'binhdinh',   label: 'Bình Định',      kw: ['bình định','binh dinh','quy nhơn'] },
  { id: 'binhphuoc',  label: 'Bình Phước',     kw: ['bình phước','binh phuoc','đồng xoài'] },
  { id: 'binhthuan',  label: 'Bình Thuận',     kw: ['bình thuận','binh thuan','phan thiết'] },
  { id: 'camau',      label: 'Cà Mau',         kw: ['cà mau','ca mau'] },
  { id: 'caobang',    label: 'Cao Bằng',       kw: ['cao bằng','cao bang'] },
  { id: 'daklak',     label: 'Đắk Lắk',       kw: ['đắk lắk','dak lak','buôn ma thuột'] },
  { id: 'daknong',    label: 'Đắk Nông',       kw: ['đắk nông','dak nong','gia nghĩa'] },
  { id: 'dienbien',   label: 'Điện Biên',      kw: ['điện biên','dien bien'] },
  { id: 'gialai',     label: 'Gia Lai',        kw: ['gia lai','pleiku'] },
  { id: 'hagiang',    label: 'Hà Giang',       kw: ['hà giang','ha giang'] },
  { id: 'hanam',      label: 'Hà Nam',         kw: ['hà nam','ha nam','phủ lý'] },
  { id: 'hatinh',     label: 'Hà Tĩnh',        kw: ['hà tĩnh','ha tinh'] },
  { id: 'haiduong',   label: 'Hải Dương',      kw: ['hải dương','hai duong'] },
  { id: 'haugiang',   label: 'Hậu Giang',      kw: ['hậu giang','hau giang','vị thanh'] },
  { id: 'hoabinh',    label: 'Hòa Bình',       kw: ['hòa bình','hoa binh'] },
  { id: 'hungyen',    label: 'Hưng Yên',       kw: ['hưng yên','hung yen'] },
  { id: 'khanhhoa',   label: 'Khánh Hòa',      kw: ['khánh hòa','khanh hoa','nha trang'] },
  { id: 'kiengiang',  label: 'Kiên Giang',     kw: ['kiên giang','kien giang','rạch giá','phú quốc'] },
  { id: 'kontum',     label: 'Kon Tum',        kw: ['kon tum','kontum'] },
  { id: 'laichau',    label: 'Lai Châu',       kw: ['lai châu','lai chau'] },
  { id: 'lamdong',    label: 'Lâm Đồng',       kw: ['lâm đồng','lam dong','đà lạt','dalat'] },
  { id: 'langson',    label: 'Lạng Sơn',       kw: ['lạng sơn','lang son'] },
  { id: 'laocai',     label: 'Lào Cai',        kw: ['lào cai','lao cai','sa pa'] },
  { id: 'namdinh',    label: 'Nam Định',       kw: ['nam định','nam dinh'] },
  { id: 'nghean',     label: 'Nghệ An',        kw: ['nghệ an','nghe an','vinh'] },
  { id: 'ninhbinh',   label: 'Ninh Bình',      kw: ['ninh bình','ninh binh'] },
  { id: 'ninhthuan',  label: 'Ninh Thuận',     kw: ['ninh thuận','ninh thuan','phan rang'] },
  { id: 'phutho',     label: 'Phú Thọ',        kw: ['phú thọ','phu tho','việt trì'] },
  { id: 'phuyen',     label: 'Phú Yên',        kw: ['phú yên','phu yen','tuy hòa'] },
  { id: 'quangbinh',  label: 'Quảng Bình',     kw: ['quảng bình','quang binh','đồng hới'] },
  { id: 'quangnam',   label: 'Quảng Nam',      kw: ['quảng nam','quang nam','hội an','tam kỳ'] },
  { id: 'quangngai',  label: 'Quảng Ngãi',     kw: ['quảng ngãi','quang ngai'] },
  { id: 'quangninh',  label: 'Quảng Ninh',     kw: ['quảng ninh','quang ninh','hạ long','ha long'] },
  { id: 'quangtri',   label: 'Quảng Trị',      kw: ['quảng trị','quang tri','đông hà'] },
  { id: 'soctrang',   label: 'Sóc Trăng',      kw: ['sóc trăng','soc trang'] },
  { id: 'sonla',      label: 'Sơn La',         kw: ['sơn la','son la'] },
  { id: 'tayninh',    label: 'Tây Ninh',       kw: ['tây ninh','tay ninh'] },
  { id: 'thaibinh',   label: 'Thái Bình',      kw: ['thái bình','thai binh'] },
  { id: 'thainguyen', label: 'Thái Nguyên',    kw: ['thái nguyên','thai nguyen'] },
  { id: 'thanhhoa',   label: 'Thanh Hóa',      kw: ['thanh hóa','thanh hoa'] },
  { id: 'thuathienhue', label: 'TT-Huế',       kw: ['thừa thiên','huế','hue','thua thien'] },
  { id: 'tiengiang',  label: 'Tiền Giang',     kw: ['tiền giang','tien giang','mỹ tho'] },
  { id: 'travinh',    label: 'Trà Vinh',       kw: ['trà vinh','tra vinh'] },
  { id: 'tuyenquang', label: 'Tuyên Quang',    kw: ['tuyên quang','tuyen quang'] },
  { id: 'vinhlong',   label: 'Vĩnh Long',      kw: ['vĩnh long','vinh long'] },
  { id: 'vinhphuc',   label: 'Vĩnh Phúc',      kw: ['vĩnh phúc','vinh phuc','vĩnh yên'] },
  { id: 'yenbai',     label: 'Yên Bái',        kw: ['yên bái','yen bai'] },
];

// Pre-built regex extractor presets
const FB_EXTRACTORS = [
  { id: 'phone',   name: t('Số điện thoại', 'Phone number'), desc: '0xxxxxxxxx / 0xxxxxxxxxx', pattern: String.raw`(0[35789]\d{8,9})` },
  { id: 'price',   name: t('Giá bán', 'Price'),       desc: 'xxx triệu / xxxk / xxx đ',  pattern: String.raw`(\d[\d\.,]*\s*(?:tr(?:iệu)?|k|đồng|đ|million|m))` },
  { id: 'year',    name: t('Năm sản xuất', 'Production year'),  desc: '20xx / 19xx',              pattern: String.raw`(?:năm|sx|đời|model)?\s*(20\d{2}|19\d{2})` },
  { id: 'address', name: t('Địa chỉ', 'Address'),       desc: t('Phường/Xã, Quận/Huyện', 'Ward/District'),   pattern: String.raw`(?:tại|ở|địa chỉ|khu vực)[:\s]+([^,\n.]{5,60})` },
  { id: 'color',   name: t('Màu sắc', 'Color'),       desc: t('đen/trắng/đỏ/xanh...', 'black/white/red/blue...'),    pattern: String.raw`(?:màu|color)[:\s]*((?:đen|trắng|đỏ|xanh|vàng|bạc|xám|cam|tím|hồng|nâu)\w*)` },
];

// State
let fbSelectedProvinces = new Set();
let fbExtractorEnabled  = {};

function renderFbProvinces(filter) {
  filter = filter || '';
  const grid = document.getElementById('fbProvinceGrid');
  if (!grid) return;
  const q = filter.toLowerCase().trim();
  const visible = FB_PROVINCES.filter(function(p) {
    return !q || p.label.toLowerCase().includes(q) || p.kw.some(function(k) { return k.includes(q); });
  });
  grid.innerHTML = visible.map(function(p) {
    return '<button type="button" class="util-province-pill' + (fbSelectedProvinces.has(p.id) ? ' selected' : '') + '" data-pid="' + p.id + '" onclick="fbToggleProvince(\'' + p.id + '\')">' + p.label + '</button>';
  }).join('');
}

window.fbToggleProvince = function(id) {
  if (fbSelectedProvinces.has(id)) {
    fbSelectedProvinces.delete(id);
  } else {
    fbSelectedProvinces.add(id);
  }
  renderFbProvinces(document.getElementById('fbLocationSearch') ? document.getElementById('fbLocationSearch').value : '');
  renderFbLocationSelected();
};

window.fbFilterProvinces = function(q) { renderFbProvinces(q); };

window.fbClearLocations = function() {
  fbSelectedProvinces.clear();
  renderFbProvinces(document.getElementById('fbLocationSearch') ? document.getElementById('fbLocationSearch').value : '');
  renderFbLocationSelected();
};

function renderFbLocationSelected() {
  const el = document.getElementById('fbLocationSelected');
  if (!el) return;
  if (!fbSelectedProvinces.size) {
    el.innerHTML = '<span class="util-muted">' + t('Chưa chọn khu vực nào — hệ thống chấp nhận mọi tỉnh thành', 'No region selected — system accepts all provinces/cities') + '</span>';
    return;
  }
  const tags = Array.from(fbSelectedProvinces).map(function(id) {
    const p = FB_PROVINCES.find(function(x) { return x.id === id; });
    if (!p) return '';
    return '<span class="util-selected-tag">' + p.label + '<button type="button" onclick="fbToggleProvince(\'' + id + '\')" title="' + t('Bỏ chọn', 'Remove') + '">&times;</button></span>';
  }).join('');
  el.innerHTML = tags;
}

function renderFbExtractors() {
  const grid = document.getElementById('fbExtractorGrid');
  if (!grid) return;
  grid.innerHTML = FB_EXTRACTORS.map(function(ex) {
    const active = !!fbExtractorEnabled[ex.id];
    const shortPat = ex.pattern.length > 28 ? ex.pattern.slice(0, 28) + '…' : ex.pattern;
    return '<div class="util-extractor-item' + (active ? ' active' : '') + '" id="extractor-row-' + ex.id + '">' +
      '<div class="util-extractor-info">' +
        '<span class="util-extractor-name">' + ex.name + '</span>' +
        '<span class="util-extractor-desc">' + ex.desc + '</span>' +
      '</div>' +
      '<code class="util-extractor-code" title="' + ex.pattern + '">' + shortPat + '</code>' +
      '<label class="util-toggle" title="' + (active ? t('Đang bật', 'Enabled') : t('Đang tắt', 'Disabled')) + '">' +
        '<input type="checkbox" ' + (active ? 'checked' : '') + ' onchange="fbToggleExtractor(\'' + ex.id + '\', this.checked)">' +
        '<span class="util-toggle-slider"></span>' +
      '</label>' +
    '</div>';
  }).join('');
}

window.fbToggleExtractor = function(id, val) {
  fbExtractorEnabled[id] = val;
  const row = document.getElementById('extractor-row-' + id);
  if (row) row.classList.toggle('active', val);
};

function renderFbRules(rules) {
  const rk = document.getElementById('fbRequireKeywords');
  const bk = document.getElementById('fbBlockKeywords');
  const maxPosts = document.getElementById('fbMaxPosts');
  const useAi = document.getElementById('fbUseAi');
  const aiDesc = document.getElementById('fbAiProductDesc');

  if (rk) rk.value = (rules.requireKeywords || []).join('\n');
  if (bk) bk.value = (rules.blockKeywords || []).join('\n');
  if (maxPosts) maxPosts.value = rules.maxPosts || '';

  if (useAi) {
    useAi.checked = rules.useAi !== false;
    fbToggleUseAi(useAi.checked);
  }
  if (aiDesc) aiDesc.value = rules.aiProductDesc || '';

  // Restore selected provinces
  fbSelectedProvinces.clear();
  const locObj = rules.locations || {};
  Object.keys(locObj).forEach(function(id) {
    if (FB_PROVINCES.find(function(p) { return p.id === id; })) fbSelectedProvinces.add(id);
  });

  // Restore extractor toggles
  const reObj = rules.extractRegex || {};
  fbExtractorEnabled = {};
  FB_EXTRACTORS.forEach(function(ex) {
    fbExtractorEnabled[ex.id] = !!reObj[ex.id];
  });

  renderFbProvinces();
  renderFbLocationSelected();
  renderFbExtractors();
}

window.fbSaveRules = async function() {
  const btn = document.getElementById('btnFbSaveRules');
  const profile = document.getElementById('fbProfileSelect') ? document.getElementById('fbProfileSelect').value : 'banxe';
  setButtonLoading(btn, true);
  try {
    const requireKeywords = (document.getElementById('fbRequireKeywords') ? document.getElementById('fbRequireKeywords').value : '')
      .split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
    const blockKeywords = (document.getElementById('fbBlockKeywords') ? document.getElementById('fbBlockKeywords').value : '')
      .split('\n').map(function(s) { return s.trim(); }).filter(Boolean);

    // Build locations from selected provinces
    const locations = {};
    fbSelectedProvinces.forEach(function(id) {
      const p = FB_PROVINCES.find(function(x) { return x.id === id; });
      if (p) locations[id] = p.kw;
    });

    // Build extractRegex from enabled toggles
    const extractRegex = {};
    FB_EXTRACTORS.forEach(function(ex) {
      if (fbExtractorEnabled[ex.id]) extractRegex[ex.id] = ex.pattern;
    });

    const maxPosts = Number(document.getElementById('fbMaxPosts') ? document.getElementById('fbMaxPosts').value : 0);
    const useAi = document.getElementById('fbUseAi') ? document.getElementById('fbUseAi').checked : true;
    const aiProductDesc = document.getElementById('fbAiProductDesc') ? document.getElementById('fbAiProductDesc').value.trim() : '';

    await api('/api/fb-crawler/save-rules?profile=' + encodeURIComponent(profile), {
      method: 'POST',
      body: JSON.stringify({ requireKeywords, blockKeywords, locations, extractRegex, maxPosts, useAi, aiProductDesc }),
    });
    showToast(t('Đã lưu điều kiện lọc thành công!', 'Filter conditions saved successfully!'), 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
};


// ─── PANEL 3: Cron schedule ───────────────────────────────────────────────────
function renderFbCronTable() {
  const tbody = document.getElementById('fbCronTbody');
  if (!tbody) return;
  if (!fbCronList.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">${t('Chưa có lịch nào. Nhấn "AI Đề xuất lịch" để tự động phân bổ.', 'No schedule yet. Click "AI Suggest Schedule" to auto distribute.')}</td></tr>`;
    return;
  }

  tbody.innerHTML = fbCronList.map((s, i) => {
    // Parse cron to readable time
    let readableTime = s.cron;
    try {
      const parts = s.cron.split(' ');
      if (parts.length >= 5) {
        const [min, hour] = parts;
        if (!isNaN(parseInt(min)) && !isNaN(parseInt(hour))) {
          const h = parseInt(hour);
          const m = parseInt(min);
          readableTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${t('mỗi ngày', 'daily')}`;
        }
      }
    } catch (_) {}

    const slice = Array.isArray(s.groupSlice)
      ? `${t('Nhóm', 'Group')} ${s.groupSlice[0] + 1} → ${s.groupSlice[1]}`
      : t('Tất cả', 'All');

    const active = s.enabled !== false;

    return `
      <tr>
        <td><code style="background:var(--bg-hover);padding:2px 8px;border-radius:4px;font-weight:700;">${esc(s.id)}</code></td>
        <td><code style="font-size:12px;">${esc(s.cron)}</code></td>
        <td style="font-size:13px;">${esc(readableTime)}${s.reason ? `<br><span style="font-size:11px;color:var(--text-muted);">${esc(s.reason)}</span>` : ''}</td>
        <td style="font-size:13px;">${esc(slice)}</td>
        <td>
          <div style="display: flex; align-items: center; justify-content: flex-end; gap: 8px;">
            <!-- Toggle switch (Bật/Tắt) -->
            <label class="util-toggle" style="margin: 0 4px 0 0;" title="${active ? t('Đang bật', 'Enabled') : t('Đang tắt', 'Disabled')}">
              <input type="checkbox" ${active ? 'checked' : ''} onchange="fbToggleCronEnabled(${i}, this.checked)">
              <span class="util-toggle-slider"></span>
            </label>
            <!-- Run immediately -->
            <button class="btn" type="button" style="padding:4px 8px;font-size:12px;min-height:auto;" onclick="fbRunCronImmediately(${i})" title="${t('Chạy ngay', 'Run now')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:13px;height:13px;color:var(--success, #10b981);"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <!-- Edit row -->
            <button class="btn" type="button" style="padding:4px 8px;font-size:12px;min-height:auto;" onclick="fbEditCronRow(${i})" title="${t('Sửa', 'Edit')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:13px;height:13px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <!-- Delete row -->
            <button class="btn" type="button" style="padding:4px 8px;font-size:12px;min-height:auto;" onclick="fbDeleteCronRow(${i})" title="${t('Xóa', 'Delete')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:13px;height:13px;color:var(--danger, #ef4444);"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

window.fbToggleCronEnabled = async function (index, checked) {
  if (!fbCronList[index]) return;
  fbCronList[index].enabled = checked;
  const profile = document.getElementById('fbProfileSelect') ? document.getElementById('fbProfileSelect').value : 'banxe';
  try {
    await api('/api/fb-crawler/save-cron?profile=' + encodeURIComponent(profile), {
      method: 'POST',
      body: JSON.stringify({ cronSchedule: fbCronList }),
    });
    showToast(t('Đã ', 'Successfully ') + (checked ? t('bật', 'enabled') : t('tắt', 'disabled')) + t(' lịch ', ' schedule ') + fbCronList[index].id + '!', 'success');
  } catch (e) {
    showToast('Lỗi: ' + e.message, 'error');
    // revert
    fbCronList[index].enabled = !checked;
    renderFbCronTable();
  }
};

window.fbRunCronImmediately = async function (index) {
  const item = fbCronList[index];
  if (!item) return;
  const profile = document.getElementById('fbProfileSelect') ? document.getElementById('fbProfileSelect').value : 'banxe';
  try {
    showToast(t('Đang chạy kích hoạt session ', 'Triggering session ') + item.id + t(' trong nền...', ' in background...'), 'info');
    await api('/api/fb-crawler/run-cron?profile=' + encodeURIComponent(profile), {
      method: 'POST',
      body: JSON.stringify({ id: item.id }),
    });
    showToast(t('Đã bắt đầu chạy session ', 'Session started: ') + item.id + '!', 'success');
  } catch (e) {
    showToast('Lỗi: ' + e.message, 'error');
  }
};

window.fbEditCronRow = async function (index) {
  const item = fbCronList[index];
  if (!item) return;

  function parseCronToTime(cronStr) {
    try {
      const parts = cronStr.split(' ');
      if (parts.length >= 2) {
        const [min, hour] = parts;
        const h = parseInt(hour);
        const m = parseInt(min);
        if (!isNaN(h) && !isNaN(m)) {
          return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
      }
    } catch (_) {}
    return '';
  }

  const currentVal = parseCronToTime(item.cron) || '12:00';
  const fromVal = item.groupSlice ? item.groupSlice[0] : '';
  const toVal = item.groupSlice ? item.groupSlice[1] : '';
  const reasonVal = item.reason || '';

  const body = `
    <div style="display:flex; flex-direction:column; gap:12px; padding: 10px 0;">
      <div class="util-field">
        <label class="util-label">${t('ID Session', 'Session ID')}</label>
        <input type="text" id="editCronId" value="${esc(item.id)}" readonly disabled class="util-input" style="opacity: 0.6; cursor: not-allowed;">
      </div>
      <div class="util-field">
        <label class="util-label">${t('Giờ chạy (VN)', 'Execution Time (VN)')}</label>
        <input type="time" id="editCronTime" value="${esc(currentVal)}" class="util-input" style="height:36px; padding:0 10px;">
      </div>
      <div style="display:flex; gap:12px;">
        <div class="util-field" style="flex:1;">
          <label class="util-label">${t('Group từ', 'Group from')}</label>
          <input type="number" id="editCronSliceFrom" value="${esc(fromVal)}" placeholder="0" min="0" class="util-input">
        </div>
        <div class="util-field" style="flex:1;">
          <label class="util-label">${t('đến', 'to')}</label>
          <input type="number" id="editCronSliceTo" value="${esc(toVal)}" placeholder="5" min="1" class="util-input">
        </div>
      </div>
      <div class="util-field">
        <label class="util-label">${t('Ghi chú / Lý do (AI hoặc tự nhập)', 'Notes / Reason (AI or manual)')}</label>
        <input type="text" id="editCronReason" value="${esc(reasonVal)}" placeholder="${t('Nhập ghi chú hoặc lý do quét...', 'Enter notes or reason...')}" class="util-input">
      </div>
    </div>
  `;

  const confirmed = await openModal({
    title: t('Sửa lịch quét tự động', 'Edit Auto Crawl Schedule'),
    desc: t('Chỉnh sửa các tham số của session quét.', 'Edit crawl session parameters.'),
    body,
    confirmText: t('Cập nhật', 'Update'),
    tone: 'info'
  });

  if (confirmed !== false) {
    const timeVal = document.getElementById('editCronTime')?.value;
    const from = document.getElementById('editCronSliceFrom')?.value;
    const to = document.getElementById('editCronSliceTo')?.value;
    const reason = document.getElementById('editCronReason')?.value.trim();

    if (!timeVal) {
      showToast(t('Thời gian không được để trống!', 'Time cannot be empty!'), 'warning');
      return;
    }

    const [hourStr, minStr] = timeVal.split(':');
    const hour = parseInt(hourStr);
    const min = parseInt(minStr);
    const cron = `${min} ${hour} * * *`;

    fbCronList[index] = {
      ...fbCronList[index],
      cron,
      groupSlice: (from !== '' && to !== '') ? [Number(from), Number(to)] : null,
      reason: reason || undefined
    };

    renderFbCronTable();
    showToast(t('Đã cập nhật lịch. Nhấn "Lưu lịch" để áp dụng vĩnh viễn!', 'Schedule updated. Click "Save Schedule" to apply permanently!'), 'info');
  }
};

window.fbRunAllImmediately = async function () {
  const confirmed = await openModal({
    title: t('Chạy quét tất cả các Group', 'Crawl All Groups'),
    desc: t('Bạn có chắc chắn muốn chạy quét toàn bộ các Group Facebook ngay lập tức không? Quá trình sẽ được thực hiện trong nền.', 'Are you sure you want to crawl all Facebook Groups immediately? The process will run in the background.'),
    confirmText: t('Chạy ngay', 'Run now'),
    tone: 'warning'
  });
  if (confirmed === false) return;

  const btn = document.getElementById('btnFbRunAll');
  if (btn) setButtonLoading(btn, true);
  const profile = document.getElementById('fbProfileSelect') ? document.getElementById('fbProfileSelect').value : 'banxe';
  try {
    showToast(t('Đang khởi chạy quét tất cả các Group Facebook...', 'Starting crawl for all Facebook Groups...'), 'info');
    await api('/api/fb-crawler/run-all?profile=' + encodeURIComponent(profile), {
      method: 'POST'
    });
    showToast(t('Đã bắt đầu chạy quét tất cả các Group Facebook!', 'Crawl started for all Facebook Groups!'), 'success');
  } catch (e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally {
    if (btn) setButtonLoading(btn, false);
  }
};

window.fbAddCronRow = function () {
  const id = document.getElementById('fbNewCronId')?.value.trim();
  const timeVal = document.getElementById('fbNewCronTime')?.value;
  const from = document.getElementById('fbNewCronSliceFrom')?.value;
  const to = document.getElementById('fbNewCronSliceTo')?.value;

  if (!id || !timeVal) {
    showToast(t('Cần nhập ID và Giờ chạy!', 'ID and Execution Time are required!'), 'warning'); return;
  }
  if (fbCronList.some(s => s.id === id)) {
    showToast(t('ID "', 'ID "') + id + t('" đã tồn tại!', '" already exists!'), 'warning'); return;
  }

  const [hourStr, minStr] = timeVal.split(':');
  const hour = parseInt(hourStr);
  const min = parseInt(minStr);
  const cron = `${min} ${hour} * * *`;

  fbCronList.push({
    id,
    cron,
    enabled: true,
    groupSlice: (from !== '' && to !== '') ? [Number(from), Number(to)] : null,
  });
  renderFbCronTable();

  ['fbNewCronId', 'fbNewCronTime', 'fbNewCronSliceFrom', 'fbNewCronSliceTo'].forEach(elId => {
    const el = document.getElementById(elId);
    if (el) el.value = '';
  });
};

window.fbDeleteCronRow = function (index) {
  fbCronList.splice(index, 1);
  renderFbCronTable();
};

window.fbSaveCron = async function () {
  const btn = document.getElementById('btnFbSaveCron');
  const profile = document.getElementById('fbProfileSelect') ? document.getElementById('fbProfileSelect').value : 'banxe';
  setButtonLoading(btn, true);
  try {
    const data = await api('/api/fb-crawler/save-cron?profile=' + encodeURIComponent(profile), {
      method: 'POST',
      body: JSON.stringify({ cronSchedule: fbCronList }),
    });
    showToast(t('Đã lưu ', 'Saved ') + data.count + t(' lịch cron thành công!', ' cron schedules successfully!'), 'success');
    await loadFbCrawlerState();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
};

window.fbAiSuggestCron = async function () {
  const btn = document.getElementById('btnFbAiCron');
  const profile = document.getElementById('fbProfileSelect') ? document.getElementById('fbProfileSelect').value : 'banxe';
  setButtonLoading(btn, true);
  try {
    showToast(t('Đang nhờ AI phân bổ lịch quét tối ưu...', 'Asking AI to optimize crawl schedules...'), 'info');
    const data = await api('/api/fb-crawler/ai-suggest-cron?profile=' + encodeURIComponent(profile), {
      method: 'POST',
      body: JSON.stringify({ groups: fbGroupsList }),
    });
    const suggestions = data.suggestions || [];
    if (!suggestions.length) {
      showToast(t('Không có group nào để phân bổ. Thêm group trước!', 'No groups to distribute. Add groups first!'), 'warning');
      return;
    }

    // Show modal with preview
    const preview = suggestions.map(s => {
      const slice = Array.isArray(s.groupSlice) ? `${t('Nhóm', 'Group')} ${s.groupSlice[0] + 1}→${s.groupSlice[1]}` : t('Tất cả', 'All');
      return `<tr>
        <td><code style="background:var(--bg-hover);padding:2px 6px;border-radius:4px;font-weight:700;">${esc(s.id)}</code></td>
        <td><code style="font-size:12px;">${esc(s.cron)}</code></td>
        <td style="font-size:12px;">${esc(slice)}</td>
        <td style="font-size:11px;color:var(--text-muted);">${esc(s.reason || '')}</td>
      </tr>`;
    }).join('');

    const body = `
      <div style="margin-bottom:12px;font-size:13px;">${t('AI đã phân bổ', 'AI distributed')} <strong>${suggestions.length} ${t('sessions', 'sessions')}</strong> ${t('cho', 'for')} <strong>${data.groupCount} ${t('groups', 'groups')}</strong>.</div>
      <div class="table-wrap">
        <table style="font-size:13px;">
          <thead><tr><th>ID</th><th>Cron</th><th>Batch</th><th>${t('Ghi chú AI', 'AI Notes')}</th></tr></thead>
          <tbody>${preview}</tbody>
        </table>
      </div>
      <p style="margin-top:12px;font-size:12px;color:var(--text-muted);">t('Nhấn "Áp dụng" để thay thế lịch hiện tại bằng đề xuất này. Bạn có thể sửa lại sau khi áp dụng.', 'Click "Apply" to replace the current schedule with this recommendation. You can edit it after applying.')</p>`;

    const confirmed = await openModal({
      title: t('✨ AI Đề xuất lịch quét', '✨ AI Suggested Schedule'),
      desc: t(`Lịch được phân bổ thông minh: 3 lần/ngày, tránh giờ cao điểm, mỗi batch ${Math.ceil(data.groupCount / suggestions.length)} group.`, `Smart scheduling: 3 times/day, avoiding peak hours, each batch containing ${Math.ceil(data.groupCount / suggestions.length)} groups.`),
      body,
      confirmText: t('Áp dụng', 'Apply'),
      tone: 'info'
    });

    if (confirmed !== false) {
      fbCronList = suggestions.map(s => ({ ...s, enabled: true }));
      renderFbCronTable();
      showToast(t('Đã áp dụng lịch AI. Nhấn "Lưu lịch" để lưu vào config!', 'AI schedule applied. Click "Save Schedule" to save to config!'), 'success');
    }
  } catch (e) {
    showToast('Lỗi AI: ' + e.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
};

window.switchFbNotifySubTab = function(type) {
  const groupTab = document.getElementById('fbNotifySubTabGroup');
  const userTab = document.getElementById('fbNotifySubTabUser');
  const groupBtn = document.getElementById('fbNotifySubTabGroupBtn');
  const userBtn = document.getElementById('fbNotifySubTabUserBtn');
  
  if (type === 'group') {
    if (groupTab) groupTab.style.display = 'block';
    if (userTab) userTab.style.display = 'none';
    if (groupBtn) groupBtn.classList.add('active');
    if (userBtn) userBtn.classList.remove('active');
  } else {
    if (groupTab) groupTab.style.display = 'none';
    if (userTab) userTab.style.display = 'block';
    if (groupBtn) groupBtn.classList.remove('active');
    if (userBtn) userBtn.classList.add('active');
  }
};

// Pagination state for report notifications targets
let fbNotifyGroupPage = 1;
let fbNotifyUserPage = 1;
const fbNotifyPageSize = 10;

window.fbNotifyGroupPrevPage = function() {
  if (fbNotifyGroupPage > 1) {
    fbNotifyGroupPage--;
    renderFbNotifyGroupList();
  }
};

window.fbNotifyGroupNextPage = function() {
  const groups = (state && state.groups) ? state.groups : [];
  const totalPages = Math.ceil(groups.length / fbNotifyPageSize);
  if (fbNotifyGroupPage < totalPages) {
    fbNotifyGroupPage++;
    renderFbNotifyGroupList();
  }
};

window.fbNotifyUserPrevPage = function() {
  if (fbNotifyUserPage > 1) {
    fbNotifyUserPage--;
    renderFbNotifyUserList();
  }
};

window.fbNotifyUserNextPage = function() {
  const friends = cachedFriends || [];
  const totalPages = Math.ceil(friends.length / fbNotifyPageSize);
  if (fbNotifyUserPage < totalPages) {
    fbNotifyUserPage++;
    renderFbNotifyUserList();
  }
};

window.fbNotifyGroupSelectionChanged = function(chk) {
  if (!chk) return;
  const val = String(chk.value);
  if (chk.checked) {
    if (!fbNotifySelectedGroupIds.includes(val)) {
      fbNotifySelectedGroupIds.push(val);
    }
  } else {
    fbNotifySelectedGroupIds = fbNotifySelectedGroupIds.filter(id => id !== val);
  }
  
  // Update Select All Checkbox state
  const tbody = document.getElementById('fbNotifyGroupListTbody');
  if (tbody) {
    const chks = tbody.querySelectorAll('.fb-notify-group-chk');
    const allChecked = chks.length > 0 && Array.from(chks).every(c => c.checked);
    const selectAll = document.getElementById('fbNotifySelectAllGroups');
    if (selectAll) selectAll.checked = allChecked;
  }
};

window.fbNotifyUserSelectionChanged = function(chk) {
  if (!chk) return;
  const val = String(chk.value);
  if (chk.checked) {
    if (!fbNotifySelectedDmUserIds.includes(val)) {
      fbNotifySelectedDmUserIds.push(val);
    }
  } else {
    fbNotifySelectedDmUserIds = fbNotifySelectedDmUserIds.filter(id => id !== val);
  }
  
  // Update Select All Checkbox state
  const tbody = document.getElementById('fbNotifyUserListTbody');
  if (tbody) {
    const chks = tbody.querySelectorAll('.fb-notify-user-chk');
    const allChecked = chks.length > 0 && Array.from(chks).every(c => c.checked);
    const selectAll = document.getElementById('fbNotifySelectAllUsers');
    if (selectAll) selectAll.checked = allChecked;
  }
};

window.fbToggleSelectAllNotifyGroups = function(master) {
  const tbody = document.getElementById('fbNotifyGroupListTbody');
  if (!tbody) return;
  const chks = tbody.querySelectorAll('.fb-notify-group-chk');
  chks.forEach(chk => {
    chk.checked = master.checked;
    const val = String(chk.value);
    if (master.checked) {
      if (!fbNotifySelectedGroupIds.includes(val)) {
        fbNotifySelectedGroupIds.push(val);
      }
    } else {
      fbNotifySelectedGroupIds = fbNotifySelectedGroupIds.filter(id => id !== val);
    }
  });
};

window.fbToggleSelectAllNotifyUsers = function(master) {
  const tbody = document.getElementById('fbNotifyUserListTbody');
  if (!tbody) return;
  const chks = tbody.querySelectorAll('.fb-notify-user-chk');
  chks.forEach(chk => {
    chk.checked = master.checked;
    const val = String(chk.value);
    if (master.checked) {
      if (!fbNotifySelectedDmUserIds.includes(val)) {
        fbNotifySelectedDmUserIds.push(val);
      }
    } else {
      fbNotifySelectedDmUserIds = fbNotifySelectedDmUserIds.filter(id => id !== val);
    }
  });
};

function renderFbNotifyGroupList() {
  const groups = (state && state.groups) ? state.groups : [];
  const tbody = document.getElementById('fbNotifyGroupListTbody');
  const pagin = document.getElementById('fbNotifyGroupPagination');
  if (!tbody) return;
  
  if (groups.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="util-empty-row">t('Chưa có thông tin nhóm.', 'No group info.')</td></tr>`;
    if (pagin) pagin.innerHTML = '';
    return;
  }
  
  const totalPages = Math.ceil(groups.length / fbNotifyPageSize) || 1;
  if (fbNotifyGroupPage > totalPages) fbNotifyGroupPage = totalPages;
  if (fbNotifyGroupPage < 1) fbNotifyGroupPage = 1;
  
  const start = (fbNotifyGroupPage - 1) * fbNotifyPageSize;
  const end = Math.min(start + fbNotifyPageSize, groups.length);
  const pageGroups = groups.slice(start, end);
  
  tbody.innerHTML = pageGroups.map(g => {
    const isChecked = fbNotifySelectedGroupIds.includes(String(g.groupId));
    const avatar = avatarMeta(g, g.name);
    const avatarHtml = avatar.src
      ? `<img src="${esc(avatar.src)}" alt="${esc(avatar.name)}" onerror="const p=this.parentElement; this.remove(); if(p)p.textContent='${esc(avatar.initials)}'">`
      : esc(avatar.initials);
      
    return `
      <tr>
        <td style="text-align: center; vertical-align: middle;">
          <input type="checkbox" class="fb-notify-group-chk" value="${esc(g.groupId)}" ${isChecked ? 'checked' : ''} onchange="fbNotifyGroupSelectionChanged(this)">
        </td>
        <td style="vertical-align: middle;">
          <div class="custom-select-avatar">${avatarHtml}</div>
        </td>
        <td style="font-weight: 500; vertical-align: middle;">${esc(repairText(g.name))}</td>
        <td style="text-align: right; color: var(--muted); vertical-align: middle;">${g.memberCount} ${t('thành viên', 'members')}</td>
      </tr>
    `;
  }).join('');
  
  // Render pagination controls
  if (pagin) {
    pagin.className = 'pagination-container';
    pagin.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--surface-2); border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; flex-wrap: wrap; gap: 12px;';
    pagin.innerHTML = `
      <div style="font-size: 13px; color: var(--text-muted);">
        ${t('Hiển thị', 'Showing')} <strong>${start + 1}</strong> - <strong>${end}</strong> ${t('trên', 'of')} <strong>${groups.length}</strong> ${t('nhóm', 'groups')}
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <button class="btn" type="button" onclick="fbNotifyGroupPrevPage()" ${fbNotifyGroupPage === 1 ? 'disabled' : ''} style="padding: 6px 12px; font-size: 13px; min-height: auto; border-radius: 8px;">
          ${t('Trước', 'Prev')}
        </button>
        <span style="font-size: 13px; font-weight: 600; color: var(--text); padding: 0 4px;">
          ${fbNotifyGroupPage} / ${totalPages}
        </span>
        <button class="btn" type="button" onclick="fbNotifyGroupNextPage()" ${fbNotifyGroupPage >= totalPages ? 'disabled' : ''} style="padding: 6px 12px; font-size: 13px; min-height: auto; border-radius: 8px;">
          ${t('Sau', 'Next')}
        </button>
      </div>
    `;
  }
  
  // Update Select All Groups checkbox for the current page
  const allChks = tbody.querySelectorAll('.fb-notify-group-chk');
  const allChecked = allChks.length > 0 && Array.from(allChks).every(chk => chk.checked);
  const selectAll = document.getElementById('fbNotifySelectAllGroups');
  if (selectAll) selectAll.checked = allChecked;
}

function renderFbNotifyUserList() {
  const friends = cachedFriends || [];
  const tbody = document.getElementById('fbNotifyUserListTbody');
  const pagin = document.getElementById('fbNotifyUserPagination');
  if (!tbody) return;
  
  if (friends.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="util-empty-row">t('Chưa có thông tin bạn bè hoặc đang tải.', 'No friend info or loading.')</td></tr>`;
    if (pagin) pagin.innerHTML = '';
    return;
  }
  
  const totalPages = Math.ceil(friends.length / fbNotifyPageSize) || 1;
  if (fbNotifyUserPage > totalPages) fbNotifyUserPage = totalPages;
  if (fbNotifyUserPage < 1) fbNotifyUserPage = 1;
  
  const start = (fbNotifyUserPage - 1) * fbNotifyPageSize;
  const end = Math.min(start + fbNotifyPageSize, friends.length);
  const pageFriends = friends.slice(start, end);
  
  tbody.innerHTML = pageFriends.map(f => {
    const isChecked = fbNotifySelectedDmUserIds.includes(String(f.userId));
    const avatar = avatarMeta(f, f.displayName);
    const avatarHtml = avatar.src
      ? `<img src="${esc(avatar.src)}" alt="${esc(avatar.name)}" onerror="const p=this.parentElement; this.remove(); if(p)p.textContent='${esc(avatar.initials)}'">`
      : esc(avatar.initials);
      
    return `
      <tr>
        <td style="text-align: center; vertical-align: middle;">
          <input type="checkbox" class="fb-notify-user-chk" value="${esc(f.userId)}" ${isChecked ? 'checked' : ''} onchange="fbNotifyUserSelectionChanged(this)">
        </td>
        <td style="vertical-align: middle;">
          <div class="custom-select-avatar">${avatarHtml}</div>
        </td>
        <td style="font-weight: 500; vertical-align: middle;">${esc(repairText(f.displayName || f.userId))}</td>
        <td style="text-align: right; font-family: monospace; color: var(--muted); vertical-align: middle;">${f.userId}</td>
      </tr>
    `;
  }).join('');
  
  // Render pagination controls
  if (pagin) {
    pagin.className = 'pagination-container';
    pagin.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--surface-2); border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; flex-wrap: wrap; gap: 12px;';
    pagin.innerHTML = `
      <div style="font-size: 13px; color: var(--text-muted);">
        ${t('Hiển thị', 'Showing')} <strong>${start + 1}</strong> - <strong>${end}</strong> ${t('trên', 'of')} <strong>${friends.length}</strong> ${t('bạn bè', 'friends')}
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <button class="btn" type="button" onclick="fbNotifyUserPrevPage()" ${fbNotifyUserPage === 1 ? 'disabled' : ''} style="padding: 6px 12px; font-size: 13px; min-height: auto; border-radius: 8px;">
          ${t('Trước', 'Prev')}
        </button>
        <span style="font-size: 13px; font-weight: 600; color: var(--text); padding: 0 4px;">
          ${fbNotifyUserPage} / ${totalPages}
        </span>
        <button class="btn" type="button" onclick="fbNotifyUserNextPage()" ${fbNotifyUserPage >= totalPages ? 'disabled' : ''} style="padding: 6px 12px; font-size: 13px; min-height: auto; border-radius: 8px;">
          ${t('Sau', 'Next')}
        </button>
      </div>
    `;
  }
  
  // Update Select All Users checkbox for the current page
  const allChks = tbody.querySelectorAll('.fb-notify-user-chk');
  const allChecked = allChks.length > 0 && Array.from(allChks).every(chk => chk.checked);
  const selectAll = document.getElementById('fbNotifySelectAllUsers');
  if (selectAll) selectAll.checked = allChecked;
}

function renderFbNotify(cfg) {
  const activeId = cfg.notifyConversationId ? String(cfg.notifyConversationId) : '';
  const ids = activeId.split(',').map(s => s.trim()).filter(Boolean);
  
  fbNotifySelectedGroupIds = ids.filter(id => id.startsWith('group:')).map(id => id.replace(/^group:/, ''));
  fbNotifySelectedDmUserIds = ids.filter(id => !id.startsWith('group:'));
  
  fbNotifyGroupPage = 1;
  fbNotifyUserPage = 1;
  
  renderFbNotifyGroupList();
  renderFbNotifyUserList();
}

window.fbSaveNotify = async function () {
  try {
    const groupParts = fbNotifySelectedGroupIds.map(gid => 'group:' + gid);
    const userParts = fbNotifySelectedDmUserIds;
    const combined = [...groupParts, ...userParts];
    
    if (combined.length === 0) {
      showToast(t('Vui lòng chọn ít nhất một nhóm hoặc cá nhân nhận báo cáo!', 'Please select at least one group or user to receive reports!'), 'warning');
      return;
    }
    
    const notifyConversationId = combined.join(',');
    const notifyIsGroup = fbNotifySelectedGroupIds.length > 0;
    const profile = document.getElementById('fbProfileSelect') ? document.getElementById('fbProfileSelect').value : 'banxe';
    
    await api('/api/fb-crawler/save-notify?profile=' + encodeURIComponent(profile), {
      method: 'POST',
      body: JSON.stringify({
        notifyConversationId,
        notifyIsGroup,
      }),
    });
    showToast(t('Đã lưu cấu hình thông báo!', 'Notification configuration saved!'), 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};


// ─── PANEL 4: Report Template ─────────────────────────────────────────────────
function renderFbTemplate(tmpl) {
  const ta = document.getElementById('fbReportTemplate');
  if (ta) ta.value = tmpl;
}

window.fbInsertVar = function (varStr) {
  const ta = document.getElementById('fbReportTemplate');
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = ta.value;
  ta.value = text.slice(0, start) + varStr + text.slice(end);
  ta.selectionStart = ta.selectionEnd = start + varStr.length;
  ta.focus();
};

window.fbResetTemplate = async function () {
  const confirmed = await openModal({
    title: t('Reset template về mặc định', 'Reset Template to Default'),
    desc: t('Toàn bộ chỉnh sửa template sẽ bị xoá và khôi phục về mặc định của plugin.', 'All template edits will be cleared and restored to the plugin default.'),
    confirmText: t('Reset', 'Reset'),
    danger: true,
    tone: 'warning'
  });
  if (confirmed !== false) {
    const ta = document.getElementById('fbReportTemplate');
    if (ta && fbState?.defaultTemplate) ta.value = fbState.defaultTemplate;
    showToast(t('Đã reset về template mặc định. Nhấn "Lưu template" để áp dụng!', 'Restored to default template. Click "Save Template" to apply!'), 'info');
  }
};

window.fbSaveTemplate = async function () {
  const btn = document.getElementById('btnFbSaveTemplate');
  const tmpl = document.getElementById('fbReportTemplate')?.value || '';
  if (!tmpl.trim()) {
    showToast(t('Template không được để trống!', 'Template cannot be empty!'), 'warning'); return;
  }
  const profile = document.getElementById('fbProfileSelect') ? document.getElementById('fbProfileSelect').value : 'banxe';
  setButtonLoading(btn, true);
  try {
    await api('/api/fb-crawler/save-template?profile=' + encodeURIComponent(profile), {
      method: 'POST',
      body: JSON.stringify({ template: tmpl }),
    });
    showToast(t('Đã lưu template báo cáo! Lần quét tiếp theo sẽ dùng template mới.', 'Report template saved! The next crawl will use the new template.'), 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
};

window.fbPreviewTemplate = function () {
  const tmpl = document.getElementById('fbReportTemplate')?.value || '';
  const sampleItems = `"🏍️ *Yamaha NVX 155 2022*\\n👤 uid: 1234567890\\n📍 " + t('Khu vực', 'Region') + ": hcm\\n• PHONE: 0901234567\\n📝 " + t('Bán xe NVX 155 2022 chính chủ, màu xanh...', 'Selling Yamaha NVX 155 2022, owner, blue...') + "\\n🔗 https://www.facebook.com/groups/.../posts/sample1"`;
  const preview = tmpl
    .replace('{sessionId}', 'A')
    .replace('{totalFound}', '3')
    .replace('{skippedPro}', '12')
    .replace('{skippedLoc}', '5')
    .replace('{items}', sampleItems);

  const previewModal = document.getElementById('previewModalBackdrop');
  const previewBody = document.getElementById('previewModalBody');
  const previewClose = document.getElementById('previewModalClose');
  if (previewModal && previewBody) {
    previewBody.textContent = preview;
    previewModal.classList.add('open');
    if (previewClose) previewClose.onclick = () => previewModal.classList.remove('open');
  } else {
    openModal({
      title: t('👁️ Preview template', '👁️ Preview Template'),
      desc: t('Xem trước báo cáo với dữ liệu mẫu', 'Preview report with sample data'),
      body: `<pre style="white-space:pre-wrap;font-size:13px;line-height:1.6;font-family:inherit;background:var(--surface-2);padding:14px;border-radius:8px;border:1px solid var(--line);">${esc(preview)}</pre>`,
      confirmText: t('Đóng', 'Close'),
    });
  }
};

// ─── Auto-load when utilities section is activated ────────────────────────────
navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if ((btn.dataset.section === 'utilities' || btn.dataset.section === 'fb-crawler') && !fbState) {
      loadFbCrawlerState();
    }
  });
});

// ─── FACEBOOK COOKIES MANAGERS ──────────────────────────────────────────────
window.fbHandleCookieUpload = function (event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const json = JSON.parse(e.target.result);
      const ta = document.getElementById('fbCookiesTextarea');
      if (ta) {
        ta.value = JSON.stringify(json, null, 2);
      }
      showToast(t('Đã nạp nội dung file Cookie JSON!', 'Loaded Cookie JSON file contents!'), 'info');
    } catch (err) {
      showToast(t('File JSON không hợp lệ!', 'Invalid JSON file!'), 'error');
    }
  };
  reader.readAsText(file);
};

window.fbSaveCookies = async function () {
  const btn = document.getElementById('btnFbSaveCookies');
  const ta = document.getElementById('fbCookiesTextarea');
  if (!ta) return;
  const val = ta.value.trim();
  if (!val) {
    showToast(t('Vui lòng chọn file JSON hoặc dán cookies vào ô nhập!', 'Please choose a JSON file or paste cookies into the input!'), 'warning');
    return;
  }
  let cookiesObj;
  try {
    cookiesObj = JSON.parse(val);
  } catch (e) {
    showToast(t('Cookies không phải JSON hợp lệ!', 'Cookies are not valid JSON!'), 'error');
    return;
  }

  setButtonLoading(btn, true);
  try {
    const res = await api('/api/fb-crawler/save-cookies', {
      method: 'POST',
      body: JSON.stringify({ cookies: cookiesObj })
    });
    showToast(t('Đã lưu và áp dụng ', 'Successfully saved and applied ') + res.count + t(' cookies thành công!', ' cookies!'), 'success');
    await loadFbCrawlerState();
  } catch (e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
};

window.fbClearCookies = async function () {
  const confirmed = await openModal({
    title: t('Xóa Cookies Facebook', 'Delete Facebook Cookies'),
    desc: t('Bạn có chắc chắn muốn xóa cookies Facebook hiện tại? Trình duyệt sẽ quay lại trạng thái ẩn danh không đăng nhập.', 'Are you sure you want to delete current Facebook cookies? The browser will return to incognito mode without logging in.'),
    confirmText: t('Xóa', 'Delete'),
    tone: 'danger',
    danger: true
  });
  if (confirmed === false) return;

  const btn = document.getElementById('btnFbClearCookies');
  if (btn) setButtonLoading(btn, true);
  try {
    await api('/api/fb-crawler/save-cookies', {
      method: 'POST',
      body: JSON.stringify({ cookies: [] })
    });
    showToast(t('Đã xóa cookies thành công!', 'Deleted cookies successfully!'), 'success');
    const ta = document.getElementById('fbCookiesTextarea');
    if (ta) ta.value = '';
    await loadFbCrawlerState();
  } catch (e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally {
    if (btn) setButtonLoading(btn, false);
  }
};

// ─── Tab Switcher ───
window.switchUtilTab = function (event, tabId) {
  if (event) event.preventDefault();
  const tabIds = ['fbTabTargets', 'fbTabFilters', 'fbTabCron', 'fbTabNotify', 'fbTabTemplate', 'fbTabCookies'];
  tabIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const targetEl = document.getElementById(tabId);
  if (targetEl) targetEl.style.display = 'block';
  const buttons = document.querySelectorAll('#fb-crawler .util-tab-btn');
  buttons.forEach(btn => btn.classList.remove('active'));
  if (event && event.currentTarget) {
    event.currentTarget.classList.add('active');
  } else if (event && event.target) {
    event.target.classList.add('active');
  }
};
// ═══════════════════════════════════════════════════════════════════════════
// END FB CRAWLER MANAGER MODULE
