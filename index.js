/**
 * openclaw-zaloguard — Zero-Token Zalo Group Moderation Plugin
 * ─────────────────────────────────────────────────────────────
 * Hook vào before_dispatch của zalouser channel.
 * Xử lý slash commands + anti-spam tức thì, 0 token.
 * @mention → để lọt lên LLM agent bình thường.
 * Tin thường → block hoàn toàn (silent).
 *
 * @author Kent x Williams
 * @version 1.0.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

// ── Constants ────────────────────────────────────────────────
const PLUGIN_ID = 'zaloguard';
const DATA_DIR_NAME = '.zaloguard';

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
  // { userId: [{ msg, ts }] }
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

1️⃣ Nói đúng chủ đề — ưu tiên nội dung có ích
2️⃣ Không spam — không xả tin vô nghĩa, lặp nội dung
3️⃣ Không công kích — tranh luận được, toxic thì không
4️⃣ Không quảng cáo bừa — phải xin phép trước
5️⃣ Link phải rõ mục đích — gửi link thì note 1 câu kèm
6️⃣ Tôn trọng thời gian — nói rõ vấn đề

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
  • Tag trực tiếp: @${botName} [câu hỏi]
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

function buildReport(groupId, violations, warned) {
  const lines = [`📊 BÁO CÁO GROUP`, `🕐 ${nowIso().slice(0, 16).replace('T', ' ')}`];
  const v = violations[String(groupId)] || {};
  const w = warned[String(groupId)] || {};

  const vKeys = Object.keys(v);
  if (vKeys.length) {
    lines.push('\n📌 Vi phạm ghi nhận:');
    for (const uid of vKeys) {
      const list = v[uid];
      const last = list[list.length - 1];
      lines.push(`  - ${last.name || uid}: ${last.type}, ${list.length} lần, lần cuối ${last.ts.slice(0, 10)}`);
    }
  } else {
    lines.push('\n✅ Không có vi phạm mới');
  }

  const wKeys = Object.keys(w);
  if (wKeys.length) {
    lines.push('\n⚠️ Đã warn:');
    for (const uid of wKeys) {
      const list = w[uid];
      const last = list[list.length - 1];
      lines.push(`  - ${last.name || uid}: ${list.length} lần`);
    }
  }

  return lines.join('\n');
}

function buildWelcome(memberName, botName) {
  return `👋 Chào mừng ${memberName} đã join nhóm!

Đây là vài thứ để bắt đầu:
📋 /noi-quy   — Xem nội quy nhóm (đọc trước nhé!)
📖 /huong-dan — Hướng dẫn dùng bot
💬 @${botName} [câu hỏi] — Hỏi bot bất cứ điều gì

Chào mừng bro! 🎉`;
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
  name: 'ZaloGuard',
  description: 'Zero-token Zalo group moderation — slash commands, anti-spam, violations log.',
  kind: 'runtime',

  register(api) {
    const logger = api.logger;
    const cfg = api.config;

    // Plugin config: read from api.pluginConfig (OpenClaw SDK) or fallback
    const pluginCfg = api.pluginConfig || cfg?.plugins?.entries?.zaloguard || {};
    const groupName     = String(pluginCfg.groupName || 'Nhóm');
    const botName       = String(pluginCfg.botName || 'Williams');
    const zaloNames     = (pluginCfg.zaloDisplayNames || []).map(String);
    const botNames      = [botName, ...zaloNames].filter(Boolean);
    const adminIds      = new Set((pluginCfg.adminIds || []).map(String));
    const welcomeEnabled = pluginCfg.welcomeEnabled !== false;
    const spamRepeatN   = Number(pluginCfg.spamRepeatN || 3);
    const spamWindowMs  = Number(pluginCfg.spamWindowSeconds || 300) * 1000;

    if (api.runtime) {
      logger.info(`[zaloguard] runtime keys: ${Object.keys(api.runtime || {}).join(', ')}`);
      if (api.runtime.channels) {
        logger.info(`[zaloguard] registered channels: ${Object.keys(api.runtime.channels || {}).join(', ')}`);
      }
    }

    // Data dir — sibling to workspace
    const workspaceDir  = String(cfg?.agents?.defaults?.workspace || '/root/project/.openclaw/workspace');
    const dataDir = path.join(path.dirname(workspaceDir), DATA_DIR_NAME);

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
        logger.warn(`[zaloguard] memory append failed (${filename}): ${e.message}`);
      }
    }

    async function writeMemoryDigest(gId) {
      try {
        const warns = store.getWarned(gId);
        const violations = store.getViolations(gId);

        // Overwrite members.md with full warn digest
        const memberLines = [
          `# ${groupName} — Members & Warn Log\n`,
          '> **Cập nhật:** ' + nowShort() + ' bởi /memory command\n',
          '## Members Đã Warn\n',
          '| Tên | Số warn | Lý do gần nhất | Lần cuối |',
          '|-----|---------|-----------------|----------|',
        ];
        for (const [uid, list] of Object.entries(warns)) {
          if (!list.length) continue;
          const last = list[list.length - 1];
          memberLines.push(`| ${last.name || uid} | ${list.length} | ${last.reason || '—'} | ${(last.ts || '').slice(0, 10)} |`);
        }
        if (!Object.keys(warns).length) memberLines.push('| — | — | — | — |');
        await fs.writeFile(path.join(memoryDir, 'members.md'), memberLines.join('\n') + '\n', 'utf8');

        // Overwrite violations.md with full log
        const vioLines = [
          `# ${groupName} — Vi Phạm\n`,
          '> **Cập nhật:** ' + nowShort() + ' bởi /memory command\n',
          '## Log Vi Phạm\n',
          '| Thời gian | Member | Loại | Preview |',
          '|-----------|--------|------|---------|',
        ];
        for (const [uid, list] of Object.entries(violations)) {
          for (const v of list) {
            vioLines.push(`| ${(v.ts || '').slice(0, 16).replace('T', ' ')} | ${v.name || uid} | ${v.type} | ${(v.preview || '').slice(0, 40)} |`);
          }
        }
        if (!Object.keys(violations).length) vioLines.push('| — | — | — | — |');
        await fs.writeFile(path.join(memoryDir, 'violations.md'), vioLines.join('\n') + '\n', 'utf8');

        logger.info(`[zaloguard] memory digest written to ${memoryDir}`);
        return { warnCount: Object.keys(warns).length, vioCount: Object.keys(violations).length };
      } catch (e) {
        logger.warn(`[zaloguard] writeMemoryDigest failed: ${e.message}`);
        return { warnCount: 0, vioCount: 0 };
      }
    }

    // ── Zalo session (loaded once) ────────────────────────────
    let _zaloCookies = null;  // { zpsid, zpw_sek }
    let _zaloImei = '';

    async function loadZaloSession() {
      if (_zaloCookies) return _zaloCookies;
      try {
        const credPath = path.join(
          String(cfg?.agents?.defaults?.workspace || '/root/project/.openclaw/workspace'),
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
        logger.info(`[zaloguard] Zalo session loaded (imei=${_zaloImei.slice(0, 8)}...)`);
        return _zaloCookies;
      } catch (e) {
        logger.warn(`[zaloguard] loadZaloSession failed: ${String(e)}`);
        return null;
      }
    }

    // Helper: send reply natively via OpenClaw Zalouser API
    async function sendGroupMsg(ctx, groupId, text) {
      if (!groupId || !text) return;
      const profile = ctx?.accountId || 'default';
      logger.info(`[zaloguard] sendGroupMsg → threadId=${groupId}, profile=${profile}, textLen=${text.length}`);
      try {
        const { sendMessageZalouser } = await import('file:///usr/local/lib/node_modules/openclaw/dist/extensions/zalouser/test-api.js');
        const result = await sendMessageZalouser(String(groupId), String(text), { 
          isGroup: true, 
          profile,
          textMode: 'markdown'
        });
        if (result && !result.ok) {
           logger.error(`[zaloguard] Native Zalo send failed: ${result.error}`);
        } else {
           logger.info(`[zaloguard] Native message delivered to group ${groupId}`);
        }
      } catch (err) {
        logger.error(`[zaloguard] Native Zalo send exception: ${err.message}`);
      }
    }

    function isAdmin(senderId) {
      return adminIds.size === 0 || adminIds.has(String(senderId));
    }

    // ── Event: before_dispatch (main hook) ───────────────────
    api.on('before_dispatch', async (event, ctx) => {
      // 1. Chỉ bắt event từ Zalo
      if (ctx?.channelId !== 'zalouser') return;
      
      // DEBUG: log full structures
      logger.info(`[zaloguard] EVENT keys: ${Object.keys(event || {}).join(', ')}`);
      logger.info(`[zaloguard] CTX keys: ${Object.keys(ctx || {}).join(', ')}`);
      logger.info(`[zaloguard] ctx.conversationId=${ctx?.conversationId}, ctx.accountId=${ctx?.accountId}, ctx.senderId=${ctx?.senderId}`);
      logger.info(`[zaloguard] event.content=${String(event?.content || '').substring(0,50)}, event.body=${String(event?.body || '').substring(0,50)}`);
      
      // NOTE: Zalo strips @mention from event.content but keeps it in event.body
      const content = String(event?.body || event?.content || '').trim();
      if (!content) return { handled: true }; // Return early if no text content is found
      
      await ensureStore();

      const rawConvId = String(ctx.conversationId || event.conversationId || '');
      const groupId   = rawConvId.replace(/^group:/, '');
      const senderId  = String(ctx.senderId || event.senderId || '');
      const senderName = String(event.senderName || senderId);

      // ── Slash command router (0 token) ────────────────────
      if (content.startsWith('/')) {
        const parts   = content.trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args    = parts.slice(1);

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

        // /report — admin only
        if (command === '/report') {
          if (!isAdmin(senderId)) return { handled: true };
          const text = buildReport(groupId, store.getViolations(groupId), store.getWarned(groupId));
          await sendGroupMsg(ctx, groupId, text);
          return { handled: true };
        }

        // /warn @name [reason] — admin only
        if (command === '/warn') {
          if (!isAdmin(senderId)) return { handled: true };
          const targetMentions = (event.mentions || []);
          // Strip leading @ from args since Zalo body includes @name
          const rawTarget  = (args[0] || '').replace(/^@/, '');
          const targetId   = targetMentions[0]?.uid || rawTarget || '';
          const targetName = (targetMentions[0]?.name || rawTarget || targetId).replace(/^@/, '');
          // Collect remaining args as reason (skip multi-word names)
          const reasonArgs = args.slice(1);
          // If target name is multi-word (e.g. "Minh Tuan"), skip those args too  
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
          const text = args.join(' ');
          if (!text) return { handled: true };
          store.addViolation(groupId, 'admin-note', senderName, 'note', text);
          await store.saveViolations();
          // Sync to memory
          await appendToMemoryFile('admin-notes.md', `| ${nowShort()} | ${senderName} | ${text} |`);
          await sendGroupMsg(ctx, groupId, `📝 Ghi nhận: ${text}`);
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

        // /memory — admin manual digest
        if (command === '/memory') {
          if (!isAdmin(senderId)) return { handled: true };
          const { warnCount, vioCount } = await writeMemoryDigest(groupId);
          await sendGroupMsg(ctx, groupId,
            `📝 Đã lưu memory digest!\n📁 skills/memory/zalo-groups/${memoryGroupSlug}/\n⚠️ ${warnCount} member warned\n🚫 ${vioCount} vi phạm ghi nhận`
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
        logger.info(`[zaloguard] @mention from ${senderName} in group ${groupId}: ${content.slice(0, 80)}`);
        await appendToMemoryFile('chat-highlights.md', `| ${nowShort()} | ${senderName} | ${content.slice(0, 80)} |`);

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
        if (/(?:vi.*ph[ạa]m|violation|spam.*g[ầa]n|report)/i.test(lc)) {
          const violations = store.getViolations(groupId);
          const allVio = [];
          for (const [uid, list] of Object.entries(violations)) {
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
        logger.info(`[zaloguard] forwarding to LLM: ${content.slice(0, 80)}`);
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
          logger.info(`[zaloguard] spam detected: ${spamType} from ${senderName}`);
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
        logger.info(`[zaloguard] spam detected (logged silently): ${spamType} from ${senderName}`);
        return { handled: true }; // spam always silently blocked
      }

      // Non-mention, non-slash, non-spam, non-silent → let LLM decide
      return;
    }, { priority: 300 }); // priority 300 = runs before relay plugin (200)

    logger.info(`[zaloguard] loaded — group="${groupName}" bot="${botName}" adminIds=${adminIds.size || 'any'}`);
  },
});

export default plugin;
