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
    const pluginVersion = '2.9.3';
    let state = null;
    let activeGroupId = '';
    let lang = localStorage.getItem('zaloDashboardLang') || 'vi';
    let modalResolve = null;
    let activeActionButton = null;
    const selectedGroups = new Set();
    const selectedMembers = new Set();
    let currentGroupFilter = 'all';
    let currentMemberFilter = 'all';
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
    } catch (e) {}
    const fetchedPendingMembers = {};
    const fetchedBlockedMembers = {};
    let currentDetailGroupId = '';
    let currentDetailPayload = null;
    document.documentElement.dataset.theme = localStorage.getItem('zaloDashboardTheme') || 'light';
    window.toggleLicenseVisibility = function() {
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
    window.toggleUpgradeVisibility = function() {
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
    window.toggleKeyVisibility = function() {
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
    window.showInlineUpgradeInput = function() {
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
    window.hideInlineUpgradeInput = function() {
      const upgradeRow = document.getElementById('licenseUpgradeRow');
      if (upgradeRow) {
        upgradeRow.style.display = 'none';
      }
    };
    window.handleUpgradeLicense = async function() {
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
      document.querySelectorAll('[data-theme-choice]').forEach(button => {
        button.classList.toggle('active', button.dataset.themeChoice === (dark ? 'dark' : 'light'));
      });
      langToggle?.setAttribute('aria-pressed', String(lang === 'en'));
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
      setText('[data-theme-choice="light"]', 'Light', 'Light');
      setText('[data-theme-choice="dark"]', 'Dark', 'Dark');
      setText('.brand h1', 'Zalo Owner', 'Zalo Owner');
      setText('.brand p', 'Quản trị Bot Zalo', 'Zalo Bot Management');
      setAllText('[data-nav] button > span.nav-label', [
        ['Tổng quan', 'Overview'],
        ['Nhóm', 'Groups'],
        ['Thành viên', 'Members'],
        ['Bạn bè', 'Friends'],
        ['Tin nhắn', 'Messages'],
        ['Danh mục API', 'API Directory'],
        ['Nâng cấp', 'Upgrade'],
        ['Khu nguy hiểm', 'Danger Zone'],
      ]);
      setAllText('[data-drawer-nav] button > span.nav-label', [
        ['Tổng quan', 'Overview'],
        ['Nhóm', 'Groups'],
        ['Thành viên', 'Members'],
        ['Bạn bè', 'Friends'],
        ['Tin nhắn', 'Messages'],
        ['Danh mục API', 'API Directory'],
        ['Nâng cấp', 'Upgrade'],
        ['Khu nguy hiểm', 'Danger Zone'],
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
      setAllText('#groups .segmented button', [['All', 'All'], ['Silent', 'Silent'], ['Welcome', 'Welcome'], ['Muted', 'Muted'], ['Spam watch', 'Spam watch']]);
      setAllText('#groups thead th', [['Group', 'Group'], ['Member', 'Member'], ['Tính năng', 'Features'], ['Thao tác', 'Actions']]);
      setText('#members .page-head h2', 'Thành viên & Pending', 'Members & Pending');
      setText('#members .page-head p', 'Duyệt member mới, xem member list, block hoặc xóa member với confirmation rõ ràng.', 'Review new members, inspect member lists, block, or remove members with clear confirmation.');
      setAllText('#members .segmented button', [['All members', 'All members'], ['Pending', 'Pending'], ['Blocked', 'Blocked'], ['Admins', 'Admins']]);
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
          .catch(() => {});
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
                <span class="status-badge active" style="display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; background: rgba(0, 168, 255, 0.1); color: var(--primary); text-transform: uppercase; margin-top: 4px;">${planName} (${t('Hạn: ', 'Exp: ') + lic.expiry})</span>
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

      window.copyPaymentField = function(elementId, toastMsg) {
        const txt = document.getElementById(elementId)?.textContent || '';
        navigator.clipboard.writeText(txt);
        showToast(toastMsg, 'success');
      };

      window.changePaymentPlan = async function(planId) {
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
      renderGroups();
      renderMembers();
      renderAudit();
      updateBulkBar();
      renderLicense();
      renderComposerTargets();
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
    function groupRows(limit) {
      return state.groups.slice(0, limit || state.groups.length).map(group => `
        <tr>
          <td data-label="${esc(t('Group', 'Group'))}"><strong>${esc(repairText(group.name))}</strong><small>${esc(group.groupId)}</small></td>
          <td data-label="${esc(t('Thành viên', 'Members'))}">${group.memberCount}</td>
          <td data-label="${esc(t('Cảnh báo', 'Violations'))}"><span class="status ${group.violationCount ? 'warn' : 'off'}">${group.violationCount} ${t('vi phạm', 'violations')}</span></td>
          <td data-label="${esc(t('Mode', 'Mode'))}">${status(group.settings.silent, 'Silent', 'Normal')} ${status(group.settings.welcome, 'Welcome', t('\u004b\u0068\u00f4\u006e\u0067 welcome', 'No welcome'))}</td>
          <td data-label="${esc(t('\u0048\u00e0\u006e\u0068 \u0111\u1ed9\u006e\u0067', 'Action'))}"><button class="btn" data-open-members="${esc(group.groupId)}"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; margin-right: 4px; vertical-align: middle;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>${t('Thành viên', 'Members')}</button></td>
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
          <td data-label="${esc(t('Group', 'Group'))}">
            <div class="group-title-line">
              <input class="group-select" type="checkbox" data-select-group="${esc(group.groupId)}" ${selectedGroups.has(group.groupId) ? 'checked' : ''} aria-label="Select group">
              <div class="group-meta">
                <button class="group-link-button" type="button" data-group-detail="${esc(group.groupId)}">${esc(repairText(group.name))}</button>
                <small>${esc(group.groupId)}</small>
              </div>
            </div>
          </td>
          <td data-label="${esc(uiText('Duyệt member', 'Approval'))}">${approvalHtml(group)}</td>
          <td data-label="${esc(uiText('Tính năng', 'Features'))}">
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
          <td data-label="${esc(uiText('Thao tác', 'Actions'))}">
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
        const groups = state.groups || [];
        if (!activeGroupId && groups.length > 0) {
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
                <span class="custom-select-name">${esc(repairText(g.name))}</span>
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
            document.getElementById('selectedGroupName').textContent = repairText(activeGroup.name);
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
              <td style="padding: 10px 16px; vertical-align: middle; text-align: center;">
                <input type="checkbox" data-member-select="${esc(key)}" ${isSelected ? 'checked' : ''} style="cursor: pointer; width: 15px; height: 15px; vertical-align: middle;">
              </td>
              ${membersTableColumns.avatar ? `
                <td style="padding: 10px 16px; vertical-align: middle; text-align: center;">
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
                <td style="padding: 10px 16px; vertical-align: middle; text-align: left;">
                  <strong style="color: var(--text); font-size: 13.5px; display: block;">${esc(repairText(displayName))}</strong>
                  <span style="font-family: monospace; font-size: 11px; color: var(--text-muted); display: block; margin-top: 2px;">ID: ${esc(m.userId)} · <span class="role-badge" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; background: ${m.role === 'Owner' ? 'rgba(235, 94, 40, 0.1)' : m.role === 'Admin' ? 'rgba(58, 125, 68, 0.1)' : 'rgba(0, 0, 0, 0.05)'}; color: ${m.role === 'Owner' ? '#eb5e28' : m.role === 'Admin' ? '#3a7d44' : 'var(--text-muted)'};">${m.role}</span></span>
                </td>
              ` : ''}
              ${membersTableColumns.birth ? `
                <td style="padding: 10px 16px; vertical-align: middle; text-align: center; color: var(--text); font-weight: 500;">
                  ${dob ? `🎂 ${esc(dob)}` : `<span style="color: var(--text-muted); font-size: 12px;">--</span>`}
                </td>
              ` : ''}
              ${membersTableColumns.phone ? `
                <td style="padding: 10px 16px; vertical-align: middle; text-align: center; color: var(--text); font-weight: 500;">
                  ${phone ? `📞 ${esc(phone)}` : `<span style="color: var(--text-muted); font-size: 12px;">--</span>`}
                </td>
              ` : ''}
              ${membersTableColumns.actions ? `
                <td style="padding: 10px 16px; vertical-align: middle; text-align: center; white-space: nowrap; width: 320px;">
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
        try { detail = await runAction('group-detail', { groupId }, 'Group detail loaded'); } catch (_) {}
        if (!detail) {
          let pendingResult = null;
          try { pendingResult = await runAction('get-pending', { groupId }, 'Pending members loaded'); } catch (_) {}
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
        if (action === 'sync') await runAction('sync-groups', {}, t('Đã sync group từ ZCA', 'Synced groups from ZCA'));
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
      });
      document.addEventListener('click', () => {
        selectContainer.classList.remove('open');
      });
    }

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
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.addEventListener('click', () => {
        const next = button.dataset.themeChoice || 'light';
        if (document.documentElement.dataset.theme === next) return;
        document.documentElement.dataset.theme = next;
        localStorage.setItem('zaloDashboardTheme', next);
        syncChromeState();
        showToast(next === 'dark' ? t('\u0110\u00e3 b\u1eadt dark mode', 'Dark mode enabled') : t('\u0110\u00e3 chuy\u1ec3n sang light mode', 'Light mode enabled'), 'success');
      });
    });
    document.getElementById('langToggle').addEventListener('click', () => {
      lang = lang === 'vi' ? 'en' : 'vi';
      localStorage.setItem('zaloDashboardLang', lang);
      applyI18n();
      if (state) renderState();
      showToast(lang === 'vi' ? '\u004e\u0067\u00f4\u006e ng\u1eef: Ti\u1ebfng Vi\u1ec7t' : 'Language: English', 'info');
    });
    applyI18n();
    loadState().catch(error => showToast(error.message, 'error'));