/**
 * openclaw-zalo-mod — Zero-Token Zalo Group Moderation Plugin
 * ─────────────────────────────────────────────────────────────
 * Hook vào before_dispatch của zalouser channel.
 * Xử lý slash commands + anti-spam tức thì, 0 token.
 * @mention → để lọt lên LLM agent bình thường.
 * Tin thường → block hoàn toàn (silent).
 *
 * v2.1.0: Watcher optimization — skip poll for welcome-off groups.
 *   Groups with welcome disabled are completely skipped during polling,
 *   saving Zalo API calls. Welcome setting check moved before API call.
 *
 * v1.2.0: Polling-based member watcher + /groupid command.
 *   OpenClaw zalouser channel does NOT expose system events (join/leave)
 *   to plugins. Workaround: poll group member list via OpenClaw internal
 *   listZaloGroupMembers API, diff with previous snapshot.
 *
 * @author tuanminhhole
 * @version 2.5.0
 */

import fs from 'node:fs/promises';
import { chmodSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

// ── Plugin directory (for data storage) ──────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Auto-config helpers ──────────────────────────────────────
// Resolve OPENCLAW_HOME from plugin install path:
//   ClawHub/CLI install: {HOME}/extensions/zalo-mod/       → 2 up → .openclaw/ ✅
//   Legacy NPM:          {HOME}/npm/node_modules/.../      → 3 up → .openclaw/ ✅
let _openclawHome = path.resolve(__dirname, '..', '..');
const _homeBasename = path.basename(_openclawHome);
if (_homeBasename === 'npm' || _homeBasename === 'node_modules') {
  // Legacy: inside npm/node_modules — step up through npm/ too
  _openclawHome = path.resolve(_openclawHome, '..');
  if (path.basename(_openclawHome) === 'npm') {
    _openclawHome = path.resolve(_openclawHome, '..');
  }
}

/**
 * Read bot name from IDENTITY.md in workspace dir.
 * Parses `**Tên:** BotName` pattern.
 */
async function _readBotNameFromIdentity(workspaceDir) {
  try {
    const identityPath = path.join(workspaceDir, 'IDENTITY.md');
    const content = await fs.readFile(identityPath, 'utf8');
    const match = content.match(/\*\*Tên:\*\*\s*(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

/**
 * Scan sessions.json for group sessions.
 * Returns array of { groupId, groupName } from session keys like:
 *   "agent:{agentId}:zalouser:group:{groupId}" with origin.label = groupName
 */
async function _scanGroupsFromSessions(openclawHome, agentId) {
  const groups = [];
  // Try multiple possible agent IDs
  const agentIds = agentId ? [agentId] : [];
  // Also scan agents/ dir for any agent
  try {
    const agentsDir = path.join(openclawHome, 'agents');
    const entries = await fs.readdir(agentsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !agentIds.includes(e.name)) agentIds.push(e.name);
    }
  } catch { /* no agents dir */ }

  for (const aid of agentIds) {
    const sessPath = path.join(openclawHome, 'agents', aid, 'sessions', 'sessions.json');
    try {
      const raw = await fs.readFile(sessPath, 'utf8');
      const sessions = JSON.parse(raw);
      for (const [key, val] of Object.entries(sessions)) {
        const m = key.match(/:zalouser:group:(\d+)$/);
        if (m && val.origin?.label) {
          const gId = m[1];
          if (!groups.some(g => g.groupId === gId)) {
            groups.push({ groupId: gId, groupName: String(val.origin.label) });
          }
        }
      }
    } catch { /* no sessions file for this agent */ }
  }
  return groups;
}

/**
 * Auto-patch openclaw.json — merge discovered config into plugins.entries.zalo-mod.config.
 * Only sets values that are currently empty/default.
 * Returns true if file was modified.
 */
async function _patchOpenclawConfig(openclawHome, patch, logger, force = false) {
  const configPath = path.join(openclawHome, 'openclaw.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw);
    config.plugins = config.plugins || {};
    config.plugins.entries = config.plugins.entries || {};
    let changed = false;

    const legacyEntry = config.plugins.entries[PACKAGE_ID];
    if (legacyEntry) {
      const currentEntry = config.plugins.entries[PLUGIN_ID] || { enabled: true };
      currentEntry.enabled = currentEntry.enabled !== false;
      currentEntry.config = { ...(legacyEntry.config || {}), ...(currentEntry.config || {}) };
      config.plugins.entries[PLUGIN_ID] = currentEntry;
      delete config.plugins.entries[PACKAGE_ID];
      changed = true;
    }

    if (Array.isArray(config.plugins.allow) && config.plugins.allow.includes(PACKAGE_ID)) {
      config.plugins.allow = config.plugins.allow.filter((id) => id !== PACKAGE_ID);
      if (!config.plugins.allow.includes(PLUGIN_ID)) config.plugins.allow.push(PLUGIN_ID);
      changed = true;
    }

    config.plugins.entries[PLUGIN_ID] = config.plugins.entries[PLUGIN_ID] || { enabled: true };
    const existing = config.plugins.entries[PLUGIN_ID].config || {};

    for (const [key, val] of Object.entries(patch)) {
      if (val == null) continue;
      const cur = existing[key];
      const isEmpty = cur == null || cur === '' || (Array.isArray(cur) && cur.length === 0);
      if (force || isEmpty) {
        existing[key] = val;
        changed = true;
      }
    }

    // Auto-provision bindings: ensure zalouser channel is bound to an agent
    const agentId = config.agents?.list?.[0]?.id;
    if (agentId && !Array.isArray(config.bindings)) {
      config.bindings = [{ agentId, match: { channel: 'zalouser' } }];
      changed = true;
      if (logger) logger.info(`[openclaw-zalo-mod] auto-added binding: zalouser → ${agentId}`);
    } else if (agentId && Array.isArray(config.bindings)) {
      const hasZalo = config.bindings.some(b => b.match?.channel === 'zalouser');
      if (!hasZalo) {
        config.bindings.push({ agentId, match: { channel: 'zalouser' } });
        changed = true;
        if (logger) logger.info(`[openclaw-zalo-mod] auto-added binding: zalouser → ${agentId}`);
      }
    }

    // Auto-provision groups config: enable all groups with no mention required
    if (config.channels?.zalouser && !config.channels.zalouser.groups) {
      config.channels.zalouser.groups = { '*': { enabled: true, requireMention: false } };
      changed = true;
      if (logger) logger.info(`[openclaw-zalo-mod] auto-added groups config: all groups enabled`);
    }

    if (changed) {
      config.plugins.entries[PLUGIN_ID].config = existing;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
      if (logger) logger.info(`[openclaw-zalo-mod] auto-patched openclaw.json config`);
    }
    return changed;
  } catch (e) {
    if (logger) logger.warn(`[openclaw-zalo-mod] auto-patch config failed: ${e.message}`);
    return false;
  }
}

// ── Constants ────────────────────────────────────────────────
const PLUGIN_ID = 'zalo-mod';
const PACKAGE_ID = 'openclaw-zalo-mod';

const SPAM_LINK_RE = /bit\.ly\/|tinyurl\.com\/|t\.ly\/|rb\.gy\/|cutt\.ly\/|\?ref=|\?aff=|kiếm tiền|miễn phí|nhận quà|t\.me\/joinchat\//i;
const EMOJI_FLOOD_RE = /^[\u{1F300}-\u{1FAFF}\s]{5,}$/u;

// ── Helpers ──────────────────────────────────────────────────
function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

async function safeReadJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function safeWriteJson(filePath, data) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    // best effort
  }
}

function nowIso() {
  return new Date().toISOString();
}

// ── Store ────────────────────────────────────────────────────
function createStore(dataDir) {
  const violationsPath = path.join(dataDir, 'violations.json');
  const warnedPath = path.join(dataDir, 'warned.json');
  const settingsPath = path.join(dataDir, 'settings.json');

  let violations = {};
  let warned = {};
  let settings = {};

  return {
    async load() {
      violations = (await safeReadJson(violationsPath)) || {};
      warned = (await safeReadJson(warnedPath)) || {};
      settings = (await safeReadJson(settingsPath)) || {};
    },
    async saveViolations() { await safeWriteJson(violationsPath, violations); },
    async saveWarned()     { await safeWriteJson(warnedPath, warned); },
    async saveSettings()   { await safeWriteJson(settingsPath, settings); },

    // Violations
    addViolation(groupId, userId, userName, type, preview) {
      const g = String(groupId);
      const u = String(userId);
      violations[g] = violations[g] || {};
      violations[g][u] = violations[g][u] || [];
      violations[g][u].push({ type, preview: String(preview || '').slice(0, 60), name: userName, ts: nowIso() });
    },
    getViolations(groupId) {
      return violations[String(groupId)] || {};
    },

    // Warned
    addWarn(groupId, userId, userName, reason) {
      const g = String(groupId);
      const u = String(userId);
      warned[g] = warned[g] || {};
      warned[g][u] = warned[g][u] || [];
      warned[g][u].push({ reason, name: userName, ts: nowIso() });
    },
    getWarned(groupId) {
      return warned[String(groupId)] || {};
    },
    getWarnCount(groupId, userId) {
      return (warned[String(groupId)]?.[String(userId)] || []).length;
    },
    getAllWarned() { return warned; },
    getAllViolations() { return violations; },

    // Settings
    getSetting(groupId, key, def) {
      return settings[String(groupId)]?.[key] ?? def;
    },
    setSetting(groupId, key, value) {
      const g = String(groupId);
      settings[g] = settings[g] || {};
      settings[g][key] = value;
    },
  };
}

// ── Spam Tracker ─────────────────────────────────────────────
function createSpamTracker(repeatN, windowMs) {
  const cache = new Map();

  return {
    check(userId, msg) {
      const now = Date.now();
      const key = String(userId);
      const history = (cache.get(key) || []).filter((e) => now - e.ts < windowMs);
      history.push({ msg: String(msg || '').trim(), ts: now });
      cache.set(key, history);

      const same = history.filter((e) => e.msg === String(msg).trim());
      if (same.length >= repeatN) return 'repeat';
      if (EMOJI_FLOOD_RE.test(String(msg))) return 'emoji_flood';
      if (SPAM_LINK_RE.test(String(msg))) return 'spam_link';
      return null;
    },
  };
}

// ── Template Builders ────────────────────────────────────────
function buildNoiQuy(groupName, botName, cmdPrefix) {
  return `📋 NỘI QUY — ${groupName}
━━━━━━━━━━━━━━━━━━

1️⃣ Hỏi thoải mái - ai cũng từng là người mới
2️⃣ Biết gì chia sẻ nấy - văn hoá cho đi là nhận lại
3️⃣ Tôn trọng nhau - không toxic, không chê trình độ gây war
4️⃣ Không spam - quảng cáo
5️⃣ Tôn trọng thời gian — nói rõ vấn đề

⚠️ Mức xử lý:
• Lần 1: Nhắc
• Lần 2: Warn
• Lần 3: Kick

📌 Hỏi thêm: @${botName} [câu hỏi]`;
}

function buildMenu(botName, cmdPrefix) {
  return `🤖 ${botName.toUpperCase()} — MENU LỆNH
━━━━━━━━━━━━━━━━━━

📋 Thông tin
  ${cmdPrefix}noi-quy   — Xem nội quy nhóm
  ${cmdPrefix}menu   — Menu lệnh này
  ${cmdPrefix}huong-dan    — Hướng dẫn dùng bot


💬 Hỏi đáp
  @${botName} [câu hỏi] — Hỏi bot bất kỳ điều gì

🔧 Admin (chỉ admin dùng được)
  ${cmdPrefix}mute                    — Tắt bot hoàn toàn
  ${cmdPrefix}unmute                  — Bật lại bot
  ${cmdPrefix}warn @name [lý do]  — Cảnh cáo member
  ${cmdPrefix}note [text]           — Ghi chú admin
  ${cmdPrefix}report                  — Báo cáo vi phạm
  ${cmdPrefix}memory                  — Lưu memory digest

👑 Owner (chỉ chủ bot)
  ${cmdPrefix}rules                 — Cấu hình bot

━━━━━━━━━━━━━━━━━━
💡 Tip: Tag @${botName} để hỏi thêm!`;
}

function buildHuongDan(botName, cmdPrefix) {
  return `📖 HƯỚNG DẪN SỬ DỤNG BOT ${botName.toUpperCase()}
━━━━━━━━━━━━━━━━━━

👋 ${botName} là trợ lý AI của nhóm này.

🗣️ Cách giao tiếp:
  • Tag trực tiếp: @${botName} [câu hỏi bất kỳ]
  • Gõ lệnh: /[tên lệnh]

📌 Ví dụ:
  @${botName} giải thích quy trình XYZ
  ${cmdPrefix}noi-quy → xem nội quy
  ${cmdPrefix}menu → xem tất cả lệnh

⚠️ Lưu ý:
  • Bot KHÔNG tự reply tin thường — cần @tag hoặc gõ lệnh
  • Lệnh admin: ${cmdPrefix}report và ${cmdPrefix}warn (chỉ admin dùng được)

━━━━━━━━━━━━━━━━━━
❓ Cần hỗ trợ thêm → @${botName}`;
}

function buildReport(groupId, allViolations, allWarned) {
  const lines = [`📊 BÁO CÁO GROUP`, `🕐 ${nowIso().slice(0, 16).replace('T', ' ')}`];

  // Filter violations for this group
  let hasVio = false;
  for (const [uid, list] of Object.entries(allViolations)) {
    if (!list.length || uid === 'admin-note') continue; // skip admin notes
    if (!hasVio) { lines.push('\n📌 Vi phạm ghi nhận:'); hasVio = true; }
    const last = list[list.length - 1];
    lines.push(`  - ${(last.name || uid).replace(/^@/, '')}: ${last.type}, ${list.length} lần, lần cuối ${last.ts.slice(0, 10)}`);
  }
  if (!hasVio) lines.push('\n✅ Không có vi phạm mới');

  // Filter warns for this group
  let hasWarn = false;
  for (const [uid, list] of Object.entries(allWarned)) {
    if (!list.length) continue;
    if (!hasWarn) { lines.push('\n⚠️ Đã warn:'); hasWarn = true; }
    const last = list[list.length - 1];
    lines.push(`  - ${(last.name || uid).replace(/^@/, '')}: ${list.length} lần`);
  }
  // Show admin notes if any
  const noteList = allViolations['admin-note'];
  if (noteList && noteList.length) {
    lines.push('\n📝 Admin notes:');
    for (const n of noteList) {
      lines.push(`  - ${(n.ts || '').slice(0, 16).replace('T', ' ')}: ${n.preview || '—'}`);
    }
  }

  return lines.join('\n');
}

function buildWelcome(memberName,  botName, cmdPrefix) {
  return `👋 Chào mừng ${memberName} vào nhóm!
📋 ${cmdPrefix}noi-quy để xem nội quy
📖 ${cmdPrefix}menu để xem lệnh
💬 @${botName} nếu cần hỏi bot`;
}


// ── isMention ────────────────────────────────────────────────
function isMessageMentioningBot(event, botNames) {
  // IMPORTANT: Zalo strips @mention from event.content, use event.body
  const content = String(event.body || event.content || '').toLowerCase();

  // Check all known bot names/aliases
  for (const raw of botNames) {
    const name = String(raw || '').toLowerCase().trim();
    if (!name) continue;
    const folded = foldText(name);
    if (content.includes(`@${name}`) || content.includes(`@${folded}`)) return true;
  }
  // OpenClaw native mention flag
  if (event.wasMentioned === true) return true;
  // Zalo mention metadata (if available)
  if (Array.isArray(event.mentions) && event.mentions.length > 0) return true;
  return false;
}

// ── Plugin Entry ─────────────────────────────────────────────
const plugin = definePluginEntry({
  id: PLUGIN_ID,
  name: 'Zalo Mod',
  description: 'Zero-token Zalo group moderation — slash commands, anti-spam, warn system, memory integration.',
  // Note: do NOT set kind:'runtime' — it was deprecated in v2026.5.x
  // (PluginKind only accepts 'memory'|'context-engine'). Plugin loads correctly without it.

  register(api) {
    const logger = api.logger;

    // ── Auto-fix 777 permissions (Windows bind-mount issue) ─────────────────
    // OpenClaw gateway blocks world-writable plugins (Windows bind-mount gives 0777).
    // Fix proactively using pure Node.js fs — safe for ClawHub publish (no child_process).
    try {
      chmodSync(__dirname, 0o755);
      for (const f of readdirSync(__dirname)) {
        try {
          const p = path.join(__dirname, f);
          const st = statSync(p);
          chmodSync(p, st.isDirectory() ? 0o755 : 0o644);
        } catch (_) {}
      }
    } catch (_) { /* non-blocking — ok on non-Linux */ }

    const cfg = api.config;

    // Plugin config: read from api.pluginConfig (OpenClaw SDK) or fallback
    const pluginCfg = api.pluginConfig || cfg?.plugins?.entries?.[PLUGIN_ID]?.config || cfg?.plugins?.entries?.[PACKAGE_ID]?.config || {};
    // ── groupNames: source of truth cho danh sách groups đang quản lý ──
    // Format mới: { groupId: { name, admins, creatorId } }
    // Backward-compat: nếu value là string (format cũ) → auto-convert sang object
    const _rawGroupNames = pluginCfg.groupNames || {};
    const groupNames = {};
    for (const [gId, val] of Object.entries(_rawGroupNames)) {
      if (typeof val === 'string') {
        groupNames[gId] = { name: val, admins: [], creatorId: '' };
      } else if (val && typeof val === 'object') {
        groupNames[gId] = { name: val.name || '', admins: val.admins || [], creatorId: val.creatorId || '' };
      }
    }
    // watchGroupIds được derive từ groupNames keys — không cần config riêng
    const watchGroupIds = Object.keys(groupNames).filter(Boolean);

    const botName       = String(pluginCfg.botName || 'Bot');
    const zaloNames     = (pluginCfg.zaloDisplayNames || []).map(String);
    const botNames      = [botName, ...zaloNames].filter(Boolean);
    const pfx = String(pluginCfg.slashPrefix || botName).toLowerCase().replace(/[^a-z0-9]/g, '');
    const cmdPrefix = '/' + (pfx || 'bot') + '-';
    const ownerId       = String(pluginCfg.ownerId || '');  // Zalo ID chủ nhân bot
    // adminIds: derive từ ownerId — không cần config riêng
    // (per-group admins lưu trong groupNames[gId].admins và settings.json)
    const adminIds = new Set(ownerId ? [ownerId] : []);
    const allowedDmUsers = new Set((pluginCfg.allowedDmUsers || []).map(String)); // DM whitelist
    const welcomeEnabled = pluginCfg.welcomeEnabled !== false;
    const spamRepeatN   = Number(pluginCfg.spamRepeatN || 5);
    const spamWindowMs  = Number(pluginCfg.spamWindowSeconds || 300) * 1000;
    const welcomePollSec = Number(pluginCfg.welcomePollSeconds || 60);

    /** Tra tên group theo ID — dùng groupNames map, fallback 'Nhóm' */
    function getGroupName(gId) {
      const plain = String(gId || '').replace(/^group:/, '');
      return groupNames[plain]?.name || 'Nhóm';
    }

    // Data dir — store JSON data alongside the plugin code
    const dataDir = path.join(__dirname, 'data');

    // Workspace + Memory dir — resolve from agent config or OPENCLAW_HOME
    const _agentWorkspace = cfg?.agents?.list?.[0]?.workspace;
    const _defaultWorkspace = cfg?.agents?.defaults?.workspace;
    const workspaceDir = String(
      _agentWorkspace
        ? path.resolve(_openclawHome, '..', _agentWorkspace)  // relative to project root
        : _defaultWorkspace || path.join(_openclawHome, 'workspace')
    );

    // Memory dir — per-group: skills/memory/zalo-groups/{group-slug}/
    function _slugify(name) {
      return (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default-group';
    }
    /** Trả về memory dir cho 1 group cụ thể */
    function getMemoryDir(groupId) {
      const plain = String(groupId || '').replace(/^group:/, '');
      const slug = pluginCfg.memoryGroupSlug || _slugify(getGroupName(plain) || 'nhom-' + plain.slice(-6));
      return path.join(workspaceDir, 'skills/memory/zalo-groups', slug);
    }
    /** Trả về slug cho 1 group */
    function getMemorySlug(groupId) {
      const plain = String(groupId || '').replace(/^group:/, '');
      return pluginCfg.memoryGroupSlug || _slugify(getGroupName(plain) || 'nhom-' + plain.slice(-6));
    }

    const store       = createStore(dataDir);
    const spamTracker = createSpamTracker(spamRepeatN, spamWindowMs);

    let storeLoaded = false;
    async function ensureStore() {
      if (!storeLoaded) {
        await store.load();
        storeLoaded = true;
      }
    }

    // Force reload store from disk (for /memory, /report)
    async function reloadStore() {
      await store.load();
      storeLoaded = true;
    }

    // ── Auto-bootstrap workspace files on first load ─────────
    // Creates SKILL.md + memory INDEX.md if they don't exist.
    // This runs automatically so ClawHub installs work without manual setup.js.
    async function bootstrapWorkspaceFiles() {
      try {
        // 1. Create skills/zalo-group-admin/SKILL.md
        const skillDir = path.join(workspaceDir, 'skills', 'zalo-group-admin');
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        try {
          await fs.access(skillMdPath);
        } catch {
          // File doesn't exist — create it
          await fs.mkdir(skillDir, { recursive: true });
          const skillContent = [
            '---',
            'name: Zalo Group Admin',
            'slug: zalo-group-admin',
            'version: 1.2.0',
            `description: Quy tắc reply và quản lý group Zalo — ưu tiên ngắn gọn, súc tích.`,
            '---',
            '',
            '# Zalo Group Admin 💬',
            '',
            '## Khi nào dùng skill này',
            '',
            'Khi `chat_id` chứa `group:` → Bot đang ở trong Zalo group. Áp dụng toàn bộ quy tắc bên dưới.',
            '',
            '---',
            '',
            '## ⚡ NGUYÊN TẮC SỐ 1 — NGẮN GỌN LÀ ĐẶC QUYỀN CỦA GROUP',
            '',
            '> Trong group chat, **ngắn gọn = tôn trọng**. AI nói dài = spam group.',
            '',
            '### Giới hạn cứng (KHÔNG vi phạm):',
            '- **Tối đa 5 dòng** mỗi reply trong group',
            '- **KHÔNG dùng markdown headers** (`##`, `###`) — Zalo không render',
            '- **KHÔNG dùng bullet list dài** — tối đa 3 bullets',
            '- **KHÔNG dùng bold italic** (`**text**`) — Zalo không render',
            '- **Chỉ 1 câu hỏi nếu cần làm rõ**',
            '',
            '---',
            '',
            `## 📖 Đọc Group Memory Trước Khi Reply`,
            '',
            `Khi @mention trong group:`,
            `1. Đọc memory dir tương ứng trong ~/skills/memory/zalo-groups/`,
            '2. Kiểm tra `chat-highlights.md` xem context gần nhất',
            '3. Nếu user từng mention trước → reference lại, không hỏi lại',
            '',
            `**Path:** \`~/skills/memory/zalo-groups/\``,
            '',
            '---',
            '',
            '## 🎯 Xưng Hô Trong Group',
            '',
            '- Với **member thường**: xưng "mình", gọi "bác" hoặc tên',
            '- Với **câu hỏi kỹ thuật**: trả lời thẳng, không giải thích quá nhiều',
            '- Với **câu hỏi mơ hồ**: hỏi 1 câu làm rõ — chỉ 1 câu thôi',
            '',
            '---',
            '',
            '## 📝 Ghi Memory Sau Reply',
            '',
            'Sau mỗi @mention được xử lý:',
            '```',
            `~/skills/memory/zalo-groups/*/chat-highlights.md`,
            '```',
            'Format: `| YYYY-MM-DD HH:MM | {tên user} | {tóm tắt 1 dòng} |`',
            '',
            '---',
            '',
            '## 📋 DANH SÁCH SLASH COMMANDS ĐẦY ĐỦ',
            '',
            '> Tất cả commands xử lý bởi plugin `openclaw-zalo-mod` — bot KHÔNG cần reply.',
            `> Prefix lệnh: \`${cmdPrefix}\` (theo tên bot)`,
            '',
            '### 👤 Mọi người (trong group)',
            '',
            '| Command | Mô tả |',
            '|---------|-------|',
            `| \`${cmdPrefix}noi-quy\` | Xem nội quy nhóm |`,
            `| \`${cmdPrefix}menu\` | Danh sách lệnh |`,
            `| \`${cmdPrefix}huong-dan\` | Hướng dẫn sử dụng bot |`,
            '',
            '### 🔧 Admin (trong group)',
            '',
            '| Command | Mô tả |',
            '|---------|-------|',
            `| \`${cmdPrefix}mute\` | Tắt bot hoàn toàn |`,
            `| \`${cmdPrefix}unmute\` / \`${cmdPrefix}bat-bot\` | Bật lại bot |`,
            `| \`${cmdPrefix}warn @name [lý do]\` | Cảnh cáo member |`,
            `| \`${cmdPrefix}note [text]\` | Ghi chú admin |`,
            `| \`${cmdPrefix}report\` | Báo cáo vi phạm + warn |`,
            `| \`${cmdPrefix}memory [note]\` | Lưu memory digest |`,
            '',
            '### 👑 Owner — trong group',
            '',
            '| Command | Mô tả |',
            '|---------|-------|',
            `| \`${cmdPrefix}rules\` | Xem panel sub-lệnh |`,
            `| \`${cmdPrefix}rules status\` | Cấu hình group hiện tại |`,
            `| \`${cmdPrefix}rules groupid\` | Thêm group này vào config |`,
            `| \`${cmdPrefix}rules silent-on\` | Bật silent (chỉ reply khi @tag) |`,
            `| \`${cmdPrefix}rules silent-off\` | Tắt silent mode |`,
            `| \`${cmdPrefix}rules welcome-on\` | Bật chào member mới |`,
            `| \`${cmdPrefix}rules welcome-off\` | Tắt chào member mới |`,
            `| \`${cmdPrefix}rules tracking-on\` | Bật ghi lịch sử chat |`,
            `| \`${cmdPrefix}rules tracking-off\` | Tắt ghi lịch sử chat |`,
            '',
            '### 🔐 Owner — qua DM',
            '',
            '| Command | Mô tả |',
            '|---------|-------|',
            `| \`${cmdPrefix}rules mute-list\` | Trạng thái mute tất cả groups |`,
            `| \`${cmdPrefix}rules mute <groupId> on/off\` | Mute/unmute group cụ thể |`,
            `| \`${cmdPrefix}rules mute all on/off\` | Mute/unmute tất cả |`,
            `| \`${cmdPrefix}rules silent-list\` | Trạng thái silent tất cả groups |`,
            `| \`${cmdPrefix}rules silent <groupId> on/off\` | Silent group cụ thể |`,
            `| \`${cmdPrefix}rules silent all on/off\` | Silent tất cả |`,
            `| \`${cmdPrefix}rules welcome-list\` | Trạng thái welcome tất cả |`,
            `| \`${cmdPrefix}rules welcome <groupId> on/off\` | Welcome group cụ thể |`,
            `| \`${cmdPrefix}rules welcome all on/off\` | Welcome tất cả |`,
            `| \`${cmdPrefix}rules tracking-list\` | Trạng thái tracking tất cả |`,
            `| \`${cmdPrefix}rules tracking <groupId> on/off\` | Tracking group cụ thể |`,
            `| \`${cmdPrefix}rules tracking all on/off\` | Tracking tất cả |`,
            `| \`${cmdPrefix}rules follow-list\` | Theo dõi memory per-group |`,
            `| \`${cmdPrefix}rules follow <groupId> on/off\` | Follow group cụ thể |`,
            `| \`${cmdPrefix}rules follow all on/off\` | Follow tất cả |`,
            `| \`${cmdPrefix}rules dm-list\` | DM whitelist |`,
            `| \`${cmdPrefix}rules dm-add <tên>\` | Thêm vào DM whitelist |`,
            `| \`${cmdPrefix}rules dm-remove <tên>\` | Xóa khỏi DM whitelist |`,
            `| \`${cmdPrefix}rules groupid-list\` | Danh sách tất cả groups |`,
            `| \`${cmdPrefix}rules groupid-add <groupId>\` | Thêm group từ xa |`,
            `| \`${cmdPrefix}ownerid\` | Xem/đặt owner ID |`,
            '',
            '---',
            '',
            '## 🔇 Mute vs Silent',
            '',
            '| | Mute | Silent |',
            '|--|------|--------|',
            '| Bot im lặng | Hoàn toàn | Chỉ không tự reply |',
            '| Slash hoạt động | ❌ (chỉ /unmute) | ✅ |',
            '| @mention | ❌ | ✅ |',
            '| Welcome | ❌ | ✅ |',

            '',
          ].join('\n');
          await fs.writeFile(skillMdPath, skillContent, 'utf8');
          logger.info('[openclaw-zalo-mod] auto-created skills/zalo-group-admin/SKILL.md');
        }

        // 2. Create memory INDEX.md cho mỗi group đang follow
        for (const gId of watchGroupIds) {
          const isFollowed = store.getSetting(gId, 'follow', true);
          if (!isFollowed) continue;
          const mDir = getMemoryDir(gId);
          const indexMdPath = path.join(mDir, 'INDEX.md');
          try {
            await fs.access(indexMdPath);
          } catch {
            await fs.mkdir(mDir, { recursive: true });
            const indexContent = [
              `# ${getGroupName(gId)} — Memory`,
              '',
              '> Auto-generated by openclaw-zalo-mod plugin. Plugin sẽ tự cập nhật khi có events.',
              '',
              '## Files',
              '- `chat-highlights.md` — Log @mention và tương tác quan trọng',
              '- `members.md` — Danh sách member đã warn',
              '- `violations.md` — Log vi phạm (spam, link, emoji flood)',
              '- `admin-notes.md` — Ghi chú admin (/note)',
              '- `chat-log.md` — Lịch sử chat nhóm (khi tracking bật)',
              '',
            ].join('\n');
            await fs.writeFile(indexMdPath, indexContent, 'utf8');
            logger.info(`[openclaw-zalo-mod] auto-created memory dir for ${getGroupName(gId)} (${gId})`);
          }
        }

        // 3. Create data dir for plugin storage
        await fs.mkdir(dataDir, { recursive: true });

        // 4. Auto-detect & patch config if empty (ClawHub install flow)
        const configNeedsPatch = !pluginCfg.botName || Object.keys(groupNames).length === 0;
        if (configNeedsPatch) {
          const patch = {};

          // 4a. Read bot name from IDENTITY.md
          const detectedBotName = await _readBotNameFromIdentity(workspaceDir);
          if (detectedBotName) {
            patch.botName = detectedBotName;
            patch.zaloDisplayNames = [detectedBotName];
            logger.info(`[openclaw-zalo-mod] auto-detected botName="${detectedBotName}" from IDENTITY.md`);
          }

          // 4b. Scan session data for groups
          const agentId = cfg?.agents?.list?.[0]?.id;
          const groups = await _scanGroupsFromSessions(_openclawHome, agentId);
          if (groups.length > 0) {
            // Build groupNames map: mỗi group có object {name, admins, creatorId}
            const existingNames = pluginCfg.groupNames || {};
            const namesMap = { ...existingNames };
            for (const g of groups) {
              if (!namesMap[g.groupId]) {
                namesMap[g.groupId] = { name: g.groupName, admins: [], creatorId: '' };
              } else if (typeof namesMap[g.groupId] === 'string') {
                namesMap[g.groupId] = { name: namesMap[g.groupId], admins: [], creatorId: '' };
              }
            }
            patch.groupNames = namesMap;
            logger.info(`[openclaw-zalo-mod] auto-detected ${groups.length} group(s) from sessions: ${groups.map(g => g.groupName).join(', ')}`);
          } else {
            logger.info('[openclaw-zalo-mod] no group sessions found yet — user should chat in a group then run /groupid');
          }

          if (Object.keys(patch).length > 0) {
            await _patchOpenclawConfig(_openclawHome, patch, logger);
          }
        }
      } catch (e) {
        logger.warn(`[openclaw-zalo-mod] bootstrap workspace files failed: ${e.message}`);
      }
    }

    // Fire-and-forget bootstrap (don't block plugin registration)
    bootstrapWorkspaceFiles();

    // ── Memory Sync Helpers ──────────────────────────────────
    function nowShort() {
      return new Date().toISOString().slice(0, 16).replace('T', ' ');
    }

    async function appendToMemoryFile(groupId, filename, line) {
      try {
        const mDir = getMemoryDir(groupId);
        const filePath = path.join(mDir, filename);
        await fs.mkdir(mDir, { recursive: true });
        await fs.appendFile(filePath, line + '\n', 'utf8');
      } catch (e) {
        logger.warn(`[openclaw-zalo-mod] memory append failed (${filename}): ${e.message}`);
      }
    }

    // ── Chat Tracking — lịch sử chat thông minh ──────────────
    const _trackingDedup = new Set();
    const DEDUP_MAX = 500;
    const CHAT_LOG_MAX_BYTES = 200 * 1024; // 200KB
    const CHAT_CONTENT_MAX = 200; // ký tự/dòng
    let _lastLogDate = ''; // cache ngày cuối ghi log

    function chatFingerprint(senderId, content) {
      const raw = `${senderId}:${String(content).slice(0, 60)}`;
      let h = 0;
      for (let i = 0; i < raw.length; i++) {
        h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
      }
      return String(h);
    }

    function isTrackingDuplicate(fp) {
      if (_trackingDedup.has(fp)) return true;
      _trackingDedup.add(fp);
      if (_trackingDedup.size > DEDUP_MAX) {
        const first = _trackingDedup.values().next().value;
        _trackingDedup.delete(first);
      }
      return false;
    }

    async function appendChatLog(groupId, senderName, content) {
      try {
        // 1. Dedup check
        const fp = chatFingerprint(String(groupId) + senderName, content);
        if (isTrackingDuplicate(fp)) return;

        const mDir = getMemoryDir(groupId);
        const logPath = path.join(mDir, 'chat-log.md');
        await fs.mkdir(mDir, { recursive: true });

        // 2. Rotate nếu file > 200KB
        try {
          const stat = await fs.stat(logPath);
          if (stat.size > CHAT_LOG_MAX_BYTES) {
            const today = new Date().toISOString().slice(0, 10);
            const bakPath = path.join(mDir, `chat-log-${today}.md.bak`);
            await fs.rename(logPath, bakPath);
            logger.info(`[openclaw-zalo-mod] chat-log rotated → ${bakPath}`);
          }
        } catch { /* file chưa tồn tại — OK */ }

        // 3. Ngày mới → thêm date header
        const today = new Date().toISOString().slice(0, 10);
        let prefix = '';
        if (_lastLogDate !== today) {
          // Kiểm tra file có tồn tại + nội dung không
          let needHeader = true;
          try {
            const existing = await fs.readFile(logPath, 'utf8');
            if (existing.includes(`## ${today}`)) needHeader = false;
          } catch { /* file chưa có */ }
          if (needHeader) {
            prefix = `\n## ${today}\n\n| Giờ | Người gửi | Nội dung |\n|-----|-----------|----------|\n`;
          }
          _lastLogDate = today;
        }

        // 4. Append dòng
        const time = new Date().toISOString().slice(11, 16); // HH:MM
        const safeContent = String(content).replace(/\|/g, '│').replace(/\n/g, ' ').slice(0, CHAT_CONTENT_MAX);
        const safeName = String(senderName).replace(/\|/g, '│').slice(0, 30);
        const line = `| ${time} | ${safeName} | ${safeContent} |`;

        await fs.appendFile(logPath, prefix + line + '\n', 'utf8');
      } catch (e) {
        logger.warn(`[openclaw-zalo-mod] chat-log append failed: ${e.message}`);
      }
    }

    // Smart group lookup — match groupId with/without "group:" prefix, merge duplicate userIds
    function getStoreDataForGroup(allData, gId) {
      const plain = String(gId).replace(/^group:/, '');
      const merged = {};
      for (const [key, users] of Object.entries(allData)) {
        const keyPlain = String(key).replace(/^group:/, '');
        if (keyPlain !== plain) continue;
        for (const [uid, list] of Object.entries(users)) {
          const normUid = String(uid).replace(/^@/, '');
          merged[normUid] = merged[normUid] || [];
          merged[normUid].push(...list);
        }
      }
      return merged;
    }

    async function writeMemoryDigest(gId) {
      try {
        const warns = getStoreDataForGroup(store.getAllWarned(), gId);
        const violations = getStoreDataForGroup(store.getAllViolations(), gId);

        // Overwrite members.md with full warn digest
        const memberLines = [
          `# ${getGroupName(gId)} — Members & Warn Log\n`,
          '> **Cập nhật:** ' + nowShort() + ' bởi /memory command\n',
          '## Members Đã Warn\n',
          '| Tên | Số warn | Lý do gần nhất | Lần cuối |',
          '|-----|---------|-----------------|----------|',
        ];
        let totalWarns = 0;
        for (const [uid, list] of Object.entries(warns)) {
          if (!list.length) continue;
          totalWarns++;
          list.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
          const last = list[0];
          memberLines.push(`| ${(last.name || uid).replace(/^@/, '')} | ${list.length} | ${last.reason || '—'} | ${(last.ts || '').slice(0, 10)} |`);
        }
        if (!totalWarns) memberLines.push('| — | — | — | — |');
        await fs.writeFile(path.join(getMemoryDir(gId), 'members.md'), memberLines.join('\n') + '\n', 'utf8');

        // Overwrite violations.md with full log
        const vioLines = [
          `# ${getGroupName(gId)} — Vi Phạm\n`,
          '> **Cập nhật:** ' + nowShort() + ' bởi /memory command\n',
          '## Log Vi Phạm\n',
          '| Thời gian | Member | Loại | Preview |',
          '|-----------|--------|------|---------|',
        ];
        let totalVio = 0;
        for (const [uid, list] of Object.entries(violations)) {
          if (uid === 'admin-note') continue; // skip admin notes from violation count
          for (const v of list) {
            totalVio++;
            vioLines.push(`| ${(v.ts || '').slice(0, 16).replace('T', ' ')} | ${(v.name || uid).replace(/^@/, '')} | ${v.type} | ${(v.preview || '').slice(0, 40)} |`);
          }
        }
        if (!totalVio) vioLines.push('| — | — | — | — |');
        await fs.writeFile(path.join(getMemoryDir(gId), 'violations.md'), vioLines.join('\n') + '\n', 'utf8');

        logger.info(`[openclaw-zalo-mod] memory digest — warns=${totalWarns}, violations=${totalVio} for group=${gId}`);
        return { warnCount: totalWarns, vioCount: totalVio };
      } catch (e) {
        logger.warn(`[openclaw-zalo-mod] writeMemoryDigest failed: ${e.message}`);
        return { warnCount: 0, vioCount: 0 };
      }
    }

    // ── Zalo session (loaded once) ────────────────────────────
    let _zaloCookies = null;
    let _zaloImei = '';

    async function loadZaloSession() {
      if (_zaloCookies) return _zaloCookies;
      try {
        const credPath = path.join(
          String(cfg?.agents?.defaults?.workspace || '/mnt/d/SecondBrain/.openclaw/workspace'),
          '../credentials/zalouser/credentials.json'
        );
        const raw = await safeReadJson(credPath);
        if (!raw) return null;
        const cookies = raw.cookie || [];
        const get = (key, domain) => {
          const matches = cookies.filter(c => c.key === key);
          if (domain) {
            const pref = matches.find(c => (c.domain || '').includes(domain));
            if (pref) return pref.value;
          }
          return matches[0]?.value || '';
        };
        _zaloImei = raw.imei || '';
        _zaloCookies = {
          zpsid:   get('zpsid', 'zalo.me'),
          zpw_sek: get('zpw_sek', 'chat.zalo.me'),
        };
        logger.info(`[openclaw-zalo-mod] Zalo session loaded (imei=${_zaloImei.slice(0, 8)}...)`);
        return _zaloCookies;
      } catch (e) {
        logger.warn(`[openclaw-zalo-mod] loadZaloSession failed: ${String(e)}`);
        return null;
      }
    }

    // ── Zalouser send API — dynamic path resolution ──────────
    // @openclaw/zalouser installed at: {OPENCLAW_HOME}/npm/node_modules/@openclaw/zalouser/
    let _zalouserSendApi = null;
    let _zalouserSendApiUnavailable = false;

    async function _loadZalouserSendApi() {
      if (_zalouserSendApi) return _zalouserSendApi;
      if (_zalouserSendApiUnavailable) return null;
      const candidates = [
        // Preferred: co-located npm dir (standard OpenClaw Docker setup)
        path.join(_openclawHome, 'npm/node_modules/@openclaw/zalouser/dist/test-api.js'),
        // Fallback: system npm
        '/usr/local/lib/node_modules/@openclaw/zalouser/dist/test-api.js',
        // Legacy: old openclaw path
        '/usr/local/lib/node_modules/openclaw/dist/extensions/zalouser/test-api.js',
      ];
      for (const p of candidates) {
        try {
          const url = p.startsWith('/') ? `file://${p}` : `file:///${p.replace(/\\/g, '/')}`;
          _zalouserSendApi = await import(url);
          logger.info(`[openclaw-zalo-mod] zalouser send API loaded: ${p}`);
          return _zalouserSendApi;
        } catch { /* try next */ }
      }
      logger.warn('[openclaw-zalo-mod] zalouser send API not found — DM/group messages disabled.');
      _zalouserSendApiUnavailable = true;
      return null;
    }

    // Helper: send reply natively via OpenClaw Zalouser API
    async function sendGroupMsg(ctx, groupId, text) {
      if (!groupId || !text) return;
      const profile = ctx?.accountId || 'default';
      logger.info(`[openclaw-zalo-mod] sendGroupMsg → threadId=${groupId}, profile=${profile}, textLen=${text.length}`);
      try {
        const api = await _loadZalouserSendApi();
        if (!api?.sendMessageZalouser) { logger.warn('[openclaw-zalo-mod] sendGroupMsg skipped — API unavailable'); return; }
        const result = await api.sendMessageZalouser(String(groupId), String(text), {
          isGroup: true,
          profile,
          textMode: 'markdown'
        });
        if (result && !result.ok) {
          logger.error(`[openclaw-zalo-mod] Native Zalo send failed: ${result.error}`);
        } else {
          logger.info(`[openclaw-zalo-mod] Native message delivered to group ${groupId}`);
        }
      } catch (err) {
        logger.error(`[openclaw-zalo-mod] Native Zalo send exception: ${err.message}`);
      }
    }

    // Helper: send DM (non-group) via Zalouser API
    async function sendDmMsg(ctx, userId, text) {
      if (!userId || !text) return;
      const profile = ctx?.accountId || 'default';
      try {
        const api = await _loadZalouserSendApi();
        if (!api?.sendMessageZalouser) { logger.warn('[openclaw-zalo-mod] sendDmMsg skipped — API unavailable'); return; }
        await api.sendMessageZalouser(String(userId), String(text), {
          isGroup: false,
          profile,
          textMode: 'markdown'
        });
      } catch (err) {
        logger.error(`[openclaw-zalo-mod] DM send failed to ${userId}: ${err.message}`);
      }
    }

    function isAdmin(senderId, groupId) {
      if (String(senderId) === ownerId) return true;
      if (adminIds.has(String(senderId))) return true;
      // Check per-group admins (từ ZCA sync)
      if (groupId) {
        const gAdmins = groupNames[groupId]?.admins || getGroupAdmins(groupId);
        if (gAdmins.includes(String(senderId))) return true;
      }
      return false;
    }

    // ── Member Directory — persistent name↔ID mapping ────────
    const memberDirPath = path.join(dataDir, 'group-members.json');
    let _memberDir = {}; // { groupId: { userId: displayName, ... }, ... }

    async function loadMemberDir() {
      try {
        const raw = await fs.readFile(memberDirPath, 'utf8');
        _memberDir = JSON.parse(raw) || {};
      } catch { _memberDir = {}; }
    }

    async function saveMemberDir() {
      try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(memberDirPath, JSON.stringify(_memberDir, null, 2), 'utf8');
      } catch (e) {
        logger.warn(`[openclaw-zalo-mod] save member-dir failed: ${e.message}`);
      }
    }

    /** Cập nhật member directory cho 1 group từ kết quả poll */
    function updateMemberDir(groupId, members) {
      if (!Array.isArray(members)) return;
      if (!_memberDir[groupId]) _memberDir[groupId] = {};
      for (const m of members) {
        if (m.id) _memberDir[groupId][m.id] = m.name || _memberDir[groupId][m.id] || m.id;
      }
    }

    /** Tìm userId theo tên hiển thị (tìm trong tất cả groups) */
    function findUserByName(nameQuery) {
      const q = nameQuery.toLowerCase().trim();
      const results = [];
      for (const [gId, members] of Object.entries(_memberDir)) {
        for (const [uid, name] of Object.entries(members)) {
          if (String(name).toLowerCase().includes(q)) {
            results.push({ userId: uid, name, groupId: gId });
          }
        }
      }
      // Dedupe by userId
      const seen = new Set();
      return results.filter(r => { if (seen.has(r.userId)) return false; seen.add(r.userId); return true; });
    }

    // Load member directory on startup
    loadMemberDir();

    // ── Member Watcher — polling-based welcome ─────────────────
    // OpenClaw zalouser channel ONLY forwards text messages to before_dispatch.
    // System events (member join/leave) are silently filtered — they never reach plugins.
    // Workaround: poll group member list via OpenClaw internal API, diff with previous snapshot.
    //
    // IMPORTANT: Use globalThis to persist state across gateway hot-reloads.
    // OpenClaw may re-register() the plugin in the SAME Node.js process,
    // creating new local vars but leaving old setInterval timers running.
    // globalThis ensures: (1) only ONE watcher runs, (2) dedup survives hot-reload.
    const _G = globalThis.__zaloModWatcher = globalThis.__zaloModWatcher || {
      memberSnapshots: new Map(),   // groupId → Set<userId>
      welcomedDedup: new Set(),     // "groupId:userId"
      watcherTimer: null,
      initTimer: null,
      zaloApiModule: null,
    };

    let _watcherApiUnavailable = false;  // flag: API đã confirmed không khả dụng
    let _pollFailCounts = {};            // groupId → consecutive fail count

    async function loadZaloApi() {
      if (_G.zaloApiModule) return _G.zaloApiModule;
      if (_watcherApiUnavailable) return null;  // đã biết không có, không thử nữa

      // Thử nhiều path — tùy phiên bản OpenClaw
      const paths = [
        // Preferred: npm dir
        `file://${path.join(_openclawHome, 'npm/node_modules/@openclaw/zalouser/dist/test-api.js').replace(/\\/g, '/')}`,
        'file:///usr/local/lib/node_modules/@openclaw/zalouser/dist/test-api.js',
        'file:///usr/local/lib/node_modules/openclaw/dist/extensions/zalouser/test-api.js',
      ];
      for (const p of paths) {
        try {
          _G.zaloApiModule = await import(p);
          return _G.zaloApiModule;
        } catch { /* thử path tiếp theo */ }
      }
      // Tất cả path fail
      logger.warn(`[openclaw-zalo-mod] [WATCHER] zalouser API not available — member watcher disabled. Restart gateway nếu vừa cài xong OpenClaw.`);
      _watcherApiUnavailable = true;
      return null;
    }

    async function pollGroupMembers(groupId) {
      const failKey = String(groupId);
      try {
        const api = await loadZaloApi();
        if (!api?.listZaloGroupMembers) return null;

        const members = await api.listZaloGroupMembers('default', String(groupId));
        if (!Array.isArray(members)) return null;

        // Reset fail count khi thành công
        _pollFailCounts[failKey] = 0;
        return members.map(m => ({
          id: String(m.userId || m.id || ''),
          name: String(m.displayName || m.name || m.zaloName || ''),
        })).filter(m => m.id);
      } catch (e) {
        _pollFailCounts[failKey] = (_pollFailCounts[failKey] || 0) + 1;
        // Chỉ log khi fail >= 3 lần liên tiếp (Zalo rate-limit tạm thời là bình thường)
        if (_pollFailCounts[failKey] >= 3 && (_pollFailCounts[failKey] === 3 || _pollFailCounts[failKey] % 10 === 0)) {
          logger.warn(`[openclaw-zalo-mod] [WATCHER] poll failed for group ${groupId} (x${_pollFailCounts[failKey]}): ${e.message}`);
        }
        return null;
      }
    }

    // ── Group Admin tracking via direct ZCA API ──────────────────
    // OpenClaw wrapper strips creatorId/adminIds from getGroupInfo response.
    // Solution: import zca-js directly, login with saved credentials, call raw API.
    // ZCA direct API — tạo on-demand, KHÔNG giữ session lâu dài
    // để tránh conflict với session chính của OpenClaw (Zalo đá session)
    let _zcaApi = null;
    let _zcaApiCreatedAt = 0;
    const ZCA_SESSION_TTL = 30_000; // 30s — đủ cho 1 batch quét, sau đó expire

    async function _getZcaApi() {
      // Reuse nếu vẫn còn trong TTL
      if (_zcaApi && (Date.now() - _zcaApiCreatedAt) < ZCA_SESSION_TTL) {
        return _zcaApi;
      }
      // Invalidate cũ
      _zcaApi = null;
      try {
        const possibleZcaPaths = [
          path.join(_openclawHome, 'npm', 'node_modules', 'zca-js'),
          path.join(_openclawHome, 'node_modules', 'zca-js'),
          path.resolve('/root/project/.openclaw/npm/node_modules/zca-js'),
          path.resolve('/usr/local/lib/node_modules/openclaw/node_modules/zca-js')
        ];
        let zcaPath = null;
        for (const p of possibleZcaPaths) {
          if (require('fs').existsSync(p)) {
            zcaPath = p;
            break;
          }
        }
        if (!zcaPath) {
          try {
            zcaPath = require.resolve('zca-js');
          } catch (err) {
            throw new Error('Cannot find zca-js in known paths');
          }
        }
        const { Zalo } = require(zcaPath);
        const credsPath = path.join(_openclawHome, 'credentials', 'zalouser', 'credentials.json');
        const creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
        const zalo = new Zalo({ checkUpdate: false, logging: false });
        _zcaApi = await zalo.login(creds);
        _zcaApiCreatedAt = Date.now();
        if (_zcaApi.listener && typeof _zcaApi.listener.stop === "function") { _zcaApi.listener.stop(); }
        logger.info('[openclaw-zalo-mod] ZCA direct API initialized (TTL=30s) and WebSocket listener stopped to prevent decryption errors');
        return _zcaApi;
      } catch (e) {
        logger.warn(`[openclaw-zalo-mod] ZCA direct API init failed: ${e.message}`);
        return null;
      }
    }

    /** Gọi sau khi batch xong — hủy session ZCA để không conflict */
    function _invalidateZcaApi() {
      _zcaApi = null;
      _zcaApiCreatedAt = 0;
    }

    /**
     * Gọi ZCA getGroupInfo trực tiếp → trả { creatorId, adminIds, totalMember, name }
     */
    async function fetchGroupAdminsFromZCA(groupId) {
      try {
        const api = await _getZcaApi();
        if (!api) return null;
        const result = await api.getGroupInfo(String(groupId));
        const info = result?.gridInfoMap?.[String(groupId)];
        if (!info) return null;
        return {
          creatorId: info.creatorId || null,
          adminIds: Array.isArray(info.adminIds) ? info.adminIds : [],
          totalMember: info.totalMember || 0,
          name: info.name || '',
        };
      } catch (e) {
        logger.warn(`[openclaw-zalo-mod] fetchGroupAdminsFromZCA failed for ${groupId}: ${e.message}`);
        return null;
      }
    }

    // Lưu admin vào settings.json (merge từ ZCA + manual)
    function getGroupAdmins(groupId) {
      return store.getSetting(groupId, 'groupAdmins', []);
    }
    function addGroupAdmin(groupId, userId) {
      const admins = getGroupAdmins(groupId);
      if (!admins.includes(String(userId))) {
        admins.push(String(userId));
        store.setSetting(groupId, 'groupAdmins', admins);
      }
    }
    function getGroupAdminNames(groupId) {
      const admins = getGroupAdmins(groupId);
      return admins.map(id => _memberDir[groupId]?.[id] || id);
    }

    /**
     * Sync group admins từ ZCA API → settings.json + groupNames config
     * Gọi khi /groupid-add hoặc ${cmdPrefix}rules groupid
     */
    async function syncGroupAdminsFromZCA(groupId) {
      const zcaInfo = await fetchGroupAdminsFromZCA(groupId);
      if (!zcaInfo) return null;
      // Merge: creatorId + adminIds → groupAdmins
      const allAdmins = new Set(getGroupAdmins(groupId));
      if (zcaInfo.creatorId) allAdmins.add(String(zcaInfo.creatorId));
      for (const id of zcaInfo.adminIds) allAdmins.add(String(id));
      const adminList = [...allAdmins];
      // Update settings.json (per-group)
      store.setSetting(groupId, 'groupAdmins', adminList);
      store.setSetting(groupId, 'creatorId', zcaInfo.creatorId);
      await store.saveSettings();
      // Update in-memory groupNames + persist to openclaw.json
      if (groupNames[groupId]) {
        groupNames[groupId].admins = adminList;
        groupNames[groupId].creatorId = zcaInfo.creatorId || '';
        if (zcaInfo.name) groupNames[groupId].name = zcaInfo.name;
      } else {
        groupNames[groupId] = { name: zcaInfo.name || '', admins: adminList, creatorId: zcaInfo.creatorId || '' };
      }
      // Persist groupNames to openclaw.json
      const mergedNames = { ...(pluginCfg.groupNames || {}) };
      mergedNames[groupId] = groupNames[groupId];
      await _patchOpenclawConfig(_openclawHome, { groupNames: mergedNames }, logger, true);
      logger.info(`[openclaw-zalo-mod] synced admins for group ${groupId}: creator=${zcaInfo.creatorId}, admins=${adminList.join(',')}, members=${zcaInfo.totalMember}`);
      return zcaInfo;
    }

    async function checkForNewMembers(groupId) {
      // Skip poll entirely if welcome is disabled for this group — saves API calls
      const welcomeOn = store.getSetting(groupId, 'welcome', true);
      if (!welcomeOn) return;

      const members = await pollGroupMembers(groupId);
      if (!members) return;

      // Cập nhật member directory (persistent)
      updateMemberDir(groupId, members);
      saveMemberDir(); // fire-and-forget

      const currentIds = new Set(members.map(m => m.id));
      const prevIds = _G.memberSnapshots.get(groupId);

      if (!prevIds) {
        // First poll — just save snapshot, don't welcome everyone
        _G.memberSnapshots.set(groupId, currentIds);
        logger.info(`[openclaw-zalo-mod] [WATCHER] initial snapshot for group ${groupId}: ${currentIds.size} members (member-dir updated)`);
        return;
      }

      // Find new members (in current but not in previous)
      const newMembers = members.filter(m => !prevIds.has(m.id));
      // Update snapshot
      _G.memberSnapshots.set(groupId, currentIds);

      if (newMembers.length === 0) return;

      // Dedup: skip members already welcomed recently (survives hot-reloads via globalThis)
      const dedupKey = (gId, mId) => `${gId}:${mId}`;
      const toWelcome = newMembers.filter(m => !_G.welcomedDedup.has(dedupKey(groupId, m.id)));
      if (toWelcome.length === 0) {
        logger.info(`[openclaw-zalo-mod] [WATCHER] ${newMembers.length} new member(s) detected but all already welcomed (dedup)`);
        return;
      }

      logger.info(`[openclaw-zalo-mod] [WATCHER] ${toWelcome.length} new member(s) in group ${groupId}: ${toWelcome.map(m => m.name || m.id).join(', ')}`);


      // Send welcome for new members (batch — don't spam if many join at once)
      for (const member of toWelcome.slice(0, 5)) {
        const memberName = member.name || 'bạn';
        // Mark as welcomed FIRST (before sending) to prevent race condition
        // where a concurrent poll also tries to welcome the same member
        _G.welcomedDedup.add(dedupKey(groupId, member.id));
        setTimeout(() => _G.welcomedDedup.delete(dedupKey(groupId, member.id)), 3600000);
        try {
          await sendGroupMsg({ accountId: 'default' }, groupId, buildWelcome(memberName,  botName, cmdPrefix));
          await appendToMemoryFile(groupId, 'chat-highlights.md', `| ${nowShort()} | SYSTEM | Welcome: ${memberName} joined (detected by watcher) |`);
          logger.info(`[openclaw-zalo-mod] [WATCHER] welcome sent for ${memberName} in group ${groupId}`);
        } catch (e) {
          logger.error(`[openclaw-zalo-mod] [WATCHER] welcome send failed for ${memberName}: ${e.message}`);
        }
        // Small delay between messages to avoid rate limiting
        await new Promise(r => setTimeout(r, 2000));
      }
      if (toWelcome.length > 5) {
        await sendGroupMsg({ accountId: 'default' }, groupId,
          `👋 Và ${toWelcome.length - 5} bạn mới nữa — chào mừng tất cả! 🎉\n/noi-quy để xem nội quy nhóm.`
        );
      }
    }

    function startMemberWatcher() {
      if (!welcomeEnabled || watchGroupIds.length === 0) {
        if (watchGroupIds.length === 0) {
          logger.info(`[openclaw-zalo-mod] [WATCHER] no watchGroupIds configured — welcome watcher disabled`);
        }
        return;
      }

      // CRITICAL: Clear any existing timer from previous register() hot-reload
      if (_G.watcherTimer) {
        clearInterval(_G.watcherTimer);
        _G.watcherTimer = null;
        logger.info(`[openclaw-zalo-mod] [WATCHER] cleared previous watcher timer (hot-reload detected)`);
      }
      if (_G.initTimer) {
        clearTimeout(_G.initTimer);
        _G.initTimer = null;
      }

      const intervalMs = Math.max(welcomePollSec, 30) * 1000; // min 30s to avoid Zalo rate limits

      // Initial snapshot after a delay (let zalouser fully connect first)
      _G.initTimer = setTimeout(async () => {
        _G.initTimer = null;
        await ensureStore();

        // Filter: only poll groups where welcome is ON
        const activeGroups = watchGroupIds.filter(gId => store.getSetting(gId, 'welcome', true));
        const skippedGroups = watchGroupIds.filter(gId => !store.getSetting(gId, 'welcome', true));
        logger.info(`[openclaw-zalo-mod] [WATCHER] starting member watcher — polling ${activeGroups.length}/${watchGroupIds.length} group(s), poll every ${intervalMs/1000}s`);
        if (activeGroups.length > 0) logger.info(`[openclaw-zalo-mod] [WATCHER] active: ${activeGroups.map(g => getGroupName(g)).join(', ')}`);
        if (skippedGroups.length > 0) logger.info(`[openclaw-zalo-mod] [WATCHER] skipped (welcome off): ${skippedGroups.map(g => getGroupName(g)).join(', ')}`);

        for (const gId of activeGroups) {
          await checkForNewMembers(gId);
          // Delay 3s giữa mỗi group — tránh Zalo rate limit
          if (activeGroups.length > 1) await new Promise(r => setTimeout(r, 3000));
        }
        // Then start periodic polling
        _G.watcherTimer = setInterval(async () => {
          for (const gId of watchGroupIds) {
            try {
              await checkForNewMembers(gId);
            } catch (e) {
              logger.warn(`[openclaw-zalo-mod] [WATCHER] poll error for ${gId}: ${e.message}`);
            }
            // Delay 3s giữa mỗi group (only between actual polls)
            if (watchGroupIds.length > 1) await new Promise(r => setTimeout(r, 1000));
          }
        }, intervalMs);
        if (_G.watcherTimer && _G.watcherTimer.unref) _G.watcherTimer.unref();
      }, 30000); // 30s delay for zalouser to connect
      if (_G.initTimer && _G.initTimer.unref) _G.initTimer.unref();
    }

    // ── Owner DM Command Handler ──────────────────────────────
    async function handleOwnerDm(content, senderId, ctx, cmdPrefix) {
      const slashMatch = content.match(/^(\/[a-z][a-z0-9-]*)(.*)$/i);
      if (!slashMatch) return null; // không phải lệnh → forward LLM

      const rawCommand = slashMatch[1].toLowerCase();
      if (!rawCommand.startsWith(cmdPrefix)) return null;
      const command = '/' + rawCommand.slice(cmdPrefix.length);
      const cmdArgs = slashMatch[2].trim();
      const args = cmdArgs ? cmdArgs.split(/\s+/) : [];

      if (command !== '/rules') return null; // chỉ xử lý /rules

      const sub = args[0]?.toLowerCase();
      if (!sub) {
        await sendDmMsg(ctx, senderId,
          `🔐 OWNER PANEL — ${cmdPrefix}rules\n━━━━━━━━━━━━━━━━━━\n\n🔇 Mute (tắt bot hoàn toàn):\n  ${cmdPrefix}rules mute-list\n  ${cmdPrefix}rules mute <groupId> on/off\n  ${cmdPrefix}rules mute all on/off\n\n🔕 Silent Mode (chỉ reply khi tag):\n  ${cmdPrefix}rules silent-list\n  ${cmdPrefix}rules silent <groupId> on/off\n  ${cmdPrefix}rules silent all on/off\n\n🎉 Welcome (chào mem mới):\n  ${cmdPrefix}rules welcome-list\n  ${cmdPrefix}rules welcome <groupId> on/off\n  ${cmdPrefix}rules welcome all on/off\n\n📋 Tracking (ghi lịch sử chat):\n  ${cmdPrefix}rules tracking-list\n  ${cmdPrefix}rules tracking <groupId> on/off\n  ${cmdPrefix}rules tracking all on/off\n\n👁️ Follow (theo dõi chat + memory):\n  ${cmdPrefix}rules follow-list\n  ${cmdPrefix}rules follow <groupId> on/off\n  ${cmdPrefix}rules follow all on/off\n\n💬 DM Whitelist:\n  ${cmdPrefix}rules dm-list\n  ${cmdPrefix}rules dm-add <tên member>\n  ${cmdPrefix}rules dm-remove <tên member>\n\n🆔 Group:\n  ${cmdPrefix}rules groupid-list\n  ${cmdPrefix}rules groupid-add <groupId>\n\n📊 ${cmdPrefix}rules status`
        );
        return { handled: true };
      }

      // ── mute-list: danh sách groups + trạng thái mute
      if (sub === 'mute-list') {
        const lines = ['🔇 MUTE PER-GROUP\n━━━━━━━━━━━━━━━━━━'];
        for (const gId of watchGroupIds) {
          const name = getGroupName(gId);
          const muted = store.getSetting(gId, 'muted', false);
          lines.push(`${muted ? '🔇' : '🔊'} ${name}\n   ID: ${gId} | ${muted ? 'MUTED' : 'Active'}`);
        }
        if (watchGroupIds.length === 0) lines.push('⚠️ Chưa có group nào. Dùng /groupid trong group để quét.');
        await sendDmMsg(ctx, senderId, lines.join('\n'));
        return { handled: true };
      }

      // ── mute all on/off
      if (sub === 'mute' && args[1]?.toLowerCase() === 'all') {
        const toggle = args[2]?.toLowerCase();
        if (toggle === 'on' || toggle === 'off') {
          const val = toggle === 'on';
          for (const gId of watchGroupIds) { store.setSetting(gId, 'muted', val); }
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `${val ? '🔇' : '🔊'} Mute ${val ? 'BẬT' : 'TẮT'} cho TẤT CẢ ${watchGroupIds.length} groups`);
        } else {
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules mute all on/off');
        }
        return { handled: true };
      }

      // ── mute <groupId> on/off
      if (sub === 'mute' && args[1]) {
        const targetGid = args[1].replace(/^<|>$/g, ''); // strip <>
        const toggle = args[2]?.toLowerCase();
        if (toggle === 'on') {
          store.setSetting(targetGid, 'muted', true);
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `🔇 Mute BẬT cho ${getGroupName(targetGid)} (${targetGid})\nBot sẽ im lặng hoàn toàn trong group này.`);
        } else if (toggle === 'off') {
          store.setSetting(targetGid, 'muted', false);
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `🔊 Mute TẮT cho ${getGroupName(targetGid)} (${targetGid})\nBot hoạt động bình thường trở lại.`);
        } else {
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules mute <groupId> on/off');
        }
        return { handled: true };
      }

      
      // ── silent-list
      if (sub === 'silent-list') {
        const lines = ['🔕 SILENT MODE PER-GROUP\n━━━━━━━━━━━━━━━━━━'];
        for (const gId of watchGroupIds) {
          const name = getGroupName(gId);
          const silent = store.getSetting(gId, 'silent', true);
          lines.push(`${silent ? '🔕' : '🔊'} ${name}\n   ID: ${gId} | ${silent ? 'BẬT' : 'TẮT'}`);
        }
        if (watchGroupIds.length === 0) lines.push('⚠️ Chưa có group nào.');
        await sendDmMsg(ctx, senderId, lines.join('\n'));
        return { handled: true };
      }

      // ── silent all on/off
      if (sub === 'silent' && args[1]?.toLowerCase() === 'all') {
        const toggle = args[2]?.toLowerCase();
        if (toggle === 'on' || toggle === 'off') {
          const val = toggle === 'on';
          for (const gId of watchGroupIds) { store.setSetting(gId, 'silent', val); }
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `${val ? '🔕' : '🔊'} Silent mode ${val ? 'BẬT' : 'TẮT'} cho TẤT CẢ ${watchGroupIds.length} groups`);
        } else {
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules silent all on/off');
        }
        return { handled: true };
      }

      // ── silent <groupId> on/off
      if (sub === 'silent' && args[1]) {
        const targetGid = args[1].replace(/^<|>$/g, '');
        const toggle = args[2]?.toLowerCase();
        if (toggle === 'on') {
          store.setSetting(targetGid, 'silent', true);
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `🔕 Silent mode BẬT cho ${getGroupName(targetGid)} (${targetGid})`);
        } else if (toggle === 'off') {
          store.setSetting(targetGid, 'silent', false);
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `🔊 Silent mode TẮT cho ${getGroupName(targetGid)} (${targetGid})`);
        } else {
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules silent <groupId> on/off');
        }
        return { handled: true };
      }

      // ── welcome-list: danh sách groups + trạng thái welcome
      if (sub === 'welcome-list') {
        const lines = ['🎉 WELCOME PER-GROUP\n━━━━━━━━━━━━━━━━━━'];
        for (const gId of watchGroupIds) {
          const name = getGroupName(gId);
          const on = store.getSetting(gId, 'welcome', true);
          const memberCount = _memberDir[gId] ? Object.keys(_memberDir[gId]).length : '?';
          lines.push(`${on ? '✅' : '❌'} ${name}\n   ID: ${gId} | Members: ${memberCount}`);
        }
        if (watchGroupIds.length === 0) lines.push('⚠️ Chưa có group nào. Dùng /groupid trong group để quét.');
        await sendDmMsg(ctx, senderId, lines.join('\n'));
        return { handled: true };
      }

      // ── welcome all on/off
      if (sub === 'welcome' && args[1]?.toLowerCase() === 'all') {
        const toggle = args[2]?.toLowerCase();
        if (toggle === 'on' || toggle === 'off') {
          const val = toggle === 'on';
          for (const gId of watchGroupIds) { store.setSetting(gId, 'welcome', val); }
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `${val ? '🎉' : '🔕'} Welcome ${val ? 'BẬT' : 'TẮT'} cho TẤT CẢ ${watchGroupIds.length} groups`);
        } else {
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules welcome all on/off');
        }
        return { handled: true };
      }

      // ── welcome <groupId> on/off
      if (sub === 'welcome' && args[1]) {
        const targetGid = args[1].replace(/^<|>$/g, ''); // strip <>
        const toggle = args[2]?.toLowerCase();
        if (toggle === 'on') {
          store.setSetting(targetGid, 'welcome', true);
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `✅ Welcome BẬT cho ${getGroupName(targetGid)} (${targetGid})`);
        } else if (toggle === 'off') {
          store.setSetting(targetGid, 'welcome', false);
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `✅ Welcome TẮT cho ${getGroupName(targetGid)} (${targetGid})`);
        } else {
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules welcome <groupId> on/off');
        }
        return { handled: true };
      }

      
      // ── tracking-list
      if (sub === 'tracking-list') {
        const lines = ['📋 TRACKING PER-GROUP\n━━━━━━━━━━━━━━━━━━'];
        for (const gId of watchGroupIds) {
          const name = getGroupName(gId);
          const tracking = store.getSetting(gId, 'tracking', false);
          lines.push(`${tracking ? '✅' : '❌'} ${name}\n   ID: ${gId} | Tracking: ${tracking ? 'BẬT' : 'TẮT'}`);
        }
        if (watchGroupIds.length === 0) lines.push('⚠️ Chưa có group nào.');
        await sendDmMsg(ctx, senderId, lines.join('\n'));
        return { handled: true };
      }

      // ── tracking all on/off
      if (sub === 'tracking' && args[1]?.toLowerCase() === 'all') {
        const toggle = args[2]?.toLowerCase();
        if (toggle === 'on' || toggle === 'off') {
          const val = toggle === 'on';
          for (const gId of watchGroupIds) { store.setSetting(gId, 'tracking', val); }
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `${val ? '✅' : '❌'} Tracking ${val ? 'BẬT' : 'TẮT'} cho TẤT CẢ ${watchGroupIds.length} groups`);
        } else {
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules tracking all on/off');
        }
        return { handled: true };
      }

      // ── tracking <groupId> on/off
      if (sub === 'tracking' && args[1]) {
        const targetGid = args[1].replace(/^<|>$/g, '');
        const toggle = args[2]?.toLowerCase();
        if (toggle === 'on') {
          store.setSetting(targetGid, 'tracking', true);
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `✅ Tracking BẬT cho ${getGroupName(targetGid)} (${targetGid})`);
        } else if (toggle === 'off') {
          store.setSetting(targetGid, 'tracking', false);
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `✅ Tracking TẮT cho ${getGroupName(targetGid)} (${targetGid})`);
        } else {
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules tracking <groupId> on/off');
        }
        return { handled: true };
      }

      // ── dm-list: danh sách users được DM
      if (sub === 'dm-list') {
        if (allowedDmUsers.size === 0) {
          await sendDmMsg(ctx, senderId, '💬 DM Whitelist: TRỐNG\n\nTất cả mọi người đều có thể DM bot.\nDùng ${cmdPrefix}rules dm-add <tên> để giới hạn.');
        } else {
          const lines = [`💬 DM WHITELIST (${allowedDmUsers.size} users)\n━━━━━━━━━━━━━━━━━━`];
          for (const uid of allowedDmUsers) {
            // Tìm tên từ member directory
            let name = uid;
            for (const members of Object.values(_memberDir)) {
              if (members[uid]) { name = members[uid]; break; }
            }
            lines.push(`• ${name} (${uid})`);
          }
          lines.push('\n👑 Owner luôn được phép DM.');
          await sendDmMsg(ctx, senderId, lines.join('\n'));
        }
        return { handled: true };
      }

      // ── dm-add <tên member>
      if (sub === 'dm-add' && args.slice(1).length > 0) {
        const nameQuery = args.slice(1).join(' ');
        const matches = findUserByName(nameQuery);
        if (matches.length === 0) {
          await sendDmMsg(ctx, senderId, `❌ Không tìm thấy member tên "${nameQuery}" trong danh sách.\nDùng ${cmdPrefix}rules welcome-list để kiểm tra member directory.`);
        } else if (matches.length === 1) {
          const m = matches[0];
          allowedDmUsers.add(m.userId);
          // Lưu vào config
          await _patchOpenclawConfig(_openclawHome, {
            allowedDmUsers: [...allowedDmUsers]
          }, logger, true);
          await sendDmMsg(ctx, senderId, `✅ Đã thêm ${m.name} (${m.userId}) vào DM whitelist.`);
        } else {
          const lines = [`⚠️ Tìm thấy ${matches.length} kết quả cho "${nameQuery}":`];
          for (const m of matches.slice(0, 10)) {
            lines.push(`• ${m.name} — ID: ${m.userId} (${getGroupName(m.groupId)})`);
          }
          lines.push('\nVui lòng cung cấp tên chính xác hơn.');
          await sendDmMsg(ctx, senderId, lines.join('\n'));
        }
        return { handled: true };
      }

      // ── dm-remove <tên member>
      if (sub === 'dm-remove' && args.slice(1).length > 0) {
        const nameQuery = args.slice(1).join(' ');
        const matches = findUserByName(nameQuery).filter(m => allowedDmUsers.has(m.userId));
        if (matches.length === 0) {
          await sendDmMsg(ctx, senderId, `❌ Không tìm thấy "${nameQuery}" trong DM whitelist.`);
        } else if (matches.length === 1) {
          const m = matches[0];
          allowedDmUsers.delete(m.userId);
          await _patchOpenclawConfig(_openclawHome, {
            allowedDmUsers: [...allowedDmUsers]
          }, logger, true);
          await sendDmMsg(ctx, senderId, `✅ Đã xóa ${m.name} (${m.userId}) khỏi DM whitelist.`);
        } else {
          const lines = [`⚠️ Tìm thấy ${matches.length} kết quả trong whitelist:`];
          for (const m of matches.slice(0, 10)) {
            lines.push(`• ${m.name} — ID: ${m.userId}`);
          }
          lines.push('\nVui lòng cung cấp tên chính xác hơn.');
          await sendDmMsg(ctx, senderId, lines.join('\n'));
        }
        return { handled: true };
      }

      // ── follow-list: danh sách groups + trạng thái follow (theo dõi)
      if (sub === 'follow-list') {
        const lines = ['👁️ FOLLOW PER-GROUP (theo dõi chat + memory)\n━━━━━━━━━━━━━━━━━━'];
        for (const gId of watchGroupIds) {
          const name = getGroupName(gId);
          const on = store.getSetting(gId, 'follow', true);
          const tracking = store.getSetting(gId, 'tracking', false);
          lines.push(`${on ? '✅' : '❌'} ${name}\n   ID: ${gId} | Tracking: ${tracking ? 'BẬT' : 'TẮT'}`);
        }
        if (watchGroupIds.length === 0) lines.push('⚠️ Chưa có group nào.');
        lines.push('\n💡 Follow = lưu memory + chat-log cho group đó.');
        await sendDmMsg(ctx, senderId, lines.join('\n'));
        return { handled: true };
      }

      // ── follow all on/off
      if (sub === 'follow' && args[1]?.toLowerCase() === 'all') {
        const toggle = args[2]?.toLowerCase();
        if (toggle === 'on' || toggle === 'off') {
          const val = toggle === 'on';
          for (const gId of watchGroupIds) {
            store.setSetting(gId, 'follow', val);
            store.setSetting(gId, 'tracking', val);
          }
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `${val ? '👁️' : '🚫'} Follow ${val ? 'BẬT' : 'TẮT'} cho TẤT CẢ ${watchGroupIds.length} groups`);
        } else {
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules follow all on/off');
        }
        return { handled: true };
      }

      // ── follow <groupId> on/off
      if (sub === 'follow' && args[1]) {
        const targetGid = args[1].replace(/^<|>$/g, ''); // strip <>
        const toggle = args[2]?.toLowerCase();
        if (toggle === 'on') {
          store.setSetting(targetGid, 'follow', true);
          store.setSetting(targetGid, 'tracking', true); // follow bật = tracking bật
          await store.saveSettings();
          // Bootstrap memory dir ngay lập tức
          const mDir = getMemoryDir(targetGid);
          try {
            await fs.mkdir(mDir, { recursive: true });
            const idxPath = path.join(mDir, 'INDEX.md');
            try { await fs.access(idxPath); } catch {
              const indexContent = [
                `# ${getGroupName(targetGid)} \u2014 Memory`, '',
                '> Auto-generated by openclaw-zalo-mod plugin.', '',
                '## Files',
                '- `chat-log.md` \u2014 L\u1ecbch s\u1eed chat nh\u00f3m',
                '- `chat-highlights.md` \u2014 @mention quan tr\u1ecdng',
                '- `members.md` \u2014 Warn log',
                '- `violations.md` \u2014 Vi ph\u1ea1m', '',
              ].join('\n');
              await fs.writeFile(idxPath, indexContent, 'utf8');
            }
          } catch { /* ok */ }
          await sendDmMsg(ctx, senderId, `✅ Follow BẬT cho ${getGroupName(targetGid)} (${targetGid})\n📁 Memory: ${getMemorySlug(targetGid)}/`);
        } else if (toggle === 'off') {
          store.setSetting(targetGid, 'follow', false);
          store.setSetting(targetGid, 'tracking', false);
          await store.saveSettings();
          await sendDmMsg(ctx, senderId, `✅ Follow TẮT cho ${getGroupName(targetGid)} (${targetGid})`);
        } else {
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules follow <groupId> on/off');
        }
        return { handled: true };
      }

      // ── status: tổng quan
      if (sub === 'status') {
        const mutedOn = watchGroupIds.filter(gId => store.getSetting(gId, 'muted', false)).length;
        const welcomeOn = watchGroupIds.filter(gId => store.getSetting(gId, 'welcome', true)).length;
        const followOn = watchGroupIds.filter(gId => store.getSetting(gId, 'follow', true)).length;
        const totalMembers = Object.values(_memberDir).reduce((sum, m) => sum + Object.keys(m).length, 0);
        await sendDmMsg(ctx, senderId,
          `🔐 OWNER STATUS\n━━━━━━━━━━━━━━━━━━\n📡 Groups: ${watchGroupIds.length}\n🔇 Muted: ${mutedOn} group(s)\n🎉 Welcome: ${welcomeOn} bật\n👁️ Follow: ${followOn} bật\n👥 Members tracked: ${totalMembers}\n💬 DM whitelist: ${allowedDmUsers.size === 0 ? 'Tất cả' : allowedDmUsers.size + ' users'}\n🤖 Bot: ${botName}`
        );
        return { handled: true };
      }

      // ── groupid-list: liệt kê tất cả groups
      if (sub === 'groupid-list') {
        const lines = ['🆔 DANH SÁCH GROUPS\n━━━━━━━━━━━━━━━━━━'];
        for (const gId of watchGroupIds) {
          const name = getGroupName(gId);
          const muted = store.getSetting(gId, 'muted', false);
          lines.push(`${muted ? '🔇' : '🔊'} ${name}\n   ID: ${gId}`);
        }
        if (watchGroupIds.length === 0) lines.push('⚠️ Chưa có group nào. Gõ ${cmdPrefix}rules groupid trong group để thêm.');
        lines.push(`\n📊 Tổng: ${watchGroupIds.length} group(s)`);
        await sendDmMsg(ctx, senderId, lines.join('\n'));
        return { handled: true };
      }

      // ── groupid-add <groupId>: thêm group bằng ID từ DM
      if (sub === 'groupid-add' && args[1]) {
        const targetGid = args[1].replace(/^<|>$/g, ''); // strip <>
        const gName = args.slice(2).join(' ') || `Group ${targetGid.slice(-6)}`;
        const newEntry = { name: gName, admins: [], creatorId: '' };
        // Merge vào groupNames hiện tại
        const mergedNames = { ...(pluginCfg.groupNames || {}), [targetGid]: newEntry };
        const patched = await _patchOpenclawConfig(_openclawHome, { groupNames: mergedNames }, logger, true);
        if (patched) {
          if (!watchGroupIds.includes(targetGid)) watchGroupIds.push(targetGid);
          groupNames[targetGid] = newEntry;
        }
        // Sync admins từ ZCA API (creatorId + adminIds)
        const zcaInfo = await syncGroupAdminsFromZCA(targetGid);
        const adminNames = getGroupAdminNames(targetGid);
        const adminLine = adminNames.length > 0
          ? `👑 Admins: ${adminNames.join(', ')}`
          : '👑 Admin: chưa sync được (ZCA unavailable)';
        const memberLine = zcaInfo ? `👥 Members: ${zcaInfo.totalMember}` : '';
        _invalidateZcaApi(); // Hủy ZCA session ngay sau khi dùng xong
        if (patched) {
          await sendDmMsg(ctx, senderId, `✅ Đã thêm group: ${zcaInfo?.name || gName}\n🆔 ID: ${targetGid}\n${adminLine}${memberLine ? '\n' + memberLine : ''}\n🔄 Restart gateway để áp dụng.`);
        } else {
          await sendDmMsg(ctx, senderId, `ℹ️ Group đã có trong config rồi.\n🆔 ID: ${targetGid}\n${adminLine}${memberLine ? '\n' + memberLine : ''}`);
        }
        return { handled: true };
      }
      if (sub === 'groupid-add' && !args[1]) {
        await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: ${cmdPrefix}rules groupid-add <groupId>');
        return { handled: true };
      }

      return null; // lệnh ${cmdPrefix}rules không nhận ra → forward LLM
    }

    // ── Event: before_dispatch (main hook) ───────────────────
    api.on('before_dispatch', async (event, ctx) => {
      // 1. Chỉ bắt event từ Zalo
      console.log('[ZALO-MOD-DEBUG] ctx:', JSON.stringify(ctx||{})); console.log('[ZALO-MOD-DEBUG] body:', event?.body); if (ctx?.channelId !== 'zalouser' && ctx?.channel !== 'zalouser') { console.log('[ZALO-MOD-DEBUG] ignored! channelId:', ctx?.channelId); return; }
      
      // NOTE: Zalo strips @mention from event.content but keeps it in event.body
      const content = String(event?.body || event?.content || '').trim();

      await ensureStore();

      // NOTE: Welcome detection is handled by the member watcher (polling-based).
      // OpenClaw zalouser channel does NOT pass system events (join/leave) to plugins.
      // NOTE: Sticker/image/file messages in groups are silently dropped by zalouser channel core
      // — they never reach before_dispatch. Only text messages are forwarded.

      if (!content) return { handled: true }; // empty content — skip

      // ── Sticker/media detection ──────────────────────────────
      // Zalo sends stickers as JSON: {"id":21532,"catId":10306,"type":7}
      // Transform to human-readable so agent doesn't try parsing raw JSON
      try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && parsed.id && parsed.catId && parsed.type) {
          event.body = '[Sticker]';
          if (event.content) event.content = '[Sticker]';
        }
      } catch (_) { /* not JSON, normal text — continue */ }

      const rawConvId = String(ctx.conversationId || event.conversationId || '');
      const isGroupMsg = rawConvId.startsWith('group:');
      const senderId  = String(ctx.senderId || event.senderId || '');
      const senderName = String(event.senderName || senderId);

      // ── DM Flow — Owner config + whitelist gating ──────────
      if (!isGroupMsg) {
        // /ownerid — intercept from ANY DM user (before owner gate)
        // Allows first user to claim ownership when ownerId is empty
        const lcContent = content.toLowerCase().trim();
        const ownerIdMatch = lcContent === `${cmdPrefix}ownerid` || lcContent.replace(/['’]/g, '') === "im admin";
        if (ownerIdMatch) {
          if (!ownerId) {
            // Chưa có owner → auto-claim sender
            const patch = { ownerId: senderId };
            const patched = await _patchOpenclawConfig(_openclawHome, patch, logger, true);
            if (patched) {
              await sendDmMsg(ctx, senderId,
                `✅ Đã đăng ký bạn làm Owner!\n👑 Owner ID: ${senderId}\n🔄 Restart gateway để áp dụng.`
              );
            } else {
              await sendDmMsg(ctx, senderId,
                `⚠️ Không thể ghi config. Thêm thủ công:\n"ownerId": "${senderId}"\nvào plugins.entries.${PLUGIN_ID}.config`
              );
            }
          } else {
            // Đã có owner → trả về info
            await sendDmMsg(ctx, senderId, `👑 Owner ID của bot là:\n\n${ownerId}`);
          }
          return { handled: true };
        }

        // Owner DM → config commands hoặc forward LLM
        if (ownerId && senderId === ownerId) {
          const ownerResult = await handleOwnerDm(content, senderId, ctx, cmdPrefix);
          if (ownerResult) return ownerResult;
          return; // forward to LLM
        }

        // Allowed user → forward to LLM
        if (allowedDmUsers.size === 0 || allowedDmUsers.has(senderId)) return;

        // Không nằm trong whitelist → block im lặng
        logger.info(`[openclaw-zalo-mod] DM blocked from ${senderName} (${senderId}) — not in allowedDmUsers`);
        return { handled: true };
      }

      const groupId = rawConvId.replace(/^group:/, '');

      // ── MUTE CHECK — first gate, before everything else ───
      const isMuted = store.getSetting(groupId, 'muted', false);
      if (isMuted) {
        // Only allow /unmute from admin to pass through
        const unmuteMatch = content.match(new RegExp(`^${cmdPrefix}(unmute|bat-bot)$`, "i"));
        if (unmuteMatch && isAdmin(senderId, groupId)) {
          store.setSetting(groupId, 'muted', false);
          await store.saveSettings();
          logger.info(`[openclaw-zalo-mod] group ${groupId} UNMUTED by ${senderName}`);
          await sendGroupMsg(ctx, groupId, '🔊 Bot đã bật lại trong group này!');
          return { handled: true };
        }
        // Muted → ignore everything silently
        return { handled: true };
      }

      // ── Extract slash command from anywhere in message ─────
      // Support: "/command args" AND "@BotName text /command args"
      const slashMatch = content.match(/(?:^|\s)(\/[a-z][a-z0-9-]*)(.*)$/i);
      if (slashMatch) {
        const rawCommand = slashMatch[1].toLowerCase();
        // Slash command thuộc bot khác (prefix không match) → chặn, không để LLM reply
        // (tránh trường hợp 2 bot cùng group: /williams-noi-quy lọt vào Mkt và LLM của Mkt trả lời)
        if (!rawCommand.startsWith(cmdPrefix)) return { handled: true };
        const command = '/' + rawCommand.slice(cmdPrefix.length);
        const cmdArgs = slashMatch[2].trim();
        const args    = cmdArgs ? cmdArgs.split(/\s+/) : [];
        // Text before the slash command (e.g. "@Bot mai 5h @Mkt đi đá banh /note" → "mai 5h @Mkt đi đá banh")
        const botMentionRe = new RegExp(botNames.map(n => '@' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
        const textBefore = content.slice(0, slashMatch.index + (slashMatch[0].startsWith(' ') ? 1 : 0)).trim()
          .replace(botMentionRe, '').replace(/\s{2,}/g, ' ').trim(); // strip only bot @mentions

        // /noi-quy (nội quy)
        if (command === '/noi-quy') {
          await sendGroupMsg(ctx, groupId, buildNoiQuy(getGroupName(groupId), botName, cmdPrefix));
          return { handled: true };
        }

        // /mute — admin only: tắt bot hoàn toàn trong group
        if (command === '/mute' || command === '/tat-bot') {
          if (!isAdmin(senderId, groupId)) return { handled: true };
          store.setSetting(groupId, 'muted', true);
          await store.saveSettings();
          logger.info(`[openclaw-zalo-mod] group ${groupId} MUTED by ${senderName}`);
          await sendGroupMsg(ctx, groupId, `🔇 Bot đã tắt trong group này.\nGõ ${cmdPrefix}unmute để bật lại.`);
          return { handled: true };
        }

        // /unmute — admin only: bật lại bot (also handled in mute gate above, but kept here for non-muted state)
        if (command === '/unmute' || command === '/bat-bot') {
          if (!isAdmin(senderId, groupId)) return { handled: true };
          store.setSetting(groupId, 'muted', false);
          await store.saveSettings();
          await sendGroupMsg(ctx, groupId, '🔊 Bot đang hoạt động bình thường!');
          return { handled: true };
        }

        // /menu | /huong-dan
        if (command === '/menu') {
          let menu = buildMenu(botName, cmdPrefix);
          // Nếu sender là owner → hiện thêm owner commands
          if (ownerId && senderId === ownerId) {
            menu += `\n\n👑 OWNER (DM riêng với bot):\n  ${cmdPrefix}rules groupid-list\n  ${cmdPrefix}rules groupid-add <groupId> [tên]\n  ${cmdPrefix}rules — Panel cấu hình\n  ${cmdPrefix}rules status — Tổng quan`;
          }
          await sendGroupMsg(ctx, groupId, menu);
          return { handled: true };
        }
        if (command === '/huong-dan') {
          await sendGroupMsg(ctx, groupId, buildHuongDan(botName, cmdPrefix));
          return { handled: true };
        }

        // ${cmdPrefix}rules groupid — quét TẤT CẢ groups từ session, sync ZCA, auto-enable welcome/follow
        if (command === '/rules' && cmdArgs.toLowerCase().startsWith('groupid')) {
          try {
            await sendGroupMsg(ctx, groupId, '🔍 Đang quét tất cả groups từ session...');

            // 1. Scan tất cả groups từ session data
            const agentId = cfg?.agents?.list?.[0]?.id;
            const sessionGroups = await _scanGroupsFromSessions(_openclawHome, agentId);

            // Merge group hiện tại nếu chưa có trong session
            const currentInSession = sessionGroups.some(g => g.groupId === groupId);
            if (!currentInSession) {
              sessionGroups.push({ groupId, groupName: getGroupName(groupId) !== 'Nhóm' ? getGroupName(groupId) : `Group-${groupId.slice(-6)}` });
            }

            // 2. Build groupNames + gọi ZCA cho mỗi group
            const mergedNames = { ...(pluginCfg.groupNames || {}) };
            const results = [];
            let autoEnabled = 0;

            for (const g of sessionGroups) {
              const gId = g.groupId;
              // Tạo entry nếu chưa có
              if (!mergedNames[gId] || typeof mergedNames[gId] === 'string') {
                mergedNames[gId] = { name: (typeof mergedNames[gId] === 'string' ? mergedNames[gId] : g.groupName) || '', admins: [], creatorId: '' };
              }

              // Gọi ZCA lấy admin info
              const zcaInfo = await fetchGroupAdminsFromZCA(gId);
              if (zcaInfo) {
                const allAdmins = new Set(mergedNames[gId].admins || []);
                if (zcaInfo.creatorId) allAdmins.add(String(zcaInfo.creatorId));
                for (const id of zcaInfo.adminIds) allAdmins.add(String(id));
                mergedNames[gId].admins = [...allAdmins];
                mergedNames[gId].creatorId = zcaInfo.creatorId || '';
                if (zcaInfo.name) mergedNames[gId].name = zcaInfo.name;

                // Cập nhật settings.json
                store.setSetting(gId, 'groupAdmins', [...allAdmins]);
                store.setSetting(gId, 'creatorId', zcaInfo.creatorId);

                // 3. Auto-enable welcome + follow nếu ownerId là admin/creator của group
                const ownerIsAdmin = allAdmins.has(ownerId);
                if (ownerIsAdmin) {
                  store.setSetting(gId, 'welcome', true);
                  store.setSetting(gId, 'follow', true);
                  store.setSetting(gId, 'tracking', true);
                  autoEnabled++;
                  results.push(`✅ ${mergedNames[gId].name}\n   ID: ${gId} | 👥 ${zcaInfo.totalMember} | 🎉 welcome+follow BẬT`);
                } else {
                  results.push(`⬜ ${mergedNames[gId].name}\n   ID: ${gId} | 👥 ${zcaInfo.totalMember} | ⏸️ owner không phải admin`);
                }
              } else {
                results.push(`⚠️ ${mergedNames[gId].name || gId}\n   ID: ${gId} | ZCA unavailable`);
              }
            }

            // 4. Detect bot name nếu chưa có
            const patch = { groupNames: mergedNames };
            if (!pluginCfg.botName || pluginCfg.botName === 'Bot') {
              const detectedName = await _readBotNameFromIdentity(workspaceDir);
              if (detectedName) {
                patch.botName = detectedName;
                patch.zaloDisplayNames = [detectedName];
              }
            }

            // 5. Persist
            await _patchOpenclawConfig(_openclawHome, patch, logger, true);
            await store.saveSettings();
            _invalidateZcaApi(); // Hủy ZCA session ngay sau batch

            // Update in-memory
            for (const [gId, entry] of Object.entries(mergedNames)) {
              groupNames[gId] = entry;
              if (!watchGroupIds.includes(gId)) watchGroupIds.push(gId);
            }

            // 6. Report
            const report = [
              `📡 QUÉT GROUPS HOÀN TẤT`,
              `━━━━━━━━━━━━━━━━━━`,
              ...results,
              ``,
              `📊 Tổng: ${sessionGroups.length} groups`,
              `🎉 Auto-enabled: ${autoEnabled} groups (owner là admin)`,
              `🔄 Restart gateway để áp dụng.`
            ].join('\n');
            await sendGroupMsg(ctx, groupId, report);

          } catch (e) {
            logger.warn(`[openclaw-zalo-mod] ${cmdPrefix}rules groupid failed: ${e.message}`);
            await sendGroupMsg(ctx, groupId, `🆔 Group ID: ${groupId}\n⚠️ Lỗi: ${e.message}`);
          }
          return { handled: true };
        }

        // /report — admin only
        if (command === '/report') {
          if (!isAdmin(senderId, groupId)) return { handled: true };
          await reloadStore();
          const vio = getStoreDataForGroup(store.getAllViolations(), groupId);
          const wrn = getStoreDataForGroup(store.getAllWarned(), groupId);
          const text = buildReport(groupId, vio, wrn);
          await sendGroupMsg(ctx, groupId, text);
          return { handled: true };
        }

        // /warn @name [reason] — admin only
        if (command === '/warn') {
          if (!isAdmin(senderId, groupId)) return { handled: true };
          const targetMentions = (event.mentions || []);
          // Strip leading @ from args since Zalo body includes @name
          const rawTarget  = (args[0] || '').replace(/^@/, '');
          const targetId   = (targetMentions[0]?.uid || rawTarget || '').replace(/^@/, '');
          const targetName = (targetMentions[0]?.name || rawTarget || targetId).replace(/^@/, '');
          const reasonArgs = args.slice(1);
          const reason     = reasonArgs.join(' ').trim() || 'Vui lòng giữ nội dung phù hợp group';
          if (!targetId) return { handled: true };
          store.addWarn(groupId, targetId, targetName, reason);
          await store.saveWarned();
          const warnCount = store.getWarnCount(groupId, targetId);
          const kickNote  = warnCount >= 3 ? '\n⛔ Đã warn 3 lần — cân nhắc kick.' : '';
          // Sync to memory
          await appendToMemoryFile(groupId, 'members.md', `| ${targetName} | ${warnCount} | ${reason} | ${nowShort()} |`);
          await appendToMemoryFile(groupId, 'chat-highlights.md', `| ${nowShort()} | Admin | /warn ${targetName}: ${reason} |`);
          await sendGroupMsg(ctx, groupId,
            `⚠️ ${targetName} — ${reason}.\nLần tiếp theo admin sẽ xử lý.${kickNote}\n✅ Đã ghi nhận. Lần ${warnCount}.`
          );
          return { handled: true };
        }

        // /note [text] — admin only
        if (command === '/note') {
          if (!isAdmin(senderId, groupId)) return { handled: true };
          const noteText = textBefore || args.join(' ');
          if (!noteText) return { handled: true };
          store.addViolation(groupId, 'admin-note', senderName, 'note', noteText);
          await store.saveViolations();
          // Sync to memory
          await appendToMemoryFile(groupId, 'admin-notes.md', `| ${nowShort()} | ${senderName} | ${noteText} |`);
          await sendGroupMsg(ctx, groupId, `📝 Ghi nhận: ${noteText}`);
          return { handled: true };
        }

        // ${cmdPrefix}rules — owner-only control panel
        if (command === '/rules') {
          if (!ownerId || senderId !== ownerId) return { handled: true };
          const sub = args[0]?.toLowerCase();
          if (!sub) {
            await sendGroupMsg(ctx, groupId,
              `⚙️ ADMIN COMMANDS — ${cmdPrefix}rules\n━━━━━━━━━━━━━━━━━━\n\n🔇 Mute (tắt bot hoàn toàn):\n  /mute   — Tắt bot\n  /unmute — Bật lại\n\n🔕 Silent Mode:\n  ${cmdPrefix}rules silent-on  — Bot chỉ reply khi @tag\n  ${cmdPrefix}rules silent-off — Bot reply mọi tin\n\n🎉 Welcome:\n  ${cmdPrefix}rules welcome-on  — Bật chào member mới\n  ${cmdPrefix}rules welcome-off — Tắt chào\n\n📋 Tracking:\n  ${cmdPrefix}rules tracking-on  — Bật ghi lịch sử chat\n  ${cmdPrefix}rules tracking-off — Tắt ghi lịch sử\n\n📊 ${cmdPrefix}rules status`
            );
            return { handled: true };
          }
          if (sub === 'silent-on')  { store.setSetting(groupId, 'silent', true);  await store.saveSettings(); await sendGroupMsg(ctx, groupId, '✅ Silent mode: BẬT'); return { handled: true }; }
          if (sub === 'silent-off') { store.setSetting(groupId, 'silent', false); await store.saveSettings(); await sendGroupMsg(ctx, groupId, '✅ Silent mode: TẮT'); return { handled: true }; }
          if (sub === 'welcome-on')  { store.setSetting(groupId, 'welcome', true);  await store.saveSettings(); await sendGroupMsg(ctx, groupId, '✅ Welcome: BẬT'); return { handled: true }; }
          if (sub === 'welcome-off') { store.setSetting(groupId, 'welcome', false); await store.saveSettings(); await sendGroupMsg(ctx, groupId, '✅ Welcome: TẮT'); return { handled: true }; }
          if (sub === 'tracking-on')  { store.setSetting(groupId, 'tracking', true);  await store.saveSettings(); await sendGroupMsg(ctx, groupId, '✅ Tracking lịch sử chat: BẬT\n📋 Mọi tin nhắn trong group sẽ được ghi vào chat-log.md'); return { handled: true }; }
          if (sub === 'tracking-off') { store.setSetting(groupId, 'tracking', false); await store.saveSettings(); await sendGroupMsg(ctx, groupId, '✅ Tracking lịch sử chat: TẮT'); return { handled: true }; }
          if (sub === 'status') {
            const muted    = store.getSetting(groupId, 'muted', false);
            const silent   = store.getSetting(groupId, 'silent', true);
            const welcome  = store.getSetting(groupId, 'welcome', true);
            const tracking = store.getSetting(groupId, 'tracking', false);
            await sendGroupMsg(ctx, groupId,
              `⚙️ CẤU HÌNH BOT\n━━━━━━━━━━━━━━━━━━\n🔇 Mute: ${muted ? 'BẬT (bot im lặng hoàn toàn)' : 'TẮT'}\n🔕 Silent Mode: ${silent ? 'BẬT' : 'TẮT'}\n🎉 Welcome: ${welcome ? 'BẬT' : 'TẮT'}\n📋 Tracking: ${tracking ? 'BẬT' : 'TẮT'}`
            );
            return { handled: true };
          }
          // Fallback: sub-command không nhận ra → báo lỗi thay vì nuốt im lặng
          await sendGroupMsg(ctx, groupId, `⚠️ Lệnh ${cmdPrefix}rules ${sub} không hợp lệ.\nGõ ${cmdPrefix}rules để xem danh sách lệnh.`);
          return { handled: true };
        }

        // /memory — admin manual digest (optionally with note text)
        if (command === '/memory') {
          if (!isAdmin(senderId, groupId)) return { handled: true };
          const memText = (textBefore || args.join(' ')).replace(/\s{2,}/g, ' ').trim();
          if (memText) {
            store.addViolation(groupId, 'admin-note', senderName, 'note', memText);
            await store.saveViolations();
            await appendToMemoryFile(groupId, 'admin-notes.md', `| ${nowShort()} | ${senderName} | ${memText} |`);
          }
          await reloadStore(); // Fresh read from disk
          const { warnCount, vioCount } = await writeMemoryDigest(groupId);
          const extra = memText ? `\n📝 Note: ${memText}` : '';
          await sendGroupMsg(ctx, groupId,
            `📝 Đã lưu memory digest!${extra}\n📁 ${getMemorySlug(groupId)}/\n⚠️ ${warnCount} member đã cảnh cáo\n🚫 ${vioCount} vi phạm ghi nhận`
          );
          return { handled: true };
        }


        // Unknown slash — block from LLM (prevent error replies)
        return { handled: true };
      }

      // ── @Mention check — let through to LLM ──────────────
      const isMention = isMessageMentioningBot(event, botNames);
      if (isMention) {
        // Log mention + sync to memory
        logger.info(`[openclaw-zalo-mod] @mention from ${senderName} in group ${groupId}: ${content.slice(0, 80)}`);
        await appendToMemoryFile(groupId, 'chat-highlights.md', `| ${nowShort()} | ${senderName} | ${content.slice(0, 80)} |`);

        // Tracking: ghi cả @mention vào chat-log
        if (store.getSetting(groupId, 'tracking', false)) {
          await appendChatLog(groupId, senderName, content);
        }

        // ── File context injection ─────────────────────────────
        // OpenClaw zalouser ONLY forwards text to before_dispatch — file types are silently dropped.
        // When user @mentions bot about a file/image, inject a system note so the LLM
        // knows to ask for a link instead of hallucinating "chưa thấy file".
        const FILE_KEYWORDS_RE = /\b(file|pdf|ảnh|hình\s*ảnh|tài\s*liệu|doc|docx|xlsx?|excel|video|mp4|zip|rar|link|tải|download|attachment|đính\s*kèm|xem\s*file|đọc\s*file)\b/i;
        if (FILE_KEYWORDS_RE.test(content)) {
          const note = '\n[BOT SYSTEM NOTE: Đây là Group Zalo. File/ảnh đính kèm KHÔNG được forward tới bot trong group — zalouser channel chỉ truyền text. Nếu user đang đề cập tới file, hãy hỏi user: (1) copy+paste link tải về, hoặc (2) paste nội dung text trực tiếp vào chat. KHÔNG nói "gửi file vào đây" vì user đã gửi rồi mà bot không nhận được.]';
          if (event.body !== undefined) event.body = content + note;
          if (event.content !== undefined) event.content = content + note;
          logger.info(`[openclaw-zalo-mod] injected file-context note for @mention in group ${groupId}`);
        }



        // ── Auto-answer group management questions locally (0 token) ──
        const lc = content.toLowerCase();

        // "Ai bị warn" / "warn ai" / "danh sách warn" / "list warn"
        if (/(?:ai.*warn|warn.*ai|danh.*s[áa]ch.*warn|list.*warn|ai.*b[ịi].*c[ảa]nh.*c[áa]o)/i.test(lc)) {
          const warns = store.getWarned(groupId);
          const entries = Object.entries(warns);
          if (!entries.length) {
            await sendGroupMsg(ctx, groupId, '✅ Hiện tại chưa có member nào bị warn trong group.');
          } else {
            const lines = ['⚠️ DANH SÁCH WARN\n━━━━━━━━━━━━━━━━━━'];
            for (const [uid, list] of entries) {
              const last = list[list.length - 1];
              const name = (last.name || uid).replace(/^@/, '');
              lines.push(`• ${name} — ${list.length} lần | Lý do: ${last.reason || '—'}`);
            }
            await sendGroupMsg(ctx, groupId, lines.join('\n'));
          }
          return { handled: true };
        }

        // "Vi phạm" / "violations" / "spam"
        if (/(?:vi.*ph[ạa]m|violation|spam.*g[ầa]n)/i.test(lc)) {
          const violations = store.getViolations(groupId);
          const allVio = [];
          for (const [uid, list] of Object.entries(violations)) {
            if (uid === 'admin-note') continue; // skip admin notes
            for (const v of list) allVio.push(v);
          }
          if (!allVio.length) {
            await sendGroupMsg(ctx, groupId, '✅ Chưa có vi phạm nào được ghi nhận.');
          } else {
            allVio.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
            const lines = [`🚫 VI PHẠM GẦN ĐÂY (${allVio.length} tổng)\n━━━━━━━━━━━━━━━━━━`];
            for (const v of allVio.slice(0, 5)) {
              const name = (v.name || '?').replace(/^@/, '');
              lines.push(`• ${name} — ${v.type} | ${(v.preview || '').slice(0, 30)}`);
            }
            await sendGroupMsg(ctx, groupId, lines.join('\n'));
          }
          return { handled: true };
        }

        // "admin" / "ai là admin"
        if (/(?:admin.*l[àa].*ai|ai.*l[àa].*admin)/i.test(lc)) {
          const admins = getGroupAdminNames(groupId);
          if (admins.length > 0) {
            await sendGroupMsg(ctx, groupId, `👑 Admin group này:\n${admins.map(n => `• ${n}`).join('\n')}`);
          } else {
            await sendGroupMsg(ctx, groupId, '👑 Chưa ghi nhận admin nào. Người tạo group gõ ${cmdPrefix}rules groupid để đăng ký.');
          }
          return { handled: true };
        }

        // For all other @mention questions → forward to LLM
        logger.info(`[openclaw-zalo-mod] forwarding to LLM: ${content.slice(0, 80)}`);
        return; // undefined = let LLM handle
      }

      // ── Silent mode check ─────────────────────────────────
      const silentMode = store.getSetting(groupId, 'silent', false);
      if (silentMode) {
        // Anti-spam detect silently even in silent mode
        const spamType = spamTracker.check(senderId, content);
        if (spamType) {
          store.addViolation(groupId, senderId, senderName, spamType, content);
          await store.saveViolations();
          // Sync to memory
          await appendToMemoryFile(groupId, 'violations.md', `| ${nowShort()} | ${senderName} | ${spamType} | ${content.slice(0, 40)} |`);
          logger.info(`[openclaw-zalo-mod] spam detected: ${spamType} from ${senderName}`);
        }
        // Tracking: ghi lịch sử chat (kể cả silent mode)
        if (store.getSetting(groupId, 'tracking', false)) {
          await appendChatLog(groupId, senderName, content);
        }
        return { handled: true }; // silent — don't forward to LLM
      }

      // Non-silent mode: still anti-spam detect
      const spamType = spamTracker.check(senderId, content);
      if (spamType) {
        store.addViolation(groupId, senderId, senderName, spamType, content);
        await store.saveViolations();
        // Sync to memory
        await appendToMemoryFile(groupId, 'violations.md', `| ${nowShort()} | ${senderName} | ${spamType} | ${content.slice(0, 40)} |`);
        logger.info(`[openclaw-zalo-mod] ❌ BLOCKED by anti-spam: type=${spamType} sender=${senderName} msg="${content.slice(0, 60)}"`);
        return { handled: true }; // spam always silently blocked
      }

      // Tracking: ghi lịch sử chat (non-silent, non-mention)
      if (store.getSetting(groupId, 'tracking', false)) {
        await appendChatLog(groupId, senderName, content);
      }

      // Non-mention, non-slash, non-spam, non-silent → let LLM decide
      return;
    }, { priority: 300 }); // priority 300 = runs before relay plugin (200)

    // ── Fallback: before_model_resolve + before_agent_reply ─────────────
    // OpenClaw v2026.5.x: runtime plugins cannot register gateway-level hooks.
    // before_dispatch is not fired for runtime plugins. Use agent-session hooks.
    const _adminClaims = globalThis.__zaloModAdminClaims ?? new Map();
    globalThis.__zaloModAdminClaims = _adminClaims;

    api.on('before_model_resolve', async (event, ctx) => {
      if (ctx?.channelId !== 'zalouser' && ctx?.channel !== 'zalouser') return;
      const lc = String(event?.prompt || '').toLowerCase().replace(/['']/g, '').trim();
      const ownerCmd = cmdPrefix + 'ownerid';
      if (lc !== 'im admin' && lc !== ownerCmd) return;
      const sKey = ctx?.sessionKey || 'default';
      const sId = String(ctx?.senderId || '');
      logger.info('[openclaw-zalo-mod] [ADMIN-FALLBACK] im admin from ' + sId + ' sKey=' + sKey);
      _adminClaims.set(sKey, { senderId: sId, ts: Date.now() });
    });

    api.on('before_agent_reply', async (event, ctx) => {
      if (ctx?.channelId !== 'zalouser' && ctx?.channel !== 'zalouser') return;
      const sKey = ctx?.sessionKey || 'default';
      const claim = _adminClaims.get(sKey);
      if (!claim || Date.now() - claim.ts > 60000) { _adminClaims.delete(sKey); return; }
      _adminClaims.delete(sKey);
      const { senderId } = claim;
      logger.info('[openclaw-zalo-mod] [ADMIN-FALLBACK] intercepting reply for ' + senderId);
      try {
        if (!ownerId) {
          const patched = await _patchOpenclawConfig(_openclawHome, { ownerId: senderId }, logger, true);
          await sendDmMsg(ctx, senderId, patched
            ? 'Sếp đã được đăng ký làm Owner! Owner ID: ' + senderId
            : 'Không thể ghi config. ownerId: ' + senderId);
        } else {
          await sendDmMsg(ctx, senderId, 'Owner ID của bot: ' + ownerId);
        }
      } catch (e) { logger.error('[openclaw-zalo-mod] [ADMIN-FALLBACK] error: ' + e.message); }
      return { handled: true };
    });
    // Start member watcher for welcome messages
    startMemberWatcher();

    logger.info(`[openclaw-zalo-mod] loaded — bot="${botName}" owner=${ownerId || 'none'} groups=${watchGroupIds.length} groupNames=${Object.keys(groupNames).length}`);
  },
});

export default plugin;