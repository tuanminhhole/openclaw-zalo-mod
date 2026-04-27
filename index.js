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
 * @author Kent x Williams
 * @version 1.2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

// ── Plugin directory (for data storage) ──────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Auto-config helpers ──────────────────────────────────────
// Resolve OPENCLAW_HOME from plugin install path:
// plugin at {OPENCLAW_HOME}/extensions/zalo-mod/ → 2 levels up
const _openclawHome = path.resolve(__dirname, '..', '..');

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
    config.plugins.entries['zalo-mod'] = config.plugins.entries['zalo-mod'] || { enabled: true };
    const existing = config.plugins.entries['zalo-mod'].config || {};

    let changed = false;
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
      if (logger) logger.info(`[zalo-mod] auto-added binding: zalouser → ${agentId}`);
    } else if (agentId && Array.isArray(config.bindings)) {
      const hasZalo = config.bindings.some(b => b.match?.channel === 'zalouser');
      if (!hasZalo) {
        config.bindings.push({ agentId, match: { channel: 'zalouser' } });
        changed = true;
        if (logger) logger.info(`[zalo-mod] auto-added binding: zalouser → ${agentId}`);
      }
    }

    // Auto-provision groups config: enable all groups with no mention required
    if (config.channels?.zalouser && !config.channels.zalouser.groups) {
      config.channels.zalouser.groups = { '*': { enabled: true, requireMention: false } };
      changed = true;
      if (logger) logger.info(`[zalo-mod] auto-added groups config: all groups enabled`);
    }

    if (changed) {
      config.plugins.entries['zalo-mod'].config = existing;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
      if (logger) logger.info(`[zalo-mod] auto-patched openclaw.json config`);
    }
    return changed;
  } catch (e) {
    if (logger) logger.warn(`[zalo-mod] auto-patch config failed: ${e.message}`);
    return false;
  }
}

// ── Constants ────────────────────────────────────────────────
const PLUGIN_ID = 'zalo-mod';

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
function buildNoiQuy(groupName) {
  return `📋 NỘI QUY — ${groupName}
━━━━━━━━━━━━━━━━━━

1️⃣ Hỏi thoải mái - không câu hỏi nào là ngu, ai cũng từng mới
2️⃣ Biết gì chia sẻ nấy - văn hoá cho đi là nhận lại
3️⃣ Tôn trọng nhau - không toxic, không chê trình độ
4️⃣ Không spam - quảng cáo
5️⃣ Tôn trọng thời gian — nói rõ vấn đề

⚠️ Mức xử lý:
• Lần 1: Nhắc
• Lần 2: Warn
• Lần 3: Kick

📌 Hỏi thêm: @Williams [câu hỏi]`;
}

function buildMenu(botName) {
  return `🤖 ${botName.toUpperCase()} — MENU LỆNH
━━━━━━━━━━━━━━━━━━

📋 Thông tin
  /noi-quy   — Xem nội quy nhóm
  /menu   — Menu lệnh này
  /huong-dan    — Hướng dẫn dùng bot
  /groupid    — Xem ID của group này

💬 Hỏi đáp
  @${botName} [câu hỏi] — Hỏi bot bất kỳ điều gì

🔧 Admin (chỉ admin dùng được)
  /warn @name [lý do]  — Cảnh cáo member
  /note [text]           — Ghi chú admin
  /report                  — Báo cáo vi phạm
  /memory                  — Lưu memory digest
  /rules                 — Cấu hình bot

━━━━━━━━━━━━━━━━━━
💡 Tip: Tag @${botName} để hỏi thêm!`;
}

