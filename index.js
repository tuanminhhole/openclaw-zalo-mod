/**
 * openclaw-zalo-mod — Zero-Token Zalo Group Moderation Plugin
 * ─────────────────────────────────────────────────────────────
 * Hook vào before_dispatch của zalouser channel.
 * Xử lý slash commands + anti-spam tức thì, 0 token.
 * @mention → để lọt lên LLM agent bình thường.
 * Tin thường → block hoàn toàn (silent).
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
  /noi-quy    — Xem nội quy nhóm
  /menu       — Menu lệnh này
  /huong-dan  — Hướng dẫn dùng bot
  /groupid    — Xem ID của group này

💬 Hỏi đáp
  @${botName} [câu hỏi] — Hỏi bot bất kỳ điều gì

🔧 Admin (chỉ admin dùng được)
  /warn @name [lý do]  — Cảnh cáo member
  /note [text]          — Ghi chú admin
  /report               — Báo cáo vi phạm
  /memory               — Lưu memory digest
  /rules                — Cấu hình bot

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
  /menu    → xem tất cả lệnh

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
📋 /noi-quy   - Xem nội quy nhóm (đọc trước nhé!)
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
    const groupName     = String(pluginCfg.groupName || 'Nhóm');
    const botName       = String(pluginCfg.botName || 'Bot');
    const zaloNames     = (pluginCfg.zaloDisplayNames || []).map(String);
    const botNames      = [botName, ...zaloNames].filter(Boolean);
    const adminIds      = new Set((pluginCfg.adminIds || []).map(String));
    const welcomeEnabled = pluginCfg.welcomeEnabled !== false;
    const spamRepeatN   = Number(pluginCfg.spamRepeatN || 3);
    const spamWindowMs  = Number(pluginCfg.spamWindowSeconds || 300) * 1000;
    const watchGroupIds = (pluginCfg.watchGroupIds || []).map(String).filter(Boolean);
    const welcomePollSec = Number(pluginCfg.welcomePollSeconds || 30);

    // Data dir — store JSON data alongside the plugin code
    const dataDir = path.join(__dirname, 'data');

    // Workspace + Memory dir
    const workspaceDir  = String(cfg?.agents?.defaults?.workspace || '/mnt/d/SecondBrain/.openclaw/workspace');

    // Memory dir — skills/memory/zalo-groups/{group-slug}/
    const autoSlug = groupName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default-group';
    const memoryGroupSlug = String(pluginCfg.memoryGroupSlug || autoSlug);
    const memoryDir = path.join(workspaceDir, 'skills/memory/zalo-groups', memoryGroupSlug);

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

    // ── Memory Sync Helpers ──────────────────────────────────
    function nowShort() {
      return new Date().toISOString().slice(0, 16).replace('T', ' ');
    }

    async function appendToMemoryFile(filename, line) {
      try {
        const filePath = path.join(memoryDir, filename);
        await fs.mkdir(memoryDir, { recursive: true });
        await fs.appendFile(filePath, line + '\n', 'utf8');
      } catch (e) {
        logger.warn(`[zalo-mod] memory append failed (${filename}): ${e.message}`);
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
          `# ${groupName} — Members & Warn Log\n`,
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
        await fs.writeFile(path.join(memoryDir, 'members.md'), memberLines.join('\n') + '\n', 'utf8');

        // Overwrite violations.md with full log
        const vioLines = [
          `# ${groupName} — Vi Phạm\n`,
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
        await fs.writeFile(path.join(memoryDir, 'violations.md'), vioLines.join('\n') + '\n', 'utf8');

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

    function isAdmin(senderId) {
      return adminIds.size === 0 || adminIds.has(String(senderId));
    }

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

    async function loadZaloApi() {
      if (_G.zaloApiModule) return _G.zaloApiModule;
      try {
        _G.zaloApiModule = await import('file:///usr/local/lib/node_modules/openclaw/dist/extensions/zalouser/test-api.js');
        return _G.zaloApiModule;
      } catch (e) {
        logger.warn(`[zalo-mod] [WATCHER] failed to load zalouser API: ${e.message}`);
        return null;
      }
    }

    async function pollGroupMembers(groupId) {
      try {
        const api = await loadZaloApi();
        if (!api?.listZaloGroupMembers) {
          logger.warn(`[zalo-mod] [WATCHER] listZaloGroupMembers not available`);
          return null;
        }
        const members = await api.listZaloGroupMembers('default', String(groupId));
        if (!Array.isArray(members)) return null;
        return members.map(m => ({
          id: String(m.userId || m.id || ''),
          name: String(m.displayName || m.name || m.zaloName || ''),
        })).filter(m => m.id);
      } catch (e) {
        logger.warn(`[zalo-mod] [WATCHER] poll failed for group ${groupId}: ${e.message}`);
        return null;
      }
    }

    async function checkForNewMembers(groupId) {
      const members = await pollGroupMembers(groupId);
      if (!members) return;

      const currentIds = new Set(members.map(m => m.id));
      const prevIds = _G.memberSnapshots.get(groupId);

      if (!prevIds) {
        // First poll — just save snapshot, don't welcome everyone
        _G.memberSnapshots.set(groupId, currentIds);
        logger.info(`[zalo-mod] [WATCHER] initial snapshot for group ${groupId}: ${currentIds.size} members`);
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

      // Check welcome setting
      const welcomeOn = store.getSetting(groupId, 'welcome', true);
      if (!welcomeOn) {
        logger.info(`[zalo-mod] [WATCHER] welcome disabled for group ${groupId}, skipping`);
        return;
      }

      // Send welcome for new members (batch — don't spam if many join at once)
      for (const member of toWelcome.slice(0, 5)) {
        const memberName = member.name || 'bạn';
        try {
          await sendGroupMsg({ accountId: 'default' }, groupId, buildWelcome(memberName, botName));
          await appendToMemoryFile('chat-highlights.md', `| ${nowShort()} | SYSTEM | Welcome: ${memberName} joined (detected by watcher) |`);
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
      logger.info(`[zalo-mod] [WATCHER] starting member watcher for ${watchGroupIds.length} group(s), poll every ${intervalMs/1000}s`);

      // Initial snapshot after a delay (let zalouser fully connect first)
      _G.initTimer = setTimeout(async () => {
        _G.initTimer = null;
        await ensureStore();
        for (const gId of watchGroupIds) {
          await checkForNewMembers(gId);
        }
        // Then start periodic polling
        _G.watcherTimer = setInterval(async () => {
          for (const gId of watchGroupIds) {
            try {
              await checkForNewMembers(gId);
            } catch (e) {
              logger.warn(`[zalo-mod] [WATCHER] poll error for ${gId}: ${e.message}`);
            }
          }
        }, intervalMs);
      }, 30000); // 30s delay for zalouser to connect
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

      if (!content) return { handled: true }; // empty content — skip

      const rawConvId = String(ctx.conversationId || event.conversationId || '');
      const isGroupMsg = rawConvId.startsWith('group:');

      // DMs — let pass through to LLM agent (no moderation needed)
      if (!isGroupMsg) return; // undefined = forward to LLM

      const groupId   = rawConvId.replace(/^group:/, '');
      const senderId  = String(ctx.senderId || event.senderId || '');
      const senderName = String(event.senderName || senderId);

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

        // /noi-quy
        if (command === '/noi-quy') {
          await sendGroupMsg(ctx, groupId, buildNoiQuy(groupName));
          return { handled: true };
        }

        // /menu | /huong-dan
        if (command === '/menu') {
          await sendGroupMsg(ctx, groupId, buildMenu(botName));
          return { handled: true };
        }
        if (command === '/huong-dan') {
          await sendGroupMsg(ctx, groupId, buildHuongDan(botName));
          return { handled: true };
        }

        // /groupid — trả về group ID hiện tại (dùng để config watchGroupIds)
        if (command === '/groupid') {
          await sendGroupMsg(ctx, groupId,
            `🆔 Group ID: ${groupId}\n📋 Dùng ID này để config watchGroupIds trong openclaw.json`
          );
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
          await appendToMemoryFile('members.md', `| ${targetName} | ${warnCount} | ${reason} | ${nowShort()} |`);
          await appendToMemoryFile('chat-highlights.md', `| ${nowShort()} | Admin | /warn ${targetName}: ${reason} |`);
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
          await appendToMemoryFile('admin-notes.md', `| ${nowShort()} | ${senderName} | ${noteText} |`);
          await sendGroupMsg(ctx, groupId, `📝 Ghi nhận: ${noteText}`);
          return { handled: true };
        }

        // /rules — admin control panel
        if (command === '/rules') {
          if (!isAdmin(senderId)) return { handled: true };
          const sub = args[0]?.toLowerCase();
          if (!sub) {
            await sendGroupMsg(ctx, groupId,
              `⚙️ ADMIN COMMANDS — /rules\n━━━━━━━━━━━━━━━━━━\n\n🔇 Silent Mode:\n  /rules silent-on  — Bot chỉ reply khi @tag\n  /rules silent-off — Bot reply mọi tin\n\n🎉 Welcome:\n  /rules welcome-on  — Bật chào member mới\n  /rules welcome-off — Tắt chào\n\n📊 /rules status`
            );
            return { handled: true };
          }
          if (sub === 'silent-on')  { store.setSetting(groupId, 'silent', true);  await store.saveSettings(); await sendGroupMsg(ctx, groupId, '✅ Silent mode: BẬT'); return { handled: true }; }
          if (sub === 'silent-off') { store.setSetting(groupId, 'silent', false); await store.saveSettings(); await sendGroupMsg(ctx, groupId, '✅ Silent mode: TẮT'); return { handled: true }; }
          if (sub === 'welcome-on')  { store.setSetting(groupId, 'welcome', true);  await store.saveSettings(); await sendGroupMsg(ctx, groupId, '✅ Welcome: BẬT'); return { handled: true }; }
          if (sub === 'welcome-off') { store.setSetting(groupId, 'welcome', false); await store.saveSettings(); await sendGroupMsg(ctx, groupId, '✅ Welcome: TẮT'); return { handled: true }; }
          if (sub === 'status') {
            const silent  = store.getSetting(groupId, 'silent', true);
            const welcome = store.getSetting(groupId, 'welcome', true);
            await sendGroupMsg(ctx, groupId,
              `⚙️ CẤU HÌNH BOT\n━━━━━━━━━━━━━━━━━━\n🔇 Silent Mode: ${silent ? 'BẬT' : 'TẮT'}\n🎉 Welcome: ${welcome ? 'BẬT' : 'TẮT'}`
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
            await appendToMemoryFile('admin-notes.md', `| ${nowShort()} | ${senderName} | ${memText} |`);
          }
          await reloadStore(); // Fresh read from disk
          const { warnCount, vioCount } = await writeMemoryDigest(groupId);
          const extra = memText ? `\n📝 Note: ${memText}` : '';
          await sendGroupMsg(ctx, groupId,
            `📝 Đã lưu memory digest!${extra}\n📁 skills/memory/zalo-groups/${memoryGroupSlug}/\n⚠️ ${warnCount} member warned\n🚫 ${vioCount} vi phạm ghi nhận`
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
        await appendToMemoryFile('chat-highlights.md', `| ${nowShort()} | ${senderName} | ${content.slice(0, 80)} |`);

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
      const silentMode = store.getSetting(groupId, 'silent', true);
      if (silentMode) {
        // Anti-spam detect silently even in silent mode
        const spamType = spamTracker.check(senderId, content);
        if (spamType) {
          store.addViolation(groupId, senderId, senderName, spamType, content);
          await store.saveViolations();
          // Sync to memory
          await appendToMemoryFile('violations.md', `| ${nowShort()} | ${senderName} | ${spamType} | ${content.slice(0, 40)} |`);
          logger.info(`[zalo-mod] spam detected: ${spamType} from ${senderName}`);
        }
        return { handled: true }; // silent — don't forward to LLM
      }

      // Non-silent mode: still anti-spam detect
      const spamType = spamTracker.check(senderId, content);
      if (spamType) {
        store.addViolation(groupId, senderId, senderName, spamType, content);
        await store.saveViolations();
        // Sync to memory
        await appendToMemoryFile('violations.md', `| ${nowShort()} | ${senderName} | ${spamType} | ${content.slice(0, 40)} |`);
        logger.info(`[zalo-mod] spam detected (logged silently): ${spamType} from ${senderName}`);
        return { handled: true }; // spam always silently blocked
      }

      // Non-mention, non-slash, non-spam, non-silent → let LLM decide
      return;
    }, { priority: 300 }); // priority 300 = runs before relay plugin (200)

    // Start member watcher for welcome messages
    startMemberWatcher();

    logger.info(`[zalo-mod] loaded — group="${groupName}" bot="${botName}" adminIds=${adminIds.size || 'any'} watchGroups=${watchGroupIds.length}`);
  },
});

export default plugin;
