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
 * @version 2.8.0
 */

import fs from 'node:fs/promises';
import { chmodSync, readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import crypto from 'node:crypto';
import os from 'node:os';

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
    const entry = config.plugins.entries[PLUGIN_ID];
    entry.hooks = { ...(entry.hooks || {}), allowConversationAccess: true };
    const existing = entry.config || {};
    changed = true;

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

    // Auto-patch zalouser on disk to expose shared API instance
    try {
      const zalouserDist = path.join(_openclawHome, 'npm', 'node_modules', '@openclaw', 'zalouser', 'dist');
      if (existsSync(zalouserDist)) {
        for (const file of readdirSync(zalouserDist)) {
          if (file.startsWith('zalo-js-') && file.endsWith('.js')) {
            const p = path.join(zalouserDist, file);
            let content = readFileSync(p, 'utf8');
            if (content.includes('const apiByProfile = /* @__PURE__ */ new Map();') && 
                !content.includes('globalThis.__zcaApiByProfile = apiByProfile;')) {
              content = content.replace(
                'const apiByProfile = /* @__PURE__ */ new Map();', 
                'const apiByProfile = /* @__PURE__ */ new Map();\nglobalThis.__zcaApiByProfile = apiByProfile;'
              );
              writeFileSync(p, content, 'utf8');
              logger.info(`[openclaw-zalo-mod] auto-patched zalouser export in ${file}`);
            }
          }
        }
      }
    } catch (e) {
      logger.warn(`[openclaw-zalo-mod] failed to auto-patch zalouser export: ${e.message}`);
    }

    if (globalThis.__zcaApiByProfile) {
      logger.info('[openclaw-zalo-mod] detected shared ZCA API map from zalouser runtime');
    } else {
      logger.info('[openclaw-zalo-mod] shared ZCA API map not exposed by zalouser yet');
    }

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

    // Data dir — store JSON data outside the extensions folder to avoid hot-reloads
    const dataDir = path.join(_openclawHome, 'plugins-data', PLUGIN_ID);
    try { if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true }); } catch (e) {}

    const groupNamesFile = path.join(dataDir, 'group-names.json');
    let _rawGroupNames = {};
    try {
      if (existsSync(groupNamesFile)) {
        _rawGroupNames = JSON.parse(readFileSync(groupNamesFile, 'utf8'));
      } else {
        // Migration from openclaw.json to separate group-names.json
        _rawGroupNames = pluginCfg.groupNames || {};
        writeFileSync(groupNamesFile, JSON.stringify(_rawGroupNames, null, 2), 'utf8');
      }
    } catch (e) {
      _rawGroupNames = pluginCfg.groupNames || {};
    }

    async function saveGroupNames(namesObj) {
      try {
        await fs.writeFile(groupNamesFile, JSON.stringify(namesObj, null, 2) + '\n', 'utf8');
        _rawGroupNames = namesObj; // update in-memory reference
      } catch (e) {}
    }

    // ── groupNames: source of truth cho danh sách groups đang quản lý ──
    // Format mới: { groupId: { name, admins, creatorId } }
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

    // ── Synchronous botName detection (first-load fix) ──────────
    // When installed via ClawHub, pluginCfg.botName is empty on first load.
    // Detect from multiple sources before falling back to 'Bot':
    let _detectedBotName = pluginCfg.botName || '';
    if (!_detectedBotName) {
      // Source 1: Zalo credential display name (most accurate - real Zalo profile name)
      try {
        const _credPath = path.join(_openclawHome, 'credentials', 'zalouser', 'credentials.json');
        if (fs.existsSync(_credPath)) {
          const _cred = JSON.parse(fs.readFileSync(_credPath, 'utf8'));
          if (_cred.displayName) _detectedBotName = _cred.displayName;
        }
      } catch (e) { /* ok */ }
    }

    const botName       = String(_detectedBotName || 'Bot');
    const zaloNames     = (pluginCfg.zaloDisplayNames || []).map(String);
    const botNames      = [botName, ...zaloNames].filter(Boolean);
    const pfx = String(pluginCfg.slashPrefix || botName).toLowerCase().replace(/[^a-z0-9]/g, '');
    const cmdPrefix = '/' + (pfx || 'bot') + '-';
    let ownerId       = String(pluginCfg.ownerId || '');  // Zalo ID chủ nhân bot
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



    function getDeviceId() {
      const platform = os.platform();
      const hostname = os.hostname();
      const cpus = os.cpus().map(c => c.model).join(',');
      const hash = crypto.createHash('md5').update(`${platform}-${hostname}-${cpus}`).digest('hex');
      return hash.slice(0, 16).toUpperCase();
    }

    function getLicenseStatus() {
      if (!store) return { isPro: false, plan: 'free', expiry: null, deviceId: getDeviceId() };
      const license = store.getSetting('global', 'license') || {};
      
      // Expiry check
      if (license.valid && license.expiry) {
        const expDate = new Date(license.expiry);
        const now = new Date();
        if (now > expDate) {
          license.valid = false;
          store.setSetting('global', 'license', license);
          store.saveSettings().catch(() => {});
        }
      }

      if (license.valid) {
        return { 
          isPro: true, 
          plan: license.plan || 'personal', 
          expiry: license.expiry, 
          deviceId: license.deviceId || getDeviceId(),
          key: license.key
        };
      }
      return { isPro: false, plan: 'free', expiry: null, deviceId: getDeviceId() };
    }

    const MKT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6HwQYBdTBe+3qxakm9Kx
JJ97AwdtuffI9IwvYUV/Bh+98F4G7i59R77QcHosPPuKhKWANMvyixt372W7srUO
mu0IFtsABmZYmQuLkiikKQe4uytNvM3UQU3Mf0rDflPWwqiefJBa7Os0XcsAHni6
StVJ5uUDTnury+4wi0Qhz+230eoST68RIN9j7o3a9AiqMhNE/VDLkacBlhUarUwv
STWGdi7mvsItSVUa1z5+ExEIj5X2jgQGYUJhuEuNVcbdfaN5GzZHCUxMTuLrIl52
Wg7ZOUU1mGXUBFzvY43Yblx2YjwXQOmB3yrbNMphSsYOQGuaCq5cTIeh2bV6Vhki
PQIDAQAB
-----END PUBLIC KEY-----`;

    async function verifyLicenseKey(key) {
      if (!key) return { valid: false, error: 'Key is empty' };
      
      const deviceId = getDeviceId();
      
      // 1. Local Dev Keys for Testing
      if (key.startsWith('DEV-OP-') && key.length > 12) {
        return { valid: true, plan: 'personal', expiry: '2099-12-31', deviceId };
      }
      if (key.startsWith('DEV-TEAM-') && key.length > 12) {
        return { valid: true, plan: 'team', expiry: '2099-12-31', deviceId };
      }
      if (key.startsWith('DEV-LIFETIME-') && key.length > 12) {
        return { valid: true, plan: 'lifetime', expiry: '2099-12-31', deviceId };
      }

      // 2. RSA Asymmetric Offline Verification
      // Format: ZALOMKT-[PLAN]-[EXPIRY_YYYYMMDD]-[RSA_SIGNATURE_BASE64]
      if (key.startsWith('ZALOMKT-')) {
        try {
          const parts = key.split('-');
          if (parts.length >= 4) {
            const plan = parts[1].toLowerCase();
            const rawExpiry = parts[2]; // YYYYMMDD
            const expiry = `${rawExpiry.slice(0, 4)}-${rawExpiry.slice(4, 6)}-${rawExpiry.slice(6, 8)}`;
            
            // Signature Base64 may contain '-' symbols (url-safe base64), join the rest
            const signature = parts.slice(3).join('-');
            
            const dataToVerify = `${deviceId}:${plan}:${expiry}`;
            
            const verifier = crypto.createVerify('sha256');
            verifier.update(dataToVerify);
            const isValid = verifier.verify(MKT_PUBLIC_KEY, signature, 'base64');
            
            if (isValid) {
              return { valid: true, plan, expiry, deviceId };
            }
          }
        } catch (err) {
          // RSA validation failed or threw, fallback to Online API
        }
      }

      // 3. Fallback Online API Verification (compatibility with old bot keys)
      const urls = [
        `http://mkt-ai:20789/api/license/verify`,
        `http://127.0.0.1:20789/api/license/verify`
      ];

      for (const url of urls) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key, deviceId }),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data && data.valid) {
              return { valid: true, plan: data.plan || 'personal', expiry: data.expiry, deviceId };
            }
          }
        } catch (e) {
          // continue
        }
      }

      return { valid: false, error: 'Key kích hoạt không hợp lệ cho thiết bị này!' };
    }

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

          // 4a. Write detected botName to config so it is saved
          if (botName && botName !== 'Bot') {
            patch.botName = botName;
            patch.zaloDisplayNames = [botName];
            logger.info(`[openclaw-zalo-mod] auto-saving botName="${botName}" to config`);
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
    async function sendDmMsg(ctx, userId, text, imageUrl = null) {
      if (!userId || (!text && !imageUrl)) return;
      const profile = ctx?.accountId || 'default';
      try {
        const api = await _loadZalouserSendApi();
        if (!api?.sendMessageZalouser) { logger.warn('[openclaw-zalo-mod] sendDmMsg skipped — API unavailable'); return; }
        const opts = {
          isGroup: false,
          profile,
          textMode: 'markdown'
        };
        if (imageUrl) {
          opts.mediaUrl = imageUrl;
        }
        await api.sendMessageZalouser(String(userId), String(text || ''), opts);
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
    // Solution: use withZaloApi from zalouser to safely access the active API instance without breaking cipher keys.
    
    async function getSafeZaloApi() {
      // 1. Ưu tiên: Tái sử dụng Zalo API instance đang chạy từ `@openclaw/zalouser` để tránh dual-login (nếu có)
      const activeApi = globalThis.__zcaApiByProfile?.get('default');
      if (activeApi) {
        logger.info('[openclaw-zalo-mod] ⚡ Reusing active Zalo API instance from @openclaw/zalouser');
        return async function withZaloApiShim(profile, operation) {
          return await operation(activeApi);
        };
      }

      // 2. Fallback: Trigger zalouser ensureApi() via checkZaloAuthenticated
      //    Populate the SAME apiByProfile Map. NO separate zalo.login()
      //    to avoid dual-login breaking cipher keys.
      try {
        const testApi = await _loadZalouserSendApi();
        if (testApi?.checkZaloAuthenticated) {
          logger.info('[openclaw-zalo-mod] triggering zalouser ensureApi via checkZaloAuthenticated...');
          const isAuth = await testApi.checkZaloAuthenticated('default');
          if (isAuth) {
            // ensureApi populated apiByProfile -> get from globalThis
            const freshApi = globalThis.__zcaApiByProfile?.get('default');
            if (freshApi) {
              logger.info('[openclaw-zalo-mod] Zalo API restored via ensureApi, reusing shared session');
              return async function withZaloApiShim(profile, operation) {
                return await operation(freshApi);
              };
            }
          }
          logger.warn('[openclaw-zalo-mod] checkZaloAuthenticated returned false or API not populated');
        } else {
          logger.warn('[openclaw-zalo-mod] test-api.js missing checkZaloAuthenticated');
        }
      } catch (e) {
        logger.warn(`[openclaw-zalo-mod] fallback ensureApi failed: ${e.message}`);
      }

      // 3. No API available
      logger.warn('[openclaw-zalo-mod] ZCA API unavailable. Zalouser login required. Admin features disabled.');
      return null;
    }

    function _invalidateZcaApi() {
      // No-op: we no longer manage a separate zca-js instance
    }

    /**
     * Gọi ZCA getGroupInfo trực tiếp → trả { creatorId, adminIds, totalMember, name }
     */
    async function fetchGroupAdminsFromZCA(groupId) {
      try {
        const withZaloApi = await getSafeZaloApi();
        if (!withZaloApi) return null;

        return await withZaloApi('default', async (api) => {
          const result = await api.getGroupInfo(String(groupId));
          const info = result?.gridInfoMap?.[String(groupId)];
          if (!info) return null;
          return {
            creatorId: info.creatorId || null,
            adminIds: Array.isArray(info.adminIds) ? info.adminIds : [],
            totalMember: extractGroupMemberCount(info, 0),
            name: info.name || '',
          };
        });
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
      // Persist groupNames to group-names.json
      const mergedNames = { ..._rawGroupNames };
      mergedNames[groupId] = groupNames[groupId];
      await saveGroupNames(mergedNames);
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

    async function processGroupidAddAll(ctx, targetId, isGroupTarget, currentGroupId) {
      const sendMsg = isGroupTarget ? (m) => sendGroupMsg(ctx, targetId, m) : (m) => sendDmMsg(ctx, targetId, m);
      try {
        await sendMsg('🔍 Đang đồng bộ danh sách nhóm từ ZCA...');

        const withZaloApi = await getSafeZaloApi();
        if (!withZaloApi) throw new Error('Không thể khởi tạo ZCA API');

        const { groupIds, infoMap } = await withZaloApi('default', async (api) => {
          const gidsSet = new Set();
          
          function extractIds(res) {
            if (!res) return [];
            const ids = new Set();
            function traverse(obj) {
              if (!obj) return;
              if (typeof obj === 'string') {
                const clean = obj.replace(/^group:/, '').trim();
                if (/^\d+$/.test(clean)) ids.add(clean);
              } else if (typeof obj === 'number') {
                ids.add(String(obj));
              } else if (Array.isArray(obj)) {
                for (const item of obj) traverse(item);
              } else if (typeof obj === 'object') {
                if (obj.gridVerMap) traverse(Object.keys(obj.gridVerMap));
                if (obj.gridInfoMap) traverse(Object.keys(obj.gridInfoMap));
                if (obj.listLocalId) traverse(obj.listLocalId);
                if (obj.listId) traverse(obj.listId);
                for (const [key, val] of Object.entries(obj)) {
                  const cleanKey = key.replace(/^group:/, '').trim();
                  if (/^\d+$/.test(cleanKey)) ids.add(cleanKey);
                  traverse(val);
                }
              }
            }
            traverse(res);
            return [...ids];
          }

          // 1. Quét danh sách nhóm đang hoạt động (active list)
          try {
            const allGroups = await api.getAllGroups();
            extractIds(allGroups).forEach(id => gidsSet.add(id));
          } catch (e) {
            logger.warn(`[openclaw-zalo-mod] getAllGroups failed: ${e.message}`);
          }

          // 2. Quét các nhóm được Ghim lên đầu trang (Pinned)
          try {
            if (typeof api.getPinConversations === 'function') {
              const pins = await api.getPinConversations();
              extractIds(pins).forEach(id => gidsSet.add(id));
            }
          } catch (e) {
            logger.warn(`[openclaw-zalo-mod] getPinConversations failed: ${e.message}`);
          }

          // 3. Quét các nhóm bị Ẩn bằng mã PIN (Hidden)
          try {
            if (typeof api.getHiddenConversations === 'function') {
              const hiddens = await api.getHiddenConversations();
              extractIds(hiddens).forEach(id => gidsSet.add(id));
            }
          } catch (e) {
            logger.warn(`[openclaw-zalo-mod] getHiddenConversations failed: ${e.message}`);
          }

          // 4. Quét các nhóm cũ trong Kho lưu trữ (Archived)
          try {
            if (typeof api.getArchivedChatList === 'function') {
              const archived = await api.getArchivedChatList();
              extractIds(archived).forEach(id => gidsSet.add(id));
            }
          } catch (e) {
            logger.warn(`[openclaw-zalo-mod] getArchivedChatList failed: ${e.message}`);
          }

          // 5. Quét toàn bộ nhóm trong các Danh mục Phân loại (Labels)
          try {
            if (typeof api.getLabels === 'function') {
              const labels = await api.getLabels();
              extractIds(labels).forEach(id => gidsSet.add(id));
            }
          } catch (e) {
            logger.warn(`[openclaw-zalo-mod] getLabels failed: ${e.message}`);
          }

          const gids = [...gidsSet];

          if (currentGroupId && !gids.includes(currentGroupId)) {
            gids.push(currentGroupId);
          }

          // Lấy thông tin hàng loạt (tối ưu hóa API)
          let infoMapMerged = {};
          if (gids.length > 0) {
            try {
              const infoResult = await api.getGroupInfo(gids);
              infoMapMerged = infoResult?.gridInfoMap || {};
            } catch (e) {
              logger.warn(`[openclaw-zalo-mod] getGroupInfo failed: ${e.message}`);
            }
          }
          return { groupIds: gids, infoMap: infoMapMerged };
        });

        const mergedNames = { ..._rawGroupNames };
        const results = [];
        let autoEnabled = 0;

        for (const gId of groupIds) {
          const zcaInfo = infoMap[gId];
          if (!zcaInfo) {
            results.push(`⚠️ ${mergedNames[gId]?.name || gId}\n   ID: ${gId} | Không lấy được info từ ZCA`);
            continue;
          }

          if (!mergedNames[gId] || typeof mergedNames[gId] === 'string') {
            mergedNames[gId] = { name: zcaInfo.name || (typeof mergedNames[gId] === 'string' ? mergedNames[gId] : ''), admins: [], creatorId: '' };
          }

          const allAdmins = new Set(mergedNames[gId].admins || []);
          if (zcaInfo.creatorId) allAdmins.add(String(zcaInfo.creatorId));
          if (Array.isArray(zcaInfo.adminIds)) {
            for (const id of zcaInfo.adminIds) allAdmins.add(String(id));
          }
          mergedNames[gId].admins = [...allAdmins];
          mergedNames[gId].creatorId = zcaInfo.creatorId || '';
          if (zcaInfo.name) mergedNames[gId].name = zcaInfo.name;

          store.setSetting(gId, 'groupAdmins', [...allAdmins]);
          store.setSetting(gId, 'creatorId', zcaInfo.creatorId);

          const ownerIsAdmin = allAdmins.has(ownerId);
          if (ownerIsAdmin) {
            store.setSetting(gId, 'welcome', true);
            store.setSetting(gId, 'follow', true);
            store.setSetting(gId, 'tracking', true);
            autoEnabled++;
            results.push(`✅ ${mergedNames[gId].name}\n   ID: ${gId} | 👥 ${zcaInfo.totalMember || '?'} | 🎉 welcome+follow BẬT`);
          } else {
            results.push(`⬜ ${mergedNames[gId].name}\n   ID: ${gId} | 👥 ${zcaInfo.totalMember || '?'} | ⏸️ owner không phải admin`);
          }
        }

        await saveGroupNames(mergedNames);
        const patch = {};
        if (!pluginCfg.botName || pluginCfg.botName === 'Bot') {
          const detectedName = await _readBotNameFromIdentity(workspaceDir);
          if (detectedName) {
            patch.botName = detectedName;
            patch.zaloDisplayNames = [detectedName];
          }
        }

        if (Object.keys(patch).length > 0) {
          await _patchOpenclawConfig(_openclawHome, patch, logger, true);
        }
        await store.saveSettings();
        _invalidateZcaApi(); // Thoát ZCA ngay sau batch để tránh chiếm dụng socket

        for (const [gId, entry] of Object.entries(mergedNames)) {
          groupNames[gId] = entry;
          if (!watchGroupIds.includes(gId)) watchGroupIds.push(gId);
        }

        const report = [
          `📡 ĐỒNG BỘ ZCA HOÀN TẤT`,
          `━━━━━━━━━━━━━━━━━━`,
          ...results,
          ``,
          `📊 Tổng: ${groupIds.length} groups`,
          `🎉 Auto-enabled: ${autoEnabled} groups (owner là admin)`,
          `🔄 Restart gateway để áp dụng.`
        ].join('\n');
        await sendMsg(report);
      } catch (e) {
        logger.warn(`[openclaw-zalo-mod] rules groupid-add-all failed: ${e.message}`);
        await sendMsg(`⚠️ Lỗi quét groups từ ZCA: ${e.message}`);
        _invalidateZcaApi();
      }
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
          `🔐 OWNER PANEL — ${cmdPrefix}rules\n━━━━━━━━━━━━━━━━━━\n\n🔇 Mute (tắt bot hoàn toàn):\n  ${cmdPrefix}rules mute-list\n  ${cmdPrefix}rules mute <groupId> on/off\n  ${cmdPrefix}rules mute all on/off\n\n🔕 Silent Mode (chỉ reply khi tag):\n  ${cmdPrefix}rules silent-list\n  ${cmdPrefix}rules silent <groupId> on/off\n  ${cmdPrefix}rules silent all on/off\n\n🎉 Welcome (chào mem mới):\n  ${cmdPrefix}rules welcome-list\n  ${cmdPrefix}rules welcome <groupId> on/off\n  ${cmdPrefix}rules welcome all on/off\n\n📋 Tracking (ghi lịch sử chat):\n  ${cmdPrefix}rules tracking-list\n  ${cmdPrefix}rules tracking <groupId> on/off\n  ${cmdPrefix}rules tracking all on/off\n\n👁️ Follow (theo dõi chat + memory):\n  ${cmdPrefix}rules follow-list\n  ${cmdPrefix}rules follow <groupId> on/off\n  ${cmdPrefix}rules follow all on/off\n\n💬 DM Whitelist:\n  ${cmdPrefix}rules dm-list\n  ${cmdPrefix}rules dm-add <tên member>\n  ${cmdPrefix}rules dm-remove <tên member>\n\n🆔 Group:\n  ${cmdPrefix}rules groupid-list\n  ${cmdPrefix}rules groupid-add <groupId>\n  ${cmdPrefix}rules groupid-add-all\n\n📊 ${cmdPrefix}rules status`
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

      // ── groupid-add-all: quét tất cả groups từ session
      if (sub === 'groupid-add-all') {
        await processGroupidAddAll(ctx, senderId, false, null);
        return { handled: true };
      }

      // ── groupid-add <groupId>: thêm group bằng ID từ DM
      if (sub === 'groupid-add' && args[1]) {
        const targetGid = args[1].replace(/^<|>$/g, ''); // strip <>
        const gName = args.slice(2).join(' ') || `Group ${targetGid.slice(-6)}`;
        const newEntry = { name: gName, admins: [], creatorId: '' };
        // Merge vào groupNames hiện tại
        const mergedNames = { ..._rawGroupNames, [targetGid]: newEntry };
        const isNew = !_rawGroupNames[targetGid];
        await saveGroupNames(mergedNames);
        if (isNew) {
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
        if (isNew) {
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

    function _legacyDataFile(name) {
      return path.join(__dirname, 'data', name);
    }

    async function readPluginDataJson(name) {
      return (await safeReadJson(path.join(dataDir, name))) || (await safeReadJson(_legacyDataFile(name))) || {};
    }

    async function appendDashboardAudit(entry) {
      const file = path.join(dataDir, 'dashboard-audit.json');
      const list = Array.isArray(await safeReadJson(file)) ? await safeReadJson(file) : [];
      list.unshift({ ts: nowIso(), ...entry });
      await safeWriteJson(file, list.slice(0, 300));
    }

    function normalizeMembersInput(value) {
      if (Array.isArray(value)) return value.map(String).filter(Boolean);
      return String(value || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    }

    function normalizeModeSlug(value) {
      return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    }

    function getGroupCustomModes(groupId) {
      const list = store.getSetting(groupId, 'customModes', []);
      if (!Array.isArray(list)) return [];
      return list.map(item => {
        const slug = normalizeModeSlug(item?.slug || item?.label);
        if (!slug) return null;
        return {
          slug,
          label: String(item?.label || slug),
          skill: String(item?.skill || '').trim(),
          description: String(item?.description || '').trim(),
          enabled: item?.enabled !== false,
        };
      }).filter(Boolean);
    }

    function setGroupCustomModes(groupId, modes) {
      store.setSetting(groupId, 'customModes', modes);
    }

    function upsertGroupCustomMode(groupId, payload = {}) {
      const slug = normalizeModeSlug(payload.slug || payload.label);
      const label = String(payload.label || slug).trim();
      const skill = String(payload.skill || '').trim();
      const description = String(payload.description || '').trim();
      if (!groupId || !slug || !label) throw new Error('groupId, slug, and label are required');
      if (!skill) throw new Error('skill is required');
      const modes = getGroupCustomModes(groupId);
      const next = { slug, label, skill, description, enabled: payload.enabled !== false };
      const index = modes.findIndex(item => item.slug === slug);
      if (index >= 0) modes[index] = next;
      else modes.push(next);
      setGroupCustomModes(groupId, modes);
      return next;
    }

    function toggleGroupCustomMode(groupId, slug, enabled) {
      const normalized = normalizeModeSlug(slug);
      const modes = getGroupCustomModes(groupId);
      const index = modes.findIndex(item => item.slug === normalized);
      if (index < 0) throw new Error(`Custom mode "${slug}" not found`);
      modes[index].enabled = !!enabled;
      setGroupCustomModes(groupId, modes);
      return modes[index];
    }

    function deleteGroupCustomMode(groupId, slug) {
      const normalized = normalizeModeSlug(slug);
      const modes = getGroupCustomModes(groupId);
      const next = modes.filter(item => item.slug !== normalized);
      if (next.length === modes.length) throw new Error(`Custom mode "${slug}" not found`);
      setGroupCustomModes(groupId, next);
      return { slug: normalized, removed: true };
    }

    function buildActiveModePrompt(groupId) {
      const activeModes = getGroupCustomModes(groupId).filter(item => item.enabled);
      if (!activeModes.length) return '';
      const lines = activeModes.map(item => `- ${item.label} (/bot-${item.slug}-on|off) -> skill: ${item.skill}${item.description ? ` -> ${item.description}` : ''}`);
      return `[GROUP MODE CONTEXT]\nActive custom modes for this group:\n${lines.join('\n')}\nUse these modes as operating instructions when they are relevant.`;
    }

    const excludedDashboardGroups = new Set([
      '4406658694794071399',
      '4765340670657180769',
    ]);

    function groupDedupeKey(name) {
      return String(name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }

    function groupQualityScore(group) {
      return (Number(group.memberCount || 0) * 10)
        + (Array.isArray(group.admins) ? group.admins.length * 3 : 0)
        + (group.creatorId ? 2 : 0);
    }


    function extractGroupMemberCount(info, cached = 0) {
      const direct = [info?.totalMember, info?.memberCount, info?.totalMembers, info?.userCount, info?.memCount, info?.currentMems]
        .map(Number)
        .find(value => Number.isFinite(value) && value > 0);
      if (direct) return direct;
      const maps = [info?.memVerMap, info?.membersMap, info?.memberMap, info?.participantsMap];
      for (const map of maps) if (map && typeof map === 'object') {
        const count = Object.keys(map).length;
        if (count > 0) return count;
      }
      const arrays = [info?.memVerList, info?.members, info?.memberIds, info?.userIds, info?.participants];
      for (const list of arrays) if (Array.isArray(list) && list.length) return list.length;
      return Number(cached || 0) || 0;
    }

    function pendingListFromResult(pending) {
      const direct = Array.isArray(pending?.members) ? pending.members
        : Array.isArray(pending?.pendingMembers) ? pending.pendingMembers
        : Array.isArray(pending?.data) ? pending.data
        : Array.isArray(pending?.list) ? pending.list
        : Array.isArray(pending) ? pending
        : null;
      if (direct) return direct;
      const seen = new Set();
      const out = [];
      const stack = [pending];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        if (Array.isArray(cur)) {
          for (const item of cur) stack.push(item);
          continue;
        }
        const uid = cur.userId || cur.uid || cur.id;
        if (uid != null) {
          const key = String(uid);
          if (!seen.has(key)) {
            seen.add(key);
            out.push(cur);
          }
        }
        for (const value of Object.values(cur)) stack.push(value);
      }
      return out;
    }

    function collectProfileNames(payload, seed = {}) {
      const out = { ...seed };
      const seen = new Set();
      const stack = [payload];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur) continue;
        if (Array.isArray(cur)) {
          for (const item of cur) stack.push(item);
          continue;
        }
        if (typeof cur !== 'object') continue;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const id = cur.userId || cur.uid || cur.id || cur.user_id;
        const name = cur.name || cur.displayName || cur.userName || cur.fullName || cur.dName || cur.zaloName;
        if (id != null && name) out[String(id).replace(/_0$/, '')] = String(name);
        for (const [key, value] of Object.entries(cur)) {
          if (value && typeof value === 'object') {
            if (!Array.isArray(value) && /^\d+$/.test(String(key))) {
              const nestedName = value.name || value.displayName || value.userName || value.fullName || value.dName || value.zaloName;
              if (nestedName) out[String(key).replace(/_0$/, '')] = String(nestedName);
            }
            stack.push(value);
          }
        }
      }
      return out;
    }

    function chunkArray(list, size = 200) {
      const out = [];
      for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
      return out;
    }

    function extractMemberIdsFromGroupInfo(info) {
      const ids = new Set();
      const add = (value) => {
        if (value == null) return;
        const s = String(value).replace(/_0$/, '');
        if (/^\d+$/.test(s)) ids.add(s);
      };
      const arrays = [info?.memVerList, info?.memberIds, info?.userIds, info?.participants];
      for (const list of arrays) if (Array.isArray(list)) for (const item of list) add(item?.id || item?.userId || item?.uid || item);
      const maps = [info?.memVerMap, info?.membersMap, info?.memberMap, info?.participantsMap];
      for (const map of maps) if (map && typeof map === 'object') for (const key of Object.keys(map)) add(key);
      return [...ids];
    }

    async function scanGroupMembers(groupId, zaloApi) {
      const rawInfo = await zaloApi.getGroupInfo(groupId);
      const info = rawInfo?.gridInfoMap?.[String(groupId)] || rawInfo?.gridInfoMap?.[groupId] || rawInfo || {};
      const ids = extractMemberIdsFromGroupInfo(info);
      const names = {};
      if (ids.length) {
        for (const batch of chunkArray(ids, 200)) {
          try {
            const detail = await zaloApi.getGroupMembersInfo(batch);
            Object.assign(names, collectProfileNames(detail, names));
          } catch (_) {}
          const missing = batch.filter(id => !names[id]);
          if (missing.length) {
            try {
              const profiles = await zaloApi.getUserInfo(missing);
              Object.assign(names, collectProfileNames(profiles, names));
            } catch (_) {}
          }
        }
      }
      const members = ids.map(id => ({ id, name: names[id] || _memberDir[groupId]?.[id] || id }));
      updateMemberDir(groupId, members);
      await saveMemberDir();
      store.setSetting(groupId, 'memberCount', members.length || extractGroupMemberCount(info, store.getSetting(groupId, 'memberCount', 0)));
      await store.saveSettings();
      return { count: members.length, groupId, members };
    }

    async function enrichPendingResult(groupId, pendingRaw) {
      const list = pendingListFromResult(pendingRaw);
      if (!list.length) return { raw: pendingRaw, list: [] };
      const memberCache = _memberDir[groupId] || {};
      const ids = [...new Set(list.map(item => String(item?.userId || item?.uid || item?.id || item || '')).filter(Boolean))];
      let names = { ...memberCache };
      try {
        const withZaloApi = await getSafeZaloApi();
        if (withZaloApi) {
          await withZaloApi('default', async (zaloApi) => {
            try {
              const details = await zaloApi.getGroupMembersInfo(ids);
              names = collectProfileNames(details, names);
            } catch (_) {}
            const missing = ids.filter(id => !names[id]);
            if (missing.length) {
              try {
                const profiles = await zaloApi.getUserInfo(missing);
                names = collectProfileNames(profiles, names);
              } catch (_) {}
            }
          });
        }
      } catch (_) {}
      return {
        raw: pendingRaw,
        list: list.map(item => {
          const id = String(item?.userId || item?.uid || item?.id || item || '');
          return {
            ...item,
            id,
            name: names[id] || item?.name || item?.displayName || item?.userName || id,
          };
        }),
      };
    }

    async function buildDashboardState() {
      await reloadStore();
      const memberDir = await readPluginDataJson('group-members.json');
      const settingsRaw = await readPluginDataJson('settings.json');
      const warnedRaw = await readPluginDataJson('warned.json');
      const violationsRaw = await readPluginDataJson('violations.json');
      const audit = Array.isArray(await safeReadJson(path.join(dataDir, 'dashboard-audit.json')))
        ? await safeReadJson(path.join(dataDir, 'dashboard-audit.json'))
        : [];

      const rawGroups = Object.entries(groupNames).filter(([groupId]) => !excludedDashboardGroups.has(String(groupId))).map(([groupId, info]) => {
        const settings = settingsRaw[groupId] || {};
        const membersObj = memberDir[groupId] || {};
        const cachedMemberCount = Number(settings.memberCount || settings.totalMember || 0);
        const warnedCount = Object.values(warnedRaw[groupId] || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
        const violationCount = Object.values(violationsRaw[groupId] || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
        const memberCount = Object.keys(membersObj).length || cachedMemberCount;
        return {
          groupId,
          name: info?.name || settings.name || `Group ${groupId.slice(-6)}`,
          admins: settings.groupAdmins || info?.admins || [],
          creatorId: settings.creatorId || info?.creatorId || '',
          inviteLink: settings.inviteLink || info?.inviteLink || info?.link || '',
          pendingCount: Number(settings.pendingCount || 0),
          memberCount,
          isMemberCountCached: Object.keys(membersObj).length === 0 && cachedMemberCount > 0,
          warnedCount,
          violationCount,
          settings: {
            muted: !!settings.muted,
            silent: settings.silent !== false,
            welcome: settings.welcome !== false,
            tracking: !!settings.tracking,
            follow: settings.follow !== false,
            pendingAuto: !!settings.pendingAuto,
          },
          customModes: getGroupCustomModes(groupId),
        };
      });
      const byName = new Map();
      for (const group of rawGroups) {
        const key = groupDedupeKey(group.name);
        if (!key) {
          byName.set(`id:${group.groupId}`, group);
          continue;
        }
        const existing = byName.get(key);
        if (!existing || groupQualityScore(group) > groupQualityScore(existing)) byName.set(key, group);
      }
      const groups = [...byName.values()];

      return {
        ok: true,
        license: getLicenseStatus(),
        bot: {
          name: botName,
          cmdPrefix,
          ownerId,
          ownerName: (() => {
            for (const members of Object.values(memberDir)) {
              if (members?.[ownerId]) return members[ownerId];
            }
            return ownerId || 'Owner';
          })(),
          groups: groups.length,
          dashboardPort: Number(pluginCfg.dashboardPort || 19790),
        },
        groups,
        members: memberDir,
        settings: settingsRaw,
        audit: audit.slice(0, 50),
        totals: {
          groups: groups.length,
          members: groups.reduce((sum, g) => sum + g.memberCount, 0),
          warnings: groups.reduce((sum, g) => sum + g.warnedCount, 0),
          violations: groups.reduce((sum, g) => sum + g.violationCount, 0),
        },
      };
    }

    async function runDashboardZcaAction(action, payload) {
      const withZaloApi = await getSafeZaloApi();
      if (!withZaloApi) throw new Error('ZCA API unavailable. Check zalouser credentials and zca-js install.');

      return await withZaloApi('default', async (zaloApi) => {
        const groupId = String(payload.groupId || '').trim();
        const userId = String(payload.userId || '').trim();
        const members = normalizeMembersInput(payload.members || payload.userIds || userId);

        if (action === 'sync-groups') {
          const allGroups = await zaloApi.getAllGroups();
          const ids = Object.keys(allGroups?.gridVerMap || {});
          const infoResult = ids.length ? await zaloApi.getGroupInfo(ids) : null;
          const infoMap = infoResult?.gridInfoMap || {};
          const merged = { ..._rawGroupNames };
          for (const gId of ids) {
            if (excludedDashboardGroups.has(String(gId))) continue;
            const z = infoMap[gId] || {};
            merged[gId] = {
              name: z.name || groupNames[gId]?.name || `Group ${gId.slice(-6)}`,
              admins: Array.isArray(z.adminIds) ? z.adminIds.map(String) : (groupNames[gId]?.admins || []),
              creatorId: z.creatorId ? String(z.creatorId) : (groupNames[gId]?.creatorId || ''),
              inviteLink: z.inviteLink || z.link || z.groupLink || z.url || groupNames[gId]?.inviteLink || '',
            };
            groupNames[gId] = merged[gId];
            if (!watchGroupIds.includes(gId)) watchGroupIds.push(gId);
            if (merged[gId].admins?.length) store.setSetting(gId, 'groupAdmins', merged[gId].admins);
            if (merged[gId].creatorId) store.setSetting(gId, 'creatorId', merged[gId].creatorId);
            if (merged[gId].inviteLink) store.setSetting(gId, 'inviteLink', merged[gId].inviteLink);
            store.setSetting(gId, 'memberCount', extractGroupMemberCount(z, store.getSetting(gId, 'memberCount', 0)));
            if (z.pendingCount != null) store.setSetting(gId, 'pendingCount', Number(z.pendingCount) || 0);
            if (!store.getSetting(gId, 'memberCount', 0)) {
              try {
                const fresh = await fetchGroupAdminsFromZCA(gId);
                if (fresh?.totalMember) store.setSetting(gId, 'memberCount', Number(fresh.totalMember) || 0);
                if (fresh?.creatorId) store.setSetting(gId, 'creatorId', String(fresh.creatorId));
                if (Array.isArray(fresh?.adminIds) && fresh.adminIds.length) store.setSetting(gId, 'groupAdmins', fresh.adminIds.map(String));
              } catch (_) {}
            }
          }
          for (const gId of ids.slice(0, 30)) {
            try {
              const pending = await zaloApi.getPendingGroupMembers(gId);
              const list = pendingListFromResult(pending);
              store.setSetting(gId, 'pendingCount', list.length);
            } catch (_) {}
          }
          await saveGroupNames(merged);
          await store.saveSettings();

          // Also sync botName if missing or default (case-insensitive check for default values like 'bot', 'Bot', 'OpenClaw Bot')
          const patch = {};
          const currentBotName = String(pluginCfg.botName || '').trim();
          const isDefaultBotName = !currentBotName || 
            ['bot', 'botname', 'openclaw bot', 'openclaw-bot'].includes(currentBotName.toLowerCase()) ||
            currentBotName.includes('**Mkt**'); // Also override if it contains the corrupted markdown name

          if (isDefaultBotName) {
            let detectedName = null;
            try {
              if (typeof zaloApi.fetchAccountInfo === 'function') {
                const acc = await zaloApi.fetchAccountInfo();
                const profileObj = acc?.profile || acc;
                if (profileObj && profileObj.displayName) {
                  detectedName = profileObj.displayName;
                } else if (profileObj && profileObj.zaloName) {
                  detectedName = profileObj.zaloName;
                } else if (profileObj && profileObj.name) {
                  detectedName = profileObj.name;
                }
              }
              
              if (!detectedName && typeof zaloApi.getOwnId === 'function') {
                const ownId = await zaloApi.getOwnId();
                if (ownId) {
                  const uinfo = await zaloApi.getUserInfo(ownId);
                  const profileObj = uinfo?.changed_profiles?.[ownId] || uinfo?.[ownId] || uinfo;
                  if (profileObj && profileObj.displayName) {
                    detectedName = profileObj.displayName;
                  } else if (profileObj && profileObj.zaloName) {
                    detectedName = profileObj.zaloName;
                  } else if (profileObj && profileObj.name) {
                    detectedName = profileObj.name;
                  }
                }
              }
            } catch (err) {
              logger.warn('[openclaw-zalo-mod] failed to fetch Zalo profile name via API: ' + err.message);
            }

            if (detectedName) {
              patch.botName = detectedName;
              patch.zaloDisplayNames = [detectedName];
              logger.info('[openclaw-zalo-mod] Synced bot name via Zalo API: "' + detectedName + '"');
            }
          }
          if (Object.keys(patch).length > 0) {
            await _patchOpenclawConfig(_openclawHome, patch, logger, true);
          }

          return { imported: ids.length };
        }

        if (!groupId && ['get-group-info', 'get-pending', 'get-blocked', 'review-pending', 'remove-user', 'block-member', 'unblock-member'].includes(action)) {
          throw new Error('groupId is required');
        }

        if (action === 'get-group-info') return await zaloApi.getGroupInfo(groupId);
        if (action === 'scan-members') return await scanGroupMembers(groupId, zaloApi);
        if (action === 'leave-group') return await zaloApi.leaveGroup(groupId, !!payload.silent);
        if (action === 'get-pending') return await zaloApi.getPendingGroupMembers(groupId);
        if (action === 'get-blocked') return await zaloApi.getGroupBlockedMember(groupId);
        if (action === 'review-pending') {
          return await zaloApi.reviewPendingMemberRequest({ members, isApprove: payload.approve !== false }, groupId);
        }
        if (action === 'remove-user') return await zaloApi.removeUserFromGroup(groupId, members.length > 1 ? members : members[0]);
        if (action === 'block-member') return await zaloApi.addGroupBlockedMember(members.length > 1 ? members : members[0], groupId);
        if (action === 'unblock-member') return await zaloApi.removeGroupBlockedMember(members.length > 1 ? members : members[0], groupId);
        if (action === 'accept-friend') return await zaloApi.acceptFriendRequest(userId);
        if (action === 'reject-friend') return await zaloApi.rejectFriendRequest(userId);
        if (action === 'send-friend-request') return await zaloApi.sendFriendRequest(userId, payload.message ? { message: String(payload.message) } : undefined);
        if (action === 'get-friends') return await zaloApi.getAllFriends();
        if (action === 'get-user-info') return await zaloApi.getUserInfo(userId);

        throw new Error(`Unsupported ZCA action: ${action}`);
      });
    }

    async function runDashboardAction(action, payload = {}) {
      if (action === 'activate-license') {
        const key = String(payload.key || '').trim();
        const result = await verifyLicenseKey(key);
        if (result.valid) {
          store.setSetting('global', 'license', {
            valid: true,
            plan: result.plan,
            expiry: result.expiry,
            deviceId: result.deviceId,
            key
          });
          await store.saveSettings();
        }
        return result;
      }

      // Check if Pro/Premium license is required for this action
      const freeActions = [
        'sync-groups',       // Sync Account — essential setup action
        'toggle-setting',    // Already free (handled separately below)
      ];
      const proActions = [
        'bulk-toggle-setting',
        'upsert-custom-mode',
        'toggle-custom-mode',
        'delete-custom-mode',
        
        // ZCA actions
        'enrich-pending',
        'approve-pending',
        'reject-pending',
        'kick-member',
        'block-member',
        'unblock-member',
        'invite-member',
        'get-group-info',
        'get-user-info'
      ];
      
      if (proActions.includes(action) && !freeActions.includes(action)) {
        const lic = getLicenseStatus();
        if (!lic.isPro) {
          throw new Error('Chức năng này chỉ dành cho tài khoản PRO. Vui lòng nâng cấp!');
        }
      }

      if (action === 'toggle-setting') {
        const groupId = String(payload.groupId || '').trim();
        const key = String(payload.key || '').trim();
        if (!groupId || !['muted', 'silent', 'welcome', 'tracking', 'follow', 'pendingAuto'].includes(key)) {
          throw new Error('Invalid setting payload');
        }
        store.setSetting(groupId, key, !!payload.value);
        await store.saveSettings();
        return { groupId, key, value: !!payload.value };
      }

      if (action === 'bulk-toggle-setting') {
        const groupIds = Array.isArray(payload.groupIds) ? payload.groupIds.map(String).filter(Boolean) : [];
        const key = String(payload.key || '').trim();
        if (!groupIds.length || !['muted', 'silent', 'welcome', 'tracking', 'follow', 'pendingAuto'].includes(key)) {
          throw new Error('Invalid bulk setting payload');
        }
        for (const groupId of groupIds) store.setSetting(groupId, key, !!payload.value);
        await store.saveSettings();
        return { key, value: !!payload.value, count: groupIds.length };
      }

      if (action === 'upsert-custom-mode') {
        const groupId = String(payload.groupId || '').trim();
        const mode = upsertGroupCustomMode(groupId, payload);
        await store.saveSettings();
        return { groupId, mode };
      }

      if (action === 'toggle-custom-mode') {
        const groupId = String(payload.groupId || '').trim();
        const slug = String(payload.slug || '').trim();
        const mode = toggleGroupCustomMode(groupId, slug, payload.enabled !== false);
        await store.saveSettings();
        return { groupId, mode };
      }

      if (action === 'delete-custom-mode') {
        const groupId = String(payload.groupId || '').trim();
        const slug = String(payload.slug || '').trim();
        const result = deleteGroupCustomMode(groupId, slug);
        await store.saveSettings();
        return { groupId, ...result };
      }

      if (action === 'group-detail') {
        const groupId = String(payload.groupId || '').trim();
        if (!groupId) throw new Error('groupId is required');
        const settingsRaw = await readPluginDataJson('settings.json');
        const memberDir = await readPluginDataJson('group-members.json');
        const settings = settingsRaw[groupId] || {};
        let zcaInfo = null;
        let pending = null;
        try { zcaInfo = await runDashboardZcaAction('get-group-info', { groupId }); } catch (_) {}
        try {
          const pendingRaw = await runDashboardZcaAction('get-pending', { groupId });
          pending = await enrichPendingResult(groupId, pendingRaw);
          store.setSetting(groupId, 'pendingCount', pending.list.length);
          await store.saveSettings();
        } catch (_) {}
        return {
          groupId,
          name: groupNames[groupId]?.name || settings.name || `Group ${groupId.slice(-6)}`,
          memberCount: Object.keys(memberDir[groupId] || {}).length || Number(settings.memberCount || settings.totalMember || 0),
          pendingCount: Number(settings.pendingCount || 0),
          admins: settings.groupAdmins || groupNames[groupId]?.admins || [],
          creatorId: settings.creatorId || groupNames[groupId]?.creatorId || '',
          inviteLink: settings.inviteLink || groupNames[groupId]?.inviteLink || '',
          settings: {
            muted: !!settings.muted,
            silent: settings.silent !== false,
            welcome: settings.welcome !== false,
            tracking: !!settings.tracking,
            follow: settings.follow !== false,
            pendingAuto: !!settings.pendingAuto,
          },
          customModes: getGroupCustomModes(groupId),
          zcaInfo,
          pending,
        };
      }

      if (action === 'get-pending') {
        const groupId = String(payload.groupId || '').trim();
        const result = await runDashboardZcaAction(action, payload);
        const enriched = await enrichPendingResult(groupId, result);
        const list = enriched.list;
        if (groupId) {
          store.setSetting(groupId, 'pendingCount', list.length);
          await store.saveSettings();
        }
        return enriched;
      }

      if (action === 'send-message') {
        const targetId = String(payload.targetId || payload.groupId || payload.userId || '').trim();
        const text = String(payload.text || '').trim();
        if (!targetId || !text) throw new Error('targetId and text are required');
        if (payload.targetType === 'user') await sendDmMsg({ accountId: 'default' }, targetId, text);
        else await sendGroupMsg({ accountId: 'default' }, targetId, text);
        return { sent: true, targetId };
      }

      return await runDashboardZcaAction(action, payload);
    }

    function parseDashboardBody(req) {
      return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => {
          raw += chunk;
          if (raw.length > 1024 * 1024) reject(new Error('Request body too large'));
        });
        req.on('end', () => {
          try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
        });
        req.on('error', reject);
      });
    }

    function sendDashboardJson(res, status, data) {
      const body = JSON.stringify(data, null, 2);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body, 'utf8');
    }

    function startDashboardServer() {
      if (pluginCfg.dashboardEnabled === false) return;
      const host = String(pluginCfg.dashboardHost || '0.0.0.0');
      const port = Number(pluginCfg.dashboardPort || 19790);
      const token = String(pluginCfg.dashboardToken || cfg?.gateway?.auth?.token || ownerId || 'openclaw-zalo-mod');
      const key = '__openclawZaloModDashboard';
      const existing = globalThis[key];
      if (existing?.server) {
        try { existing.server.close(); } catch (_) {}
      }

      const dashboardFile = path.join(__dirname, 'ZALO_OWNER_DASHBOARD.html');
      const donateQrFile = path.join(__dirname, 'bvbank.jpg');
      const logoFile = path.join(__dirname, 'logo.png');
      const server = http.createServer(async (req, res) => {
        try {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Zalo-Dashboard-Token');
          if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
          }
          const url = new URL(req.url || '/', `http://${host}:${port}`);
          if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
            let html = existsSync(dashboardFile)
              ? readFileSync(dashboardFile, 'utf8')
              : '<!doctype html><meta charset="utf-8"><title>Zalo Dashboard</title><h1>Zalo Dashboard file missing</h1>';
            html = html.replace('</head>', `<script>window.ZALO_DASHBOARD_TOKEN=${JSON.stringify(token)};</script></head>`);
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(html, 'utf8');
            return;
          }

          if (req.method === 'GET' && (url.pathname === '/assets/bvbank.jpg' || url.pathname === '/bvbank.jpg')) {
            if (!existsSync(donateQrFile)) {
              sendDashboardJson(res, 404, { ok: false, error: 'Donate QR not found' });
              return;
            }
            res.writeHead(200, {
              'content-type': 'image/jpeg',
              'cache-control': 'public, max-age=3600',
            });
            res.end(readFileSync(donateQrFile));
            return;
          }

          if (req.method === 'GET' && (url.pathname === '/assets/logo.png' || url.pathname === '/logo.png' || url.pathname === '/favicon.ico')) {
            if (!existsSync(logoFile)) {
              sendDashboardJson(res, 404, { ok: false, error: 'Logo not found' });
              return;
            }
            res.writeHead(200, {
              'content-type': 'image/png',
              'cache-control': 'public, max-age=3600',
            });
            res.end(readFileSync(logoFile));
            return;
          }

          if (url.pathname.startsWith('/api/')) {
            const auth = req.headers.authorization || '';
            const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-zalo-dashboard-token'];
            if (String(headerToken || '') !== token) {
              sendDashboardJson(res, 401, { ok: false, error: 'Unauthorized dashboard token' });
              return;
            }
          }

          if (req.method === 'GET' && url.pathname === '/api/state') {
            sendDashboardJson(res, 200, await buildDashboardState());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/action') {
            const body = await parseDashboardBody(req);
            const action = String(body.action || '').trim();
            if (!action) throw new Error('action is required');
            const result = await runDashboardAction(action, body.payload || {});
            await appendDashboardAudit({ action, payload: body.payload || {}, ok: true });
            sendDashboardJson(res, 200, { ok: true, result, state: await buildDashboardState() });
            return;
          }

          sendDashboardJson(res, 404, { ok: false, error: 'Not found' });
        } catch (e) {
          logger.warn(`[openclaw-zalo-mod] dashboard error: ${e.message}`);
          try { await appendDashboardAudit({ action: 'error', ok: false, error: e.message }); } catch (_) {}
          sendDashboardJson(res, 500, { ok: false, error: e.message });
        }
      });

      server.listen(port, host, () => {
        logger.info(`[openclaw-zalo-mod] dashboard listening at http://${host}:${port}/dashboard`);
      });
      globalThis[key] = { server, port, host };
    }

    startDashboardServer();

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



      // Packaging Gating: Skip automated moderation / anti-spam / commands for Free users
      // LOẠI TRỪ: Cho phép chủ nhân bot (owner) chạy các lệnh cấu hình hoặc kích hoạt bản quyền kể cả khi đang ở gói Free
      const lic = getLicenseStatus();
      if (!lic.isPro) {
        const bodyContent = String(event?.body || event?.content || '').trim();
        const lcBody = bodyContent.toLowerCase();
        
        const isActivationCmd = lcBody.startsWith(`${cmdPrefix}active-key`) || lcBody.startsWith(`${cmdPrefix}kich-hoat`);
        const cleanLc = lcBody.replace(/['’]/g, '');
        const isClaimOwnerCmd = lcBody.startsWith(`${cmdPrefix}ownerid`) || cleanLc === 'im admin' || cleanLc === 'iam admin' || cleanLc === 'i am admin';
        const isOwnerRulesCmd = ownerId && senderId === ownerId && (lcBody.startsWith(`${cmdPrefix}rules`) || lcBody.startsWith(`${cmdPrefix}mute`) || lcBody.startsWith(`${cmdPrefix}unmute`));
        
        const isExempted = isActivationCmd || isClaimOwnerCmd || isOwnerRulesCmd;

        // [LOẠI BỎ CHẶN LỆNH THỦ CÔNG CHO PLAN FREE]
        // Cho phép chạy slash commands thủ công trên Zalo chat ở gói Free.
        // Chỉ giới hạn các chức năng tương ứng trên giao diện Zalo-Mod Web UI.
        /*
        if (bodyContent.startsWith('/') && bodyContent.length > 1 && !isExempted) {
          await sendGroupMsg(ctx, isGroupMsg ? rawConvId : senderId, '⚠️ Chức năng này chỉ dành cho tài khoản PRO. Vui lòng nâng cấp!');
          return { handled: true };
        }
        */
        // NOTE: Do NOT return early here for non-command messages.
        // Free users still need @mention detection and silent mode check below.
      }

      // ── DM Flow — Owner config + whitelist gating ──────────
      if (!isGroupMsg) {
        // /ownerid — intercept from ANY DM user (before owner gate)
        // Allows first user to claim ownership when ownerId is empty
        const lcContent = content.toLowerCase().trim();
        const cleanLc = lcContent.replace(/['’]/g, '');
        const ownerIdMatch = lcContent === `${cmdPrefix}ownerid` || cleanLc === "im admin" || cleanLc === "iam admin" || cleanLc === "i am admin";
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

        const customModeMatch = command.match(/^\/bot-([a-z0-9-]+)-(on|off)$/i);
        if (customModeMatch) {
          if (!isAdmin(senderId, groupId)) return { handled: true };
          const [, slug, state] = customModeMatch;
          try {
            const mode = toggleGroupCustomMode(groupId, slug, state === 'on');
            await store.saveSettings();
            await sendGroupMsg(ctx, groupId, `✅ ${mode.label}: ${state === 'on' ? 'BẬT' : 'TẮT'}\n🧠 Skill: ${mode.skill}`);
          } catch (e) {
            await sendGroupMsg(ctx, groupId, `⚠️ ${e.message}`);
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

        // /active-key [key] / /kich-hoat [key] — owner only: kích hoạt key qua chat
        if (command === '/active-key' || command === '/kich-hoat') {
          if (!ownerId || senderId !== ownerId) return { handled: true };
          const key = args[0]?.trim();
          if (!key) {
            await sendGroupMsg(ctx, isGroupMsg ? rawConvId : senderId, `⚠️ Vui lòng nhập key. Cú pháp: ${command} [key]`);
            return { handled: true };
          }
          await sendGroupMsg(ctx, isGroupMsg ? rawConvId : senderId, `🔍 Đang xác thực key...`);
          const result = await verifyLicenseKey(key);
          if (result.valid) {
            store.setSetting('global', 'license', {
              valid: true,
              plan: result.plan,
              expiry: result.expiry,
              deviceId: result.deviceId,
              key
            });
            await store.saveSettings();
            await sendGroupMsg(ctx, isGroupMsg ? rawConvId : senderId, `✅ Kích hoạt thành công!
Plan: ${result.plan.toUpperCase()}
Hạn: ${result.expiry}
Device ID: ${result.deviceId}`);
          } else {
            await sendGroupMsg(ctx, isGroupMsg ? rawConvId : senderId, `❌ Kích hoạt thất bại: ${result.error}`);
          }
          return { handled: true };
        }

        // ${cmdPrefix}rules — owner-only control panel
        if (command === '/rules') {
          if (!ownerId || senderId !== ownerId) return { handled: true };
          const sub = args[0]?.toLowerCase();
          if (!sub) {
            await sendGroupMsg(ctx, groupId,
              `⚙️ ADMIN COMMANDS — ${cmdPrefix}rules\n━━━━━━━━━━━━━━━━━━\n\n🔇 Mute (tắt bot hoàn toàn):\n  /mute   — Tắt bot\n  /unmute — Bật lại\n\n🔕 Silent Mode:\n  ${cmdPrefix}rules silent-on  — Bot chỉ reply khi @tag\n  ${cmdPrefix}rules silent-off — Bot reply mọi tin\n\n🎉 Welcome:\n  ${cmdPrefix}rules welcome-on  — Bật chào member mới\n  ${cmdPrefix}rules welcome-off — Tắt chào\n\n📋 Tracking:\n  ${cmdPrefix}rules tracking-on  — Bật ghi lịch sử chat\n  ${cmdPrefix}rules tracking-off — Tắt ghi lịch sử\n\n🆔 Quản lý ID:\n  ${cmdPrefix}rules groupid\n  ${cmdPrefix}rules groupid-list\n  ${cmdPrefix}rules groupid-add-all\n\n📊 ${cmdPrefix}rules status`
            );
            return { handled: true };
          }
          if (sub === 'groupid-list') {
            const lines = ['🆔 DANH SÁCH GROUPS\n━━━━━━━━━━━━━━━━━━'];
            for (const gId of watchGroupIds) {
              const name = getGroupName(gId);
              const muted = store.getSetting(gId, 'muted', false);
              lines.push(`${muted ? '🔇' : '🔊'} ${name}\n   ID: ${gId}`);
            }
            if (watchGroupIds.length === 0) lines.push(`⚠️ Chưa có group nào. Gõ ${cmdPrefix}rules groupid trong group để thêm.`);
            lines.push(`\n📊 Tổng: ${watchGroupIds.length} group(s)`);
            await sendGroupMsg(ctx, groupId, lines.join('\n'));
            return { handled: true };
          }
          if (sub === 'groupid') {
            try {
              await sendGroupMsg(ctx, groupId, `🔍 Đang cập nhật thông tin group hiện tại...`);
              const zcaInfo = await syncGroupAdminsFromZCA(groupId);
              if (!watchGroupIds.includes(groupId)) watchGroupIds.push(groupId);
              
              let autoEnabled = false;
              const allAdmins = getGroupAdmins(groupId);
              if (allAdmins.includes(ownerId)) {
                store.setSetting(groupId, 'welcome', true);
                store.setSetting(groupId, 'follow', true);
                store.setSetting(groupId, 'tracking', true);
                autoEnabled = true;
              }
              await store.saveSettings();

              const adminNames = getGroupAdminNames(groupId);
              const adminLine = adminNames.length > 0
                ? `👑 Admins: ${adminNames.join(', ')}`
                : '👑 Admin: chưa sync được (ZCA unavailable)';
              const memberLine = zcaInfo ? `👥 Members: ${zcaInfo.totalMember}` : '';
              const nameLine = zcaInfo ? `✅ ${zcaInfo.name}` : `✅ ${getGroupName(groupId)}`;
              const autoLine = autoEnabled ? `\n🎉 welcome+follow BẬT (owner là admin)` : `\n⏸️ owner không phải admin`;
              
              await sendGroupMsg(ctx, groupId, `${nameLine}\n🆔 ID: ${groupId}\n${adminLine}${memberLine ? '\n' + memberLine : ''}${autoLine}\n🔄 Restart gateway để áp dụng.`);
              _invalidateZcaApi();
            } catch (e) {
              logger.warn(`[openclaw-zalo-mod] ${cmdPrefix}rules groupid failed: ${e.message}`);
              await sendGroupMsg(ctx, groupId, `🆔 Group ID: ${groupId}\n⚠️ Lỗi: ${e.message}`);
            }
            return { handled: true };
          }
          if (sub === 'groupid-add-all') {
            await processGroupidAddAll(ctx, groupId, true, groupId);
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

      // ── Admin check for violation logging ──────────────────
      const gAdmins = groupNames[groupId]?.admins || getGroupAdmins(groupId) || [];
      const creatorId = groupNames[groupId]?.creatorId;
      const isBotOrOwnerAdmin = ownerId && (gAdmins.map(String).includes(ownerId) || String(creatorId || '') === ownerId);

      // ── Silent mode check ─────────────────────────────────
      const silentMode = store.getSetting(groupId, 'silent', true);
      if (silentMode) {
        // Anti-spam detect silently even in silent mode (only for managed groups where bot/owner is admin)
        if (isBotOrOwnerAdmin) {
          const spamType = spamTracker.check(senderId, content);
          if (spamType) {
            store.addViolation(groupId, senderId, senderName, spamType, content);
            await store.saveViolations();
            // Sync to memory
            await appendToMemoryFile(groupId, 'violations.md', `| ${nowShort()} | ${senderName} | ${spamType} | ${content.slice(0, 40)} |`);
            logger.info(`[openclaw-zalo-mod] spam detected: ${spamType} from ${senderName}`);
          }
        }
        // Tracking: ghi lịch sử chat (kể cả silent mode)
        if (store.getSetting(groupId, 'tracking', false)) {
          await appendChatLog(groupId, senderName, content);
        }
        return { handled: true }; // silent — don't forward to LLM
      }

      // Non-silent mode: still anti-spam detect (only for managed groups where bot/owner is admin)
      if (isBotOrOwnerAdmin) {
        const spamType = spamTracker.check(senderId, content);
        if (spamType) {
          store.addViolation(groupId, senderId, senderName, spamType, content);
          await store.saveViolations();
          // Sync to memory
          await appendToMemoryFile(groupId, 'violations.md', `| ${nowShort()} | ${senderName} | ${spamType} | ${content.slice(0, 40)} |`);
          logger.info(`[openclaw-zalo-mod] ❌ BLOCKED by anti-spam: type=${spamType} sender=${senderName} msg="${content.slice(0, 60)}"`);
          return { handled: true }; // spam always silently blocked
        }
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
      const conversationId = String(ctx?.conversationId || '');
      const groupId = conversationId.startsWith('group:') ? conversationId.replace(/^group:/, '') : '';
      if (groupId && typeof event?.prompt === 'string') {
        const modePrompt = buildActiveModePrompt(groupId);
        if (modePrompt && !event.prompt.includes('[GROUP MODE CONTEXT]')) {
          event.prompt = `${modePrompt}\n\n${event.prompt}`;
        }
      }
      let userMsg = '';
      if (event && Array.isArray(event.messages) && event.messages.length > 0) {
        const lastMsg = event.messages[event.messages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          userMsg = String(lastMsg.content || '');
        }
      }
      let lc = userMsg.toLowerCase().replace(/['’]/g, '').trim();
      const ownerCmd = cmdPrefix + 'ownerid';
      
      let matched = (lc === 'im admin' || lc === ownerCmd);
      if (!matched && event && typeof event.prompt === 'string') {
        const promptLc = event.prompt.toLowerCase().replace(/['’]/g, '').trim();
        const re = new RegExp(`(?:im admin|${ownerCmd.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')})\\s*$`, 'i');
        if (re.test(promptLc)) {
          matched = true;
        }
      }
      
      if (!matched) return;
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
          if (patched) {
            ownerId = senderId;
            adminIds.add(senderId);
          }
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

    logger.info(`[openclaw-zalo-mod] loaded — bot="${botName}" prefix="${cmdPrefix}" owner=${ownerId || 'none'} groups=${watchGroupIds.length} groupNames=${Object.keys(groupNames).length}`);
  },
});

export default plugin;