function buildHuongDan(botName) {
  return `📖 HƯỚNG DẪN SỬ DỤNG BOT ${botName.toUpperCase()}
━━━━━━━━━━━━━━━━━━

👋 ${botName} là trợ lý AI của nhóm này.

🗣️ Cách giao tiếp:
  • Tag trực tiếp: @${botName} [câu hỏi bất kỳ]
  • Gõ lệnh: /[tên lệnh]

📌 Ví dụ:
  @${botName} giải thích quy trình XYZ
  /noi-quy → xem nội quy
  /menu → xem tất cả lệnh

⚠️ Lưu ý:
  • Bot KHÔNG tự reply tin thường — cần @tag hoặc gõ lệnh
  • Lệnh admin: /report /warn (chỉ admin dùng được)

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

function buildWelcome(memberName, botName) {
  return `👋 Chào mừng ${memberName} đã join nhóm!

Mình là bot và đây là hướng dẫn để bác có thể sử dụng mình trong Group:
📋 /noi-quy  - Xem nội quy nhóm (đọc trước nhé!)
📖 /huong-dan hoặc /menu - Hướng dẫn dùng bot, menu của bot
💬 @${botName} [câu hỏi bất kỳ] - Hỏi bot bất cứ điều gì

Group này mình hỗ trợ AE dùng repo Openclaw Setup và setup bot chạy cho ae trải nghiệm.

Mong các ae đã cài đặt đc r thì chia sẻ kinh nghiệm với ae khác khi cần vì mình làm ra repo cũng đang open source cho tất cả ae.

Ngoài ra khi có bản update mới mình cũng sẽ báo lên đây và hỗ trợ ae cập nhật.

Chào mừng bác! 🎉 Nếu có bất kỳ thăc mắc nào hoặc cần hỗ trợ cứ nhắn lên đừng ngại nha!`;
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
  kind: 'runtime',

  register(api) {
    const logger = api.logger;
    const cfg = api.config;

    // Plugin config: read from api.pluginConfig (OpenClaw SDK) or fallback
    const pluginCfg = api.pluginConfig || cfg?.plugins?.entries?.['zalo-mod'] || {};
    const groupNames    = pluginCfg.groupNames || {};  // map groupId → display name
    const botName       = String(pluginCfg.botName || 'Bot');
    const zaloNames     = (pluginCfg.zaloDisplayNames || []).map(String);
    const botNames      = [botName, ...zaloNames].filter(Boolean);
    const adminIds      = new Set((pluginCfg.adminIds || []).map(String));
    const ownerId       = String(pluginCfg.ownerId || '');  // Zalo ID chủ nhân bot
    const allowedDmUsers = new Set((pluginCfg.allowedDmUsers || []).map(String)); // DM whitelist
    const welcomeEnabled = pluginCfg.welcomeEnabled !== false;
    const spamRepeatN   = Number(pluginCfg.spamRepeatN || 5);
    const spamWindowMs  = Number(pluginCfg.spamWindowSeconds || 300) * 1000;
    const watchGroupIds = (pluginCfg.watchGroupIds || []).map(String).filter(Boolean);
    const welcomePollSec = Number(pluginCfg.welcomePollSeconds || 30);

    /** Tra tên group theo ID — dùng groupNames map, fallback 'Nhóm' */
    function getGroupName(gId) {
      const plain = String(gId || '').replace(/^group:/, '');
      return groupNames[plain] || 'Nhóm';
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
      const slug = pluginCfg.memoryGroupSlug || _slugify(groupNames[plain] || 'nhom-' + plain.slice(-6));
      return path.join(workspaceDir, 'skills/memory/zalo-groups', slug);
    }
    /** Trả về slug cho 1 group */
    function getMemorySlug(groupId) {
      const plain = String(groupId || '').replace(/^group:/, '');
      return pluginCfg.memoryGroupSlug || _slugify(groupNames[plain] || 'nhom-' + plain.slice(-6));
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
            'version: 1.0.0',
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
          ].join('\n');
          await fs.writeFile(skillMdPath, skillContent, 'utf8');
          logger.info('[zalo-mod] auto-created skills/zalo-group-admin/SKILL.md');
        }

        // 2. Create memory INDEX.md cho mỗi group đang follow
        for (const gId of watchGroupIds) {
          const isFollowed = store.getSetting(gId, 'follow', false);
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
              '> Auto-generated by zalo-mod plugin. Plugin sẽ tự cập nhật khi có events.',
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
            logger.info(`[zalo-mod] auto-created memory dir for ${getGroupName(gId)} (${gId})`);
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
            logger.info(`[zalo-mod] auto-detected botName="${detectedBotName}" from IDENTITY.md`);
          }

          // 4b. Scan session data for groups
          const agentId = cfg?.agents?.list?.[0]?.id;
          const groups = await _scanGroupsFromSessions(_openclawHome, agentId);
          if (groups.length > 0) {
            patch.watchGroupIds = groups.map(g => g.groupId);
            // Build groupNames map: mỗi group có tên riêng
            const namesMap = {};
            for (const g of groups) namesMap[g.groupId] = g.groupName;
            patch.groupNames = { ...(pluginCfg.groupNames || {}), ...namesMap };
            logger.info(`[zalo-mod] auto-detected ${groups.length} group(s) from sessions: ${groups.map(g => g.groupName).join(', ')}`);
          } else {
            logger.info('[zalo-mod] no group sessions found yet — user should chat in a group then run /groupid');
          }

          if (Object.keys(patch).length > 0) {
            await _patchOpenclawConfig(_openclawHome, patch, logger);
          }
        }
      } catch (e) {
        logger.warn(`[zalo-mod] bootstrap workspace files failed: ${e.message}`);
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
        logger.warn(`[zalo-mod] memory append failed (${filename}): ${e.message}`);
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
            logger.info(`[zalo-mod] chat-log rotated → ${bakPath}`);
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
        logger.warn(`[zalo-mod] chat-log append failed: ${e.message}`);
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

        logger.info(`[zalo-mod] memory digest — warns=${totalWarns}, violations=${totalVio} for group=${gId}`);
        return { warnCount: totalWarns, vioCount: totalVio };
      } catch (e) {
        logger.warn(`[zalo-mod] writeMemoryDigest failed: ${e.message}`);
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
        logger.info(`[zalo-mod] Zalo session loaded (imei=${_zaloImei.slice(0, 8)}...)`);
        return _zaloCookies;
      } catch (e) {
        logger.warn(`[zalo-mod] loadZaloSession failed: ${String(e)}`);
        return null;
      }
    }

    // Helper: send reply natively via OpenClaw Zalouser API
    async function sendGroupMsg(ctx, groupId, text) {
      if (!groupId || !text) return;
      const profile = ctx?.accountId || 'default';
      logger.info(`[zalo-mod] sendGroupMsg → threadId=${groupId}, profile=${profile}, textLen=${text.length}`);
      try {
        const { sendMessageZalouser } = await import('file:///usr/local/lib/node_modules/openclaw/dist/extensions/zalouser/test-api.js');
        const result = await sendMessageZalouser(String(groupId), String(text), { 
          isGroup: true, 
          profile,
          textMode: 'markdown'
        });
        if (result && !result.ok) {
           logger.error(`[zalo-mod] Native Zalo send failed: ${result.error}`);
        } else {
           logger.info(`[zalo-mod] Native message delivered to group ${groupId}`);
        }
      } catch (err) {
        logger.error(`[zalo-mod] Native Zalo send exception: ${err.message}`);
      }
    }

    // Helper: send DM (non-group) via Zalouser API
    async function sendDmMsg(ctx, userId, text) {
      if (!userId || !text) return;
      const profile = ctx?.accountId || 'default';
      try {
        const { sendMessageZalouser } = await import('file:///usr/local/lib/node_modules/openclaw/dist/extensions/zalouser/test-api.js');
        await sendMessageZalouser(String(userId), String(text), {
          isGroup: false,
          profile,
          textMode: 'markdown'
        });
      } catch (err) {
        logger.error(`[zalo-mod] DM send failed to ${userId}: ${err.message}`);
      }
    }

    function isAdmin(senderId) {
      return adminIds.size === 0 || adminIds.has(String(senderId));
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
        logger.warn(`[zalo-mod] save member-dir failed: ${e.message}`);
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
        'file:///usr/local/lib/node_modules/openclaw/dist/extensions/zalouser/test-api.js',
        'openclaw/dist/extensions/zalouser/test-api.js',
      ];
      for (const p of paths) {
        try {
          _G.zaloApiModule = await import(p);
          return _G.zaloApiModule;
        } catch { /* thử path tiếp theo */ }
      }
      // Tất cả path fail
      logger.warn(`[zalo-mod] [WATCHER] zalouser API not available — member watcher disabled. Restart gateway nếu vừa cài xong OpenClaw.`);
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
        if (_pollFailCounts[failKey] === 1 || _pollFailCounts[failKey] % 10 === 0) {
          logger.warn(`[zalo-mod] [WATCHER] poll failed for group ${groupId} (x${_pollFailCounts[failKey]}): ${e.message}`);
        }
        return null;
      }
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
        logger.info(`[zalo-mod] [WATCHER] initial snapshot for group ${groupId}: ${currentIds.size} members (member-dir updated)`);
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
        logger.info(`[zalo-mod] [WATCHER] ${newMembers.length} new member(s) detected but all already welcomed (dedup)`);
        return;
      }

      logger.info(`[zalo-mod] [WATCHER] ${toWelcome.length} new member(s) in group ${groupId}: ${toWelcome.map(m => m.name || m.id).join(', ')}`);


      // Send welcome for new members (batch — don't spam if many join at once)
      for (const member of toWelcome.slice(0, 5)) {
        const memberName = member.name || 'bạn';
        try {
          await sendGroupMsg({ accountId: 'default' }, groupId, buildWelcome(memberName, botName));
          await appendToMemoryFile(groupId, 'chat-highlights.md', `| ${nowShort()} | SYSTEM | Welcome: ${memberName} joined (detected by watcher) |`);
          // Mark as welcomed (dedup for 1 hour)
          _G.welcomedDedup.add(dedupKey(groupId, member.id));
          setTimeout(() => _G.welcomedDedup.delete(dedupKey(groupId, member.id)), 3600000);
          logger.info(`[zalo-mod] [WATCHER] welcome sent for ${memberName} in group ${groupId}`);
        } catch (e) {
          logger.error(`[zalo-mod] [WATCHER] welcome send failed for ${memberName}: ${e.message}`);
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
          logger.info(`[zalo-mod] [WATCHER] no watchGroupIds configured — welcome watcher disabled`);
        }
        return;
      }

      // CRITICAL: Clear any existing timer from previous register() hot-reload
      if (_G.watcherTimer) {
        clearInterval(_G.watcherTimer);
        _G.watcherTimer = null;
        logger.info(`[zalo-mod] [WATCHER] cleared previous watcher timer (hot-reload detected)`);
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
        logger.info(`[zalo-mod] [WATCHER] starting member watcher — polling ${activeGroups.length}/${watchGroupIds.length} group(s), poll every ${intervalMs/1000}s`);
        if (activeGroups.length > 0) logger.info(`[zalo-mod] [WATCHER] active: ${activeGroups.map(g => getGroupName(g)).join(', ')}`);
        if (skippedGroups.length > 0) logger.info(`[zalo-mod] [WATCHER] skipped (welcome off): ${skippedGroups.map(g => getGroupName(g)).join(', ')}`);

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
              logger.warn(`[zalo-mod] [WATCHER] poll error for ${gId}: ${e.message}`);
            }
            // Delay 3s giữa mỗi group (only between actual polls)
            if (watchGroupIds.length > 1) await new Promise(r => setTimeout(r, 1000));
          }
        }, intervalMs);
      }, 30000); // 30s delay for zalouser to connect
    }

    // ── Owner DM Command Handler ──────────────────────────────
    async function handleOwnerDm(content, senderId, ctx) {
      const slashMatch = content.match(/^(\/[a-z][a-z0-9-]*)(.*)$/i);
      if (!slashMatch) return null; // không phải lệnh → forward LLM

      const command = slashMatch[1].toLowerCase();
      const cmdArgs = slashMatch[2].trim();
      const args = cmdArgs ? cmdArgs.split(/\s+/) : [];

      if (command !== '/rules') return null; // chỉ xử lý /rules

      const sub = args[0]?.toLowerCase();
      if (!sub) {
        await sendDmMsg(ctx, senderId,
          `🔐 OWNER PANEL — /rules\n━━━━━━━━━━━━━━━━━━\n\n🎉 Welcome (chào mem mới):\n  /rules welcome-list\n  /rules welcome <groupId> on/off\n\n👁️ Follow (theo dõi chat + memory):\n  /rules follow-list\n  /rules follow <groupId> on/off\n\n💬 DM Whitelist:\n  /rules dm-list\n  /rules dm-add <tên member>\n  /rules dm-remove <tên member>\n\n📊 /rules status`
        );
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

      // ── welcome <groupId> on/off
      if (sub === 'welcome' && args[1]) {
        const targetGid = args[1];
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
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: /rules welcome <groupId> on/off');
        }
        return { handled: true };
      }

      // ── dm-list: danh sách users được DM
      if (sub === 'dm-list') {
        if (allowedDmUsers.size === 0) {
          await sendDmMsg(ctx, senderId, '💬 DM Whitelist: TRỐNG\n\nTất cả mọi người đều có thể DM bot.\nDùng /rules dm-add <tên> để giới hạn.');
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
          await sendDmMsg(ctx, senderId, `❌ Không tìm thấy member tên "${nameQuery}" trong danh sách.\nDùng /rules welcome-list để kiểm tra member directory.`);
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
          const on = store.getSetting(gId, 'follow', false);
          const tracking = store.getSetting(gId, 'tracking', false);
          lines.push(`${on ? '✅' : '❌'} ${name}\n   ID: ${gId} | Tracking: ${tracking ? 'BẬT' : 'TẮT'}`);
        }
        if (watchGroupIds.length === 0) lines.push('⚠️ Chưa có group nào.');
        lines.push('\n💡 Follow = lưu memory + chat-log cho group đó.');
        await sendDmMsg(ctx, senderId, lines.join('\n'));
        return { handled: true };
      }

      // ── follow <groupId> on/off
      if (sub === 'follow' && args[1]) {
        const targetGid = args[1];
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
                '> Auto-generated by zalo-mod plugin.', '',
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
          await sendDmMsg(ctx, senderId, '⚠️ Cú pháp: /rules follow <groupId> on/off');
        }
        return { handled: true };
      }

      // ── status: tổng quan
      if (sub === 'status') {
        const welcomeOn = watchGroupIds.filter(gId => store.getSetting(gId, 'welcome', true)).length;
        const followOn = watchGroupIds.filter(gId => store.getSetting(gId, 'follow', false)).length;
        const totalMembers = Object.values(_memberDir).reduce((sum, m) => sum + Object.keys(m).length, 0);
        await sendDmMsg(ctx, senderId,
          `🔐 OWNER STATUS\n━━━━━━━━━━━━━━━━━━\n📡 Groups: ${watchGroupIds.length}\n🎉 Welcome: ${welcomeOn} bật\n👁️ Follow: ${followOn} bật\n👥 Members tracked: ${totalMembers}\n💬 DM whitelist: ${allowedDmUsers.size === 0 ? 'Tất cả' : allowedDmUsers.size + ' users'}\n🤖 Bot: ${botName}`
        );
        return { handled: true };
      }

      return null; // lệnh /rules không nhận ra → forward LLM
    }

    // ── Event: before_dispatch (main hook) ───────────────────
    api.on('before_dispatch', async (event, ctx) => {
      // 1. Chỉ bắt event từ Zalo
      if (ctx?.channelId !== 'zalouser') return;
      
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
        // Owner DM → config commands hoặc forward LLM
        if (ownerId && senderId === ownerId) {
          const ownerResult = await handleOwnerDm(content, senderId, ctx);
          if (ownerResult) return ownerResult;
          return; // forward to LLM
        }

        // Allowed user → forward to LLM
        if (allowedDmUsers.size === 0 || allowedDmUsers.has(senderId)) return;

        // Không nằm trong whitelist → block im lặng
        logger.info(`[zalo-mod] DM blocked from ${senderName} (${senderId}) — not in allowedDmUsers`);
        return { handled: true };
      }

      const groupId = rawConvId.replace(/^group:/, '');

      // ── Extract slash command from anywhere in message ─────
      // Support: "/command args" AND "@BotName text /command args"
      const slashMatch = content.match(/(?:^|\s)(\/[a-z][a-z0-9-]*)(.*)$/i);
      if (slashMatch) {
        const command = slashMatch[1].toLowerCase();
        const cmdArgs = slashMatch[2].trim();
        const args    = cmdArgs ? cmdArgs.split(/\s+/) : [];
        // Text before the slash command (e.g. "@Bot mai 5h @Mkt đi đá banh /note" → "mai 5h @Mkt đi đá banh")
        const botMentionRe = new RegExp(botNames.map(n => '@' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
        const textBefore = content.slice(0, slashMatch.index + (slashMatch[0].startsWith(' ') ? 1 : 0)).trim()
          .replace(botMentionRe, '').replace(/\s{2,}/g, ' ').trim(); // strip only bot @mentions

        // /noi-quy (nội quy)
        if (command === '/noi-quy') {
          await sendGroupMsg(ctx, groupId, buildNoiQuy(getGroupName(groupId)));
          return { handled: true };
        }

        // /menu | /huong-dan
        if (command === '/menu') {
          let menu = buildMenu(botName);
          // Nếu sender là owner → hiện thêm owner commands
          if (ownerId && senderId === ownerId) {
            menu += '\n\n👑 OWNER (DM riêng với bot):\n  /rules welcome-list\n  /rules welcome <groupId> on/off\n  /rules follow-list\n  /rules follow <groupId> on/off\n  /rules dm-list\n  /rules dm-add <tên>\n  /rules dm-remove <tên>\n  /rules status';
          }
          await sendGroupMsg(ctx, groupId, menu);
          return { handled: true };
        }
        if (command === '/huong-dan') {
          await sendGroupMsg(ctx, groupId, buildHuongDan(botName));
          return { handled: true };
        }

        // /groupid — scan sessions, auto-update config, reply groups list
        if (command === '/groupid') {
          try {
            const agentId = cfg?.agents?.list?.[0]?.id;
            const groups = await _scanGroupsFromSessions(_openclawHome, agentId);

            // Always include current group
            if (!groups.some(g => g.groupId === groupId)) {
              groups.push({ groupId, groupName: '(group hiện tại)' });
            }

            // Build patch — update cả groupNames map lẫn watchGroupIds
            const namesMap = {};
            for (const g of groups) {
              if (g.groupName && g.groupName !== '(group hiện tại)') {
                namesMap[g.groupId] = g.groupName;
              }
            }
            const patch = {
              watchGroupIds: groups.map(g => g.groupId),
              groupNames: { ...(pluginCfg.groupNames || {}), ...namesMap },
            };
            // Auto-detect botName if not set
            if (!pluginCfg.botName || pluginCfg.botName === 'Bot') {
              const detectedName = await _readBotNameFromIdentity(workspaceDir);
              if (detectedName) {
                patch.botName = detectedName;
                patch.zaloDisplayNames = [detectedName];
              }
            }

            const patched = await _patchOpenclawConfig(_openclawHome, patch, logger, true);

            // Build reply
            const lines = [`🆔 Groups đã cập nhật config (${groups.length}):`];
            for (const g of groups) {
              lines.push(`  • ${g.groupName} — ${g.groupId}`);
            }
            if (patched) {
              lines.push('');
              lines.push('✅ Đã tự động cập nhật openclaw.json!');
              lines.push('🔄 Restart gateway để áp dụng config mới.');
            } else {
              lines.push('');
              lines.push('ℹ️ Config đã có sẵn, không cần cập nhật.');
            }
            await sendGroupMsg(ctx, groupId, lines.join('\n'));
          } catch (e) {
            logger.warn(`[zalo-mod] /groupid auto-config failed: ${e.message}`);
            await sendGroupMsg(ctx, groupId,
              `🆔 Group ID: ${groupId}\n⚠️ Auto-config lỗi: ${e.message}`
            );
          }
          return { handled: true };
        }

        // /report — admin only
        if (command === '/report') {
          if (!isAdmin(senderId)) return { handled: true };
          await reloadStore();
          const vio = getStoreDataForGroup(store.getAllViolations(), groupId);
          const wrn = getStoreDataForGroup(store.getAllWarned(), groupId);
          const text = buildReport(groupId, vio, wrn);
          await sendGroupMsg(ctx, groupId, text);
          return { handled: true };
        }

        // /warn @name [reason] — admin only
        if (command === '/warn') {
          if (!isAdmin(senderId)) return { handled: true };
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
          if (!isAdmin(senderId)) return { handled: true };
          const noteText = textBefore || args.join(' ');
          if (!noteText) return { handled: true };
          store.addViolation(groupId, 'admin-note', senderName, 'note', noteText);
          await store.saveViolations();
          // Sync to memory
          await appendToMemoryFile(groupId, 'admin-notes.md', `| ${nowShort()} | ${senderName} | ${noteText} |`);
          await sendGroupMsg(ctx, groupId, `📝 Ghi nhận: ${noteText}`);
          return { handled: true };
        }

        // /rules — admin control panel
        if (command === '/rules') {
          if (!isAdmin(senderId)) return { handled: true };
          const sub = args[0]?.toLowerCase();
          if (!sub) {
            await sendGroupMsg(ctx, groupId,
              `⚙️ ADMIN COMMANDS — /rules\n━━━━━━━━━━━━━━━━━━\n\n🔇 Silent Mode:\n  /rules silent-on  — Bot chỉ reply khi @tag\n  /rules silent-off — Bot reply mọi tin\n\n🎉 Welcome:\n  /rules welcome-on  — Bật chào member mới\n  /rules welcome-off — Tắt chào\n\n📋 Tracking:\n  /rules tracking-on  — Bật ghi lịch sử chat\n  /rules tracking-off — Tắt ghi lịch sử\n\n📊 /rules status`
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
            const silent   = store.getSetting(groupId, 'silent', true);
            const welcome  = store.getSetting(groupId, 'welcome', true);
            const tracking = store.getSetting(groupId, 'tracking', false);
            await sendGroupMsg(ctx, groupId,
              `⚙️ CẤU HÌNH BOT\n━━━━━━━━━━━━━━━━━━\n🔇 Silent Mode: ${silent ? 'BẬT' : 'TẮT'}\n🎉 Welcome: ${welcome ? 'BẬT' : 'TẮT'}\n📋 Tracking: ${tracking ? 'BẬT' : 'TẮT'}`
            );
            return { handled: true };
          }
          return { handled: true };
        }

        // /memory — admin manual digest (optionally with note text)
        if (command === '/memory') {
          if (!isAdmin(senderId)) return { handled: true };
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
        logger.info(`[zalo-mod] @mention from ${senderName} in group ${groupId}: ${content.slice(0, 80)}`);
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
          logger.info(`[zalo-mod] injected file-context note for @mention in group ${groupId}`);
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
          await sendGroupMsg(ctx, groupId, '👑 Hiện tại bot cho phép tất cả member dùng lệnh admin. Liên hệ người tạo group để biết admin chính thức.');
          return { handled: true };
        }

        // For all other @mention questions → forward to LLM
        logger.info(`[zalo-mod] forwarding to LLM: ${content.slice(0, 80)}`);
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
          logger.info(`[zalo-mod] spam detected: ${spamType} from ${senderName}`);
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
        logger.info(`[zalo-mod] ❌ BLOCKED by anti-spam: type=${spamType} sender=${senderName} msg="${content.slice(0, 60)}"`);
        return { handled: true }; // spam always silently blocked
      }

      // Tracking: ghi lịch sử chat (non-silent, non-mention)
      if (store.getSetting(groupId, 'tracking', false)) {
        await appendChatLog(groupId, senderName, content);
      }

      // Non-mention, non-slash, non-spam, non-silent → let LLM decide
      return;
    }, { priority: 300 }); // priority 300 = runs before relay plugin (200)

    // Start member watcher for welcome messages
    startMemberWatcher();

    logger.info(`[zalo-mod] loaded — bot="${botName}" owner=${ownerId || 'none'} adminIds=${adminIds.size || 'any'} watchGroups=${watchGroupIds.length} groupNames=${Object.keys(groupNames).length}`);
  },
});

export default plugin;
