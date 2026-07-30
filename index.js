/**
 * openclaw-zalo-mod — Zero-Token Zalo Group Moderation Plugin
 * ─────────────────────────────────────────────────────────────
 * Chạy trên ZaloConnect: policy group zero-token + hooks inbound/outbound của OpenClaw.
 * Xử lý slash commands + anti-spam tức thì, 0 token.
 * @mention → để lọt lên LLM agent bình thường.
 * Tin thường → block hoàn toàn (silent).
 *
 * v2.1.0: Watcher optimization — skip poll for welcome-off groups.
 *   Groups with welcome disabled are completely skipped during polling,
 *   saving Zalo API calls. Welcome setting check moved before API call.
 *
 * v1.2.0: Polling-based member watcher + /groupid command.
 *   OpenClaw Zalo Connect channel does NOT expose system events (join/leave)
 *   to plugins. Workaround: poll group member list via OpenClaw internal
 *   listZaloGroupMembers API, diff with previous snapshot.
 *
 * @author tuanminhhole
 * @version 2.17.4
 */

import fs from 'node:fs/promises';
import { chmodSync, readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createZaloModEngine } from './src/integration/zalo-mod-engine.js';
import { handleCrmAction } from './src/crm/crm-api.js';
import { createZcaFacade } from './src/integration/zca-facade.js';
import { ReplyMentionCorrelator } from './src/messaging/reply-mention-correlator.js';
import { matchesOwnerClaimDeviceId } from './src/integration/owner-claim.js';
import { createZaloModAgentTools, collectOwnerIds, ZALO_MOD_TOOL_NAMES } from './src/agent/tool-surface.js';
import { listAllCommands, renderCommandPanel, renderRulesPanel, TOGGLE_KEYS } from './src/agent/commands.js';
import { buildWorkspaceSkillMarkdown, WORKSPACE_SKILL_VERSION } from './src/agent/skill-content.js';
import { assertActionAllowed, capabilitiesForPlan, verifySignedEntitlement } from './src/licensing/entitlements.js';
import { classifyConnectAction, listConnectActions } from './src/agent/connect-actions.js';
import crypto from 'node:crypto';
import zlib from 'node:zlib';


// ── Plugin directory (for data storage) ──────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Auto-config helpers ──────────────────────────────────────
// Resolve true OPENCLAW_HOME by walking up from __dirname to find the folder containing openclaw.json
let _openclawHome = __dirname;
while (true) {
    if (existsSync(path.join(_openclawHome, 'openclaw.json'))) {
        break;
    }
    const parent = path.dirname(_openclawHome);
    if (parent === _openclawHome) {
        // Fallback if openclaw.json is not found (e.g. legacy/custom setup)
        _openclawHome = path.resolve(__dirname, '..', '..');
        const _homeBasename = path.basename(_openclawHome);
        if (_homeBasename === 'npm' || _homeBasename === 'node_modules' || _homeBasename.startsWith('openclaw-')) {
            _openclawHome = path.resolve(_openclawHome, '..');
            if (['npm', 'node_modules'].includes(path.basename(_openclawHome)) || path.basename(_openclawHome).startsWith('openclaw-')) {
                _openclawHome = path.resolve(_openclawHome, '..');
            }
        }
        break;
    }
    _openclawHome = parent;
}

if (path.basename(_openclawHome) === '.openclaw') {
    _openclawHome = path.dirname(_openclawHome);
}

function getOpenclawJsonPath() {
    const p1 = path.join(_openclawHome, '.openclaw', 'openclaw.json');
    if (existsSync(p1)) return p1;
    return path.join(_openclawHome, 'openclaw.json');
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
 * Auto-patch openclaw.json — chỉ đảm bảo entry có `enabled` + `hooks` (+ bindings/channels).
 * KHÔNG mirror thông tin bot (botName/zaloDisplayNames/dashboardPort/ownerId) sang openclaw.json nữa —
 * tất cả sống ở plugins-data/zalo-mod/config.json (nguồn chuẩn). Tránh trùng lặp 2 chỗ.
 * Returns { patched: boolean, overflow: object } — overflow chứa mọi key cần ghi vào config.json.
 */
const _OPENCLAW_ALLOWED_KEYS = new Set();
async function _patchOpenclawConfig(openclawHome, patch, logger, force = false) {
    const configPath = getOpenclawJsonPath();
    // Split patch into allowed (openclaw.json) and overflow (config.json)
    const allowedPatch = {};
    const overflowPatch = {};
    for (const [key, val] of Object.entries(patch)) {
        if (val == null) continue;
        if (_OPENCLAW_ALLOWED_KEYS.has(key)) {
            allowedPatch[key] = val;
        }
        if (key !== 'groupNames') { // groupNames never goes to config.json or openclaw.json
            overflowPatch[key] = val;
        }
    }

    let changed = false;
    try {
        const raw = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(raw);
        config.plugins = config.plugins || {};
        config.plugins.entries = config.plugins.entries || {};

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

        // Only write allowed keys to openclaw.json
        for (const [key, val] of Object.entries(allowedPatch)) {
            const cur = existing[key];
            const isEmpty = cur == null || cur === '' || (Array.isArray(cur) && cur.length === 0);
            if (force || isEmpty) {
                existing[key] = val;
                changed = true;
            }
        }

        // NOTE: We intentionally do NOT clean up non-allowed keys from openclaw.json.
        // Removing them would destroy config before migration gets a chance to read them.
        // Extra keys in openclaw.json are harmless; losing user config is not.

        // Auto-provision bindings: ensure Zalo Connect is bound to an agent.
        const agentId = config.agents?.list?.[0]?.id;
        if (agentId && !Array.isArray(config.bindings)) {
            config.bindings = [{ agentId, match: { channel: 'zalo-connect' } }];
            changed = true;
            if (logger) logger.info(`[openclaw-zalo-mod] auto-added binding: zalo-connect → ${agentId}`);
        } else if (agentId && Array.isArray(config.bindings)) {
            const hasZalo = config.bindings.some(b => b.match?.channel === 'zalo-connect');
            if (!hasZalo) {
                config.bindings.push({ agentId, match: { channel: 'zalo-connect' } });
                changed = true;
                if (logger) logger.info(`[openclaw-zalo-mod] auto-added binding: zalo-connect → ${agentId}`);
            }
        }

        // Auto-provision groups config: enable all groups with no mention required
        if (config.channels?.['zalo-connect'] && !config.channels['zalo-connect'].groups) {
            config.channels['zalo-connect'].groups = { '*': { enabled: true, requireMention: false } };
            changed = true;
            if (logger) logger.info(`[openclaw-zalo-mod] auto-added groups config: all groups enabled`);
        }

        if (changed) {
            config.plugins.entries[PLUGIN_ID].config = existing;
            await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
            if (logger) logger.info(`[openclaw-zalo-mod] auto-patched openclaw.json config`);
        }
        return { patched: changed, overflow: overflowPatch };
    } catch (e) {
        if (logger) logger.warn(`[openclaw-zalo-mod] auto-patch config failed: ${e.message}`);
        return { patched: false, overflow: overflowPatch };
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

const writeQueues = new Map();
async function safeWriteJson(filePath, data) {
    let promise = writeQueues.get(filePath) || Promise.resolve();
    const nextPromise = promise.then(async () => {
        const tmpPath = filePath + '.tmp';
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
            await fs.rename(tmpPath, filePath);
        } catch (e) {
            try { await fs.unlink(tmpPath); } catch (_) {}
        }
    }).catch(() => {});
    writeQueues.set(filePath, nextPromise);
    await nextPromise;
}

function nowIso() {
    return new Date().toISOString();
}

// ── Store ────────────────────────────────────────────────────
function createStore(dataDir) {
    const violationsPath = path.join(dataDir, 'violations.json');
    const warnedPath = path.join(dataDir, 'warned.json');
    const settingsPath = path.join(dataDir, 'settings.json');
    const licensePath = path.join(dataDir, 'license.json');

    let violations = {};
    let warned = {};
    let settings = {};
    let license = {};

    return {
        async load() {
            violations = (await safeReadJson(violationsPath)) || {};
            warned = (await safeReadJson(warnedPath)) || {};
            settings = (await safeReadJson(settingsPath)) || {};
            license = (await safeReadJson(licensePath)) || {};
        },
        async saveViolations() { await safeWriteJson(violationsPath, violations); },
        async saveWarned() { await safeWriteJson(warnedPath, warned); },
        async saveSettings() {
            await safeWriteJson(settingsPath, settings);
            await safeWriteJson(licensePath, license);
        },

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
            if (String(groupId) === 'global' && key === 'license') {
                return license ?? def;
            }
            return settings[String(groupId)]?.[key] ?? def;
        },
        setSetting(groupId, key, value) {
            if (String(groupId) === 'global' && key === 'license') {
                license = value;
                return;
            }
            const g = String(groupId);
            settings[g] = settings[g] || {};
            settings[g][key] = value;
        },
        getRawSettings() {
            return settings;
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

// ── Default Templates ────────────────────────────────────────
const DEFAULT_NOI_QUY = `📋 NỘI QUY — {groupName}
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

📌 Hỏi thêm: @{botName} [câu hỏi]`;

const DEFAULT_MENU = `🤖 {BOTNAME} — MENU LỆNH
━━━━━━━━━━━━━━━━━━

📋 Thông tin
  {cmdPrefix}noi-quy   — Xem nội quy nhóm
  {cmdPrefix}menu   — Menu lệnh này
  {cmdPrefix}huong-dan    — Hướng dẫn dùng bot


💬 Hỏi đáp
  @{botName} [câu hỏi] — Hỏi bot bất kỳ điều gì

🔧 Admin (chỉ admin dùng được)
  {cmdPrefix}mute                    — Tắt bot hoàn toàn
  {cmdPrefix}unmute                  — Bật lại bot
  {cmdPrefix}warn @name [lý do]  — Cảnh cáo member
  {cmdPrefix}note [text]           — Ghi chú admin
  {cmdPrefix}report                  — Báo cáo vi phạm
  {cmdPrefix}memory                  — Lưu memory digest

👑 Owner (chỉ chủ bot)
  {cmdPrefix}rules                 — Cấu hình bot

━━━━━━━━━━━━━━━━━━
💡 Tip: Tag @{botName} để hỏi thêm!`;

const DEFAULT_HUONG_DAN = `📖 HƯỚNG DẪN SỬ DỤNG BOT {BOTNAME}
━━━━━━━━━━━━━━━━━━

👋 {botName} là trợ lý AI của nhóm này.

🗣️ Cách giao tiếp:
  • Tag trực tiếp: @{botName} [câu hỏi bất kỳ]
  • Gõ lệnh: /[tên lệnh]

📌 Ví dụ:
  @{botName} giải thích quy trình XYZ
  {cmdPrefix}noi-quy → xem nội quy
  {cmdPrefix}menu → xem tất cả lệnh

⚠️ Lưu ý:
  • Bot KHÔNG tự reply tin thường — cần @tag hoặc gõ lệnh
  • Lệnh admin: {cmdPrefix}report và {cmdPrefix}warn (chỉ admin dùng được)

━━━━━━━━━━━━━━━━━━
❓ Cần hỗ trợ thêm → @{botName}`;

const DEFAULT_WELCOME = `👋 Chào mừng {memberName} vào nhóm {groupName}!
📋 {cmdPrefix}noi-quy để xem nội quy
📖 {cmdPrefix}menu để xem lệnh
💬 @{botName} nếu cần hỏi bot`;

const DEFAULT_SPAM_WARNING = `⚠️ CẢNH BÁO SPAM
{memberName} vui lòng KHÔNG gửi link quảng cáo / spam trong nhóm.
Vi phạm tiếp theo có thể bị warn hoặc kick theo nội quy nhóm {groupName}.`;

const DEFAULT_MAINTENANCE = `🔧 THÔNG BÁO BẢO TRÌ
Bot {botName} đang tạm bảo trì để nâng cấp. Một số chức năng có thể gián đoạn trong ít phút.
Mong cả nhà thông cảm — {botName} sẽ hoạt động lại sớm! 🙏`;

// ── Template thống nhất ───────────────────────────────────────
// Nội dung lưu file .txt trong dataDir; lệnh slash tuỳ chỉnh lưu ở config.json (templateCommands).
// kind: 'command' = trả lời khi gõ lệnh; 'welcome' = gửi khi có thành viên mới; 'message' = gửi thủ công / gán lệnh.
const TEMPLATE_DEFS = [
    { key: 'noi-quy', label: 'Nội quy nhóm', def: DEFAULT_NOI_QUY, defCmd: 'noi-quy', kind: 'command' },
    { key: 'huong-dan', label: 'Hướng dẫn dùng bot', def: DEFAULT_HUONG_DAN, defCmd: 'huong-dan', kind: 'command' },
    { key: 'menu', label: 'Menu lệnh', def: DEFAULT_MENU, defCmd: 'menu', kind: 'command' },
    { key: 'welcome', label: 'Chào mừng thành viên', def: DEFAULT_WELCOME, defCmd: '', kind: 'welcome' },
    { key: 'spam-warning', label: 'Cảnh báo spam link', def: DEFAULT_SPAM_WARNING, defCmd: '', kind: 'message' },
    { key: 'maintenance', label: 'Thông báo bảo trì bot', def: DEFAULT_MAINTENANCE, defCmd: '', kind: 'message' },
];
const TEMPLATE_KEYS = TEMPLATE_DEFS.map(d => d.key);
function normCmdWord(s) {
    return String(s || '').trim().toLowerCase().replace(/^\/+/, '').replace(/[^a-z0-9-]/g, '');
}
// Map template-key → command word (mặc định trộn với override owner lưu trong config).
function templateCommandsFrom(pluginCfg) {
    const saved = (pluginCfg && pluginCfg.templateCommands && typeof pluginCfg.templateCommands === 'object') ? pluginCfg.templateCommands : {};
    const out = {};
    for (const d of TEMPLATE_DEFS) {
        const v = saved[d.key];
        out[d.key] = normCmdWord(typeof v === 'string' ? v : d.defCmd);
    }
    return out;
}
// Từ 'command' đã strip prefix (vd '/quy') → template-key nếu owner có gán lệnh.
function resolveTemplateKeyByCommand(command, pluginCfg) {
    const kw = normCmdWord(command);
    if (!kw) return null;
    const map = templateCommandsFrom(pluginCfg);
    for (const d of TEMPLATE_DEFS) {
        if (map[d.key] && map[d.key] === kw) return d.key;
    }
    return null;
}
async function loadTemplateContent(dataDir, key) {
    const d = TEMPLATE_DEFS.find(x => x.key === key);
    if (!d) return '';
    return await getTemplateContent(path.join(dataDir, `${key}.txt`), d.def);
}

async function getTemplateContent(filePath, defaultContent) {
    try {
        if (existsSync(filePath)) {
            return await fs.readFile(filePath, 'utf8');
        }
    } catch (e) {
        // best effort
    }
    return defaultContent;
}

function renderTemplate(templateStr, vars) {
    let result = String(templateStr || '');
    for (const [key, value] of Object.entries(vars)) {
        const regex = new RegExp(`\\{${key}\\}`, 'g');
        result = result.replace(regex, value);
    }
    if (vars.botName) {
        result = result.replace(/\{BOTNAME\}/g, String(vars.botName).toUpperCase());
    }
    return result;
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

function buildWelcome(memberName, botName, cmdPrefix) {
    return `👋 Chào mừng ${memberName} vào nhóm!
📋 ${cmdPrefix}noi-quy để xem nội quy
📖 ${cmdPrefix}menu để xem lệnh
💬 @${botName} nếu cần hỏi bot`;
}


// ── isMention ────────────────────────────────────────────────
function isMessageMentioningBot(event, botNames, profileName) {
    // IMPORTANT: Zalo strips @mention from event.content, use event.body
    const content = String(event.body || event.content || '').toLowerCase();

    // Dynamic config resolution to prevent RAM lag
    let searchNames = botNames;
    try {
        let liveCfg = null;
        // Check config.json first
        const dataPaths = [
            path.join(_openclawHome, '.openclaw', 'plugins-data', PLUGIN_ID, 'config.json'),
            path.join(_openclawHome, 'plugins-data', PLUGIN_ID, 'config.json')
        ];
        for (const dp of dataPaths) {
            if (existsSync(dp)) {
                try {
                    const data = JSON.parse(readFileSync(dp, 'utf8'));
                    if (data && (data.botName || data.zaloDisplayNames || data.bots)) {
                        liveCfg = data;
                        break;
                    }
                } catch (_) { }
            }
        }

        // Fallback to openclaw.json
        if (!liveCfg) {
            const configPath = getOpenclawJsonPath();
            if (existsSync(configPath)) {
                const config = JSON.parse(readFileSync(configPath, 'utf8'));
                liveCfg = config?.plugins?.entries?.[PLUGIN_ID]?.config || config?.plugins?.entries?.[PACKAGE_ID]?.config || {};
            }
        }

        if (liveCfg) {
            const botCfg = liveCfg.bots?.[profileName || 'default'] || {};
            const liveName = String(botCfg.botName || liveCfg.botName || '').trim();
            const liveZaloNames = (botCfg.zaloDisplayNames || liveCfg.zaloDisplayNames || []).map(String);
            if (liveName) {
                searchNames = [liveName, ...liveZaloNames].filter(Boolean);
            }
        }
    } catch (e) { }

    // Check all known bot names/aliases
    for (const raw of searchNames) {
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

        // OpenClaw Zalo Connect là transport Zalo duy nhất. Zalo Mod không
        // patch private dist, đọc credentials hay sở hữu Zalo session riêng.
        logger.info('[openclaw-zalo-mod] transport: OpenClaw Zalo Connect only.');

        // ── Auto-fix 777 permissions (Windows bind-mount issue) ─────────────────
        // OpenClaw gateway blocks world-writable plugins (Windows bind-mount gives 0777).
        // Fix recursively using pure Node.js fs — safe for ClawHub publish (no child_process).
        (function fixPluginPermissions(dir, depth) {
            if (depth > 4) return;
            try {
                chmodSync(dir, 0o755);
                for (const entry of readdirSync(dir)) {
                    if (entry === 'node_modules' || entry === '.git') continue;
                    try {
                        const p = path.join(dir, entry);
                        const st = statSync(p);
                        if (st.isDirectory()) {
                            fixPluginPermissions(p, depth + 1);
                        } else {
                            chmodSync(p, 0o644);
                        }
                    } catch (_) { }
                }
            } catch (_) { /* non-blocking — ok on non-Linux */ }
        })(__dirname, 0);


        const cfg = api.config;

        // Plugin config: read from api.pluginConfig (OpenClaw SDK) or fallback
        const _sdkPluginCfg = api.pluginConfig || cfg?.plugins?.entries?.[PLUGIN_ID]?.config || cfg?.plugins?.entries?.[PACKAGE_ID]?.config || {};

        // Data dir — store JSON data outside the extensions folder to avoid hot-reloads
        const dataDir = path.join(_openclawHome, '.openclaw', 'plugins-data', PLUGIN_ID);
        try { if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true }); } catch (e) { }

        // ── Config file — source of truth (plugins-data/zalo-mod/config.json) ──
        const configFile = path.join(dataDir, 'config.json');
        let _pluginConfig = {};

        // Helper: read plugin config directly from openclaw.json file (bypasses SDK schema stripping)
        function _readRawOpenclawPluginConfig() {
            try {
                const raw = readFileSync(getOpenclawJsonPath(), 'utf8');
                const oc = JSON.parse(raw);
                return oc?.plugins?.entries?.[PLUGIN_ID]?.config
                    || oc?.plugins?.entries?.[PACKAGE_ID]?.config
                    || {};
            } catch (_) { return {}; }
        }

        async function getZaloBots() {
            function extractAvatarFromUserInfo(rawProfile, targetId) {
                if (!rawProfile) return '';
                const cleanId = String(targetId).replace(/_0$/, '');
                let avatar = '';
                const extract = (obj) => {
                    if (avatar || !obj || typeof obj !== 'object') return;
                    if (Array.isArray(obj)) {
                        for (const item of obj) {
                            extract(item);
                            if (avatar) return;
                        }
                        return;
                    }
                    const id = String(obj.userId || obj.uid || obj.id || obj.user_id || '').replace(/_0$/, '');
                    const avt = obj.avatar || obj.avatarUrl || obj.avatar_url || '';
                    if (id === cleanId && avt) {
                        avatar = avt;
                        return;
                    }
                    for (const val of Object.values(obj)) {
                        if (val && typeof val === 'object') {
                            extract(val);
                            if (avatar) return;
                        }
                    }
                };
                extract(rawProfile);
                return avatar;
            }

            try {
                const raw = await fs.readFile(getOpenclawJsonPath(), 'utf8');
                const config = JSON.parse(raw);
                const agents = config?.agents?.list || [];
                const bindings = config?.bindings || [];
                const zaloConnectAccounts = config?.channels?.['zalo-connect']?.accounts || {};

                const zaloBindings = bindings.filter(b => b.match && (b.match.channel === 'zalo-connect' || b.match.channelId === 'zalo-connect'));

                const bots = [];
                for (const agent of agents) {
                    const binding = zaloBindings.find(b => b.agentId === agent.id);
                    if (binding) {
                        const accountId = binding.match.accountId || 'default';
                        const accountConfig = zaloConnectAccounts[accountId] || {};
                        if (accountConfig.enabled !== false) {
                            let agentWorkspace = agent.workspace || '';
                            if (agentWorkspace.startsWith('/root/project/.openclaw/')) {
                                agentWorkspace = agentWorkspace.replace('/root/project/.openclaw/', '');
                            } else if (agentWorkspace.startsWith('/home/node/project/.openclaw/')) {
                                agentWorkspace = agentWorkspace.replace('/home/node/project/.openclaw/', '');
                            } else if (agentWorkspace.includes('.openclaw/')) {
                                agentWorkspace = agentWorkspace.substring(agentWorkspace.indexOf('.openclaw/') + 10);
                            } else if (agentWorkspace.includes('.openclaw\\')) {
                                agentWorkspace = agentWorkspace.substring(agentWorkspace.indexOf('.openclaw\\') + 10);
                            }

                            let resolvedWorkspacePath = _openclawHome;
                            if (agentWorkspace) {
                                resolvedWorkspacePath = path.isAbsolute(agentWorkspace) ? agentWorkspace : path.resolve(_openclawHome, agentWorkspace);
                            }

                            let botName = agent.name || agent.id;
                            const isMainAgent = agents[0] && agent.id === agents[0].id;
                            const configPaths = [
                                path.join(resolvedWorkspacePath, '.openclaw', 'plugins-data', 'zalo-mod', 'config.json'),
                                path.join(resolvedWorkspacePath, 'plugins-data', 'zalo-mod', 'config.json'),
                            ];
                            if (isMainAgent) {
                                configPaths.push(
                                    path.join(_openclawHome, '.openclaw', 'plugins-data', 'zalo-mod', 'config.json'),
                                    path.join(_openclawHome, 'plugins-data', 'zalo-mod', 'config.json')
                                );
                            }
                            for (const configPath of configPaths) {
                                try {
                                    if (existsSync(configPath)) {
                                        const fileContent = await fs.readFile(configPath, 'utf8');
                                        const configData = JSON.parse(fileContent);
                                        if (configData && configData.botName) {
                                            botName = configData.botName;
                                            break;
                                        }
                                    }
                                } catch (e) {
                                    // ignore and try next path
                                }
                            }

                            const profileName = accountConfig.profile || accountId;
                            let userId = '';
                            let avatar = '';
                            try {
                                const withZaloApi = await getSafeZaloApi();
                                if (withZaloApi) {
                                    const acc = await withZaloApi(profileName, async (zaloApi) => {
                                        let ownId = userId;
                                        let avt = '';

                                        // 1. Try fetchAccountInfo first (contains direct profile avatar)
                                        if (typeof zaloApi.fetchAccountInfo === 'function') {
                                            const a = await zaloApi.fetchAccountInfo().catch(() => null);
                                            const p = a?.profile || a;
                                            if (p) {
                                                ownId = ownId || p.userId || p.uid;
                                                avt = p.avatar || p.avatarUrl || p.photo || p.photoUrl || '';
                                            }
                                        }

                                        // 2. Fallback to getOwnId
                                        if (!ownId && typeof zaloApi.getOwnId === 'function') {
                                            ownId = await zaloApi.getOwnId().catch(() => null);
                                        }

                                        // 3. Fallback to getUserInfo with deep extraction
                                        if (ownId && !avt) {
                                            const p = await zaloApi.getUserInfo(ownId).catch(() => null);
                                            avt = extractAvatarFromUserInfo(p, ownId);
                                        }

                                        return { userId: ownId || '', avatar: avt || '' };
                                    }).catch(() => null);
                                    if (acc) {
                                        userId = String(acc.userId || userId).replace(/_0$/, '');
                                        avatar = String(acc.avatar || '').trim();
                                    }
                                }
                            } catch (e) { }

                            bots.push({
                                id: agent.id,
                                name: botName,
                                profile: profileName,
                                avatar,
                                userId,
                            });
                        }
                    } else if (agents.length === 1 && config?.channels?.['zalo-connect']?.enabled) {
                        let botName = agent.name || agent.id;
                        const configPaths = [
                            path.join(_openclawHome, '.openclaw', 'plugins-data', 'zalo-mod', 'config.json'),
                            path.join(_openclawHome, 'plugins-data', 'zalo-mod', 'config.json')
                        ];
                        for (const configPath of configPaths) {
                            try {
                                if (existsSync(configPath)) {
                                    const fileContent = await fs.readFile(configPath, 'utf8');
                                    const configData = JSON.parse(fileContent);
                                    if (configData && configData.botName) {
                                        botName = configData.botName;
                                        break;
                                    }
                                }
                            } catch (e) { }
                        }

                        let userId = '';
                        let avatar = '';
                        try {
                            const withZaloApi = await getSafeZaloApi();
                            if (withZaloApi) {
                                const acc = await withZaloApi('default', async (zaloApi) => {
                                    let ownId = userId;
                                    let avt = '';

                                    // 1. Try fetchAccountInfo first
                                    if (typeof zaloApi.fetchAccountInfo === 'function') {
                                        const a = await zaloApi.fetchAccountInfo().catch(() => null);
                                        const p = a?.profile || a;
                                        if (p) {
                                            ownId = ownId || p.userId || p.uid;
                                            avt = p.avatar || p.avatarUrl || p.photo || p.photoUrl || '';
                                        }
                                    }

                                    // 2. Fallback to getOwnId
                                    if (!ownId && typeof zaloApi.getOwnId === 'function') {
                                        ownId = await zaloApi.getOwnId().catch(() => null);
                                    }

                                    // 3. Fallback to getUserInfo
                                    if (ownId && !avt) {
                                        const p = await zaloApi.getUserInfo(ownId).catch(() => null);
                                        avt = extractAvatarFromUserInfo(p, ownId);
                                    }

                                    return { userId: ownId || '', avatar: avt || '' };
                                }).catch(() => null);
                                if (acc) {
                                    userId = String(acc.userId || userId).replace(/_0$/, '');
                                    avatar = String(acc.avatar || '').trim();
                                }
                            }
                        } catch (e) { }

                        bots.push({
                            id: agent.id,
                            name: botName,
                            profile: 'default',
                            avatar,
                            userId,
                        });
                    }
                }
                return bots;
            } catch (e) {
                logger.warn(`[openclaw-zalo-mod] Failed to parse Zalo bots from openclaw.json: ${e.message}`);
                return [];
            }
        }

        async function getGroupInfoInBatches(zaloApi, ids) {
            const infoMap = {};
            if (!Array.isArray(ids) || !ids.length) return infoMap;
            const chunkSize = 30;
            for (let i = 0; i < ids.length; i += chunkSize) {
                const chunk = ids.slice(i, i + chunkSize);
                try {
                    const infoResult = await zaloApi.getGroupInfo(chunk);
                    if (infoResult?.gridInfoMap) {
                        Object.assign(infoMap, infoResult.gridInfoMap);
                    }
                } catch (err) {
                    logger.warn(`[openclaw-zalo-mod] getGroupInfo batch failed for ${chunk.length} groups: ${err.message}`);
                }
                if (ids.length > chunkSize && i + chunkSize < ids.length) {
                    await new Promise((r) => setTimeout(r, 100)); // Optimized delay from 1000ms to 100ms
                }
            }
            return infoMap;
        }

        try {
            if (existsSync(configFile)) {
                _pluginConfig = JSON.parse(readFileSync(configFile, 'utf8'));
                // Fix broken migration: if config.json exists but is empty/missing essential keys,
                // re-migrate from openclaw.json raw file (not SDK which may strip additionalProperties)
                if (Object.keys(_pluginConfig).length === 0 || (!_pluginConfig.botName && !_pluginConfig.ownerId && !_pluginConfig.bots)) {
                    const rawCfg = _readRawOpenclawPluginConfig();
                    if (Object.keys(rawCfg).length > 0) {
                        const { groupNames: _gn, ...migratedCfg } = rawCfg;
                        _pluginConfig = { ..._pluginConfig, ...migratedCfg };
                        writeFileSync(configFile, JSON.stringify(_pluginConfig, null, 2), 'utf8');
                        logger.info('[openclaw-zalo-mod] re-migrated config from openclaw.json → config.json (recovery)');
                    }
                }
            } else {
                // First-time migration: read directly from openclaw.json file (not SDK, to avoid schema stripping)
                const rawCfg = _readRawOpenclawPluginConfig();
                const sdkCfg = _sdkPluginCfg;
                // Merge: raw file has most complete data, SDK is fallback
                const { groupNames: _gn1, ...rawMigrated } = rawCfg;
                const { groupNames: _gn2, ...sdkMigrated } = sdkCfg;
                _pluginConfig = { ...sdkMigrated, ...rawMigrated };
                writeFileSync(configFile, JSON.stringify(_pluginConfig, null, 2), 'utf8');
                logger.info('[openclaw-zalo-mod] migrated config from openclaw.json → config.json');
            }
        } catch (e) {
            _pluginConfig = {};
        }
        // Normalize to the per-bot shape: bot identity (botName / zaloDisplayNames /
        // ownerId / slashPrefix) lives ONLY under bots.<profile>. Legacy single-bot
        // top-level copies are folded into bots.default and stripped from config.json.
        // Idempotent; only rewrites the file when something actually changed.
        try {
            const _slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
            let _cfgChanged = false;
            _pluginConfig.bots = _pluginConfig.bots || {};
            const _def = _pluginConfig.bots.default = _pluginConfig.bots.default || {};
            if (!_def.botName && _pluginConfig.botName) { _def.botName = _pluginConfig.botName; _cfgChanged = true; }
            if ((!Array.isArray(_def.zaloDisplayNames) || !_def.zaloDisplayNames.length)
                && Array.isArray(_pluginConfig.zaloDisplayNames) && _pluginConfig.zaloDisplayNames.length) {
                _def.zaloDisplayNames = _pluginConfig.zaloDisplayNames; _cfgChanged = true;
            }
            if (!_def.ownerId && _pluginConfig.ownerId) { _def.ownerId = _pluginConfig.ownerId; _cfgChanged = true; }
            if (!_def.slashPrefix && _pluginConfig.slashPrefix) { _def.slashPrefix = _pluginConfig.slashPrefix; _cfgChanged = true; }
            // Per-bot completeness (do NOT invent ownerId — that comes from owner-claim).
            for (const [_p, _b] of Object.entries(_pluginConfig.bots)) {
                if (!_b || typeof _b !== 'object') continue;
                if ((!Array.isArray(_b.zaloDisplayNames) || !_b.zaloDisplayNames.length) && _b.botName) {
                    _b.zaloDisplayNames = [_b.botName]; _cfgChanged = true;
                }
                if (!_b.slashPrefix) { const _pfx = _slug(_b.botName) || _slug(_p); if (_pfx) { _b.slashPrefix = _pfx; _cfgChanged = true; } }
            }
            for (const _k of ['botName', 'zaloDisplayNames', 'ownerId', 'slashPrefix']) {
                if (_k in _pluginConfig) { delete _pluginConfig[_k]; _cfgChanged = true; }
            }
            if (_cfgChanged && existsSync(configFile)) {
                writeFileSync(configFile, JSON.stringify(_pluginConfig, null, 2) + '\n', 'utf8');
                logger.info('[openclaw-zalo-mod] normalized config.json → per-bot bots.* shape (stripped legacy top-level identity)');
            }
        } catch { /* non-fatal: fall back to whatever loaded */ }
        // Merged view: config.json overrides, fallback to openclaw.json for backward-compat
        const pluginCfg = { ..._sdkPluginCfg, ..._pluginConfig };

        // Normalize: thông tin bot default sống ở bots.default (nguồn chuẩn).
        // Nếu top-level thiếu (đã dọn trùng lặp khỏi config.json) thì backfill IN-MEMORY từ bots.default
        // để mọi biến toàn cục (botName, ownerId, zaloDisplayNames…) vẫn resolve đúng — KHÔNG ghi lại ra file.
        {
            const _defBot = pluginCfg.bots?.default;
            if (_defBot) {
                if (!pluginCfg.botName && _defBot.botName) pluginCfg.botName = _defBot.botName;
                if ((!pluginCfg.zaloDisplayNames || pluginCfg.zaloDisplayNames.length === 0) && _defBot.zaloDisplayNames)
                    pluginCfg.zaloDisplayNames = _defBot.zaloDisplayNames;
                if (!pluginCfg.ownerId && _defBot.ownerId) pluginCfg.ownerId = _defBot.ownerId;
                if (!pluginCfg.slashPrefix && _defBot.slashPrefix) pluginCfg.slashPrefix = _defBot.slashPrefix;
            }
        }

        async function savePluginConfig(updates) {
            try {
                Object.assign(_pluginConfig, updates);
                // Also update merged pluginCfg in-memory
                Object.assign(pluginCfg, updates);
                await fs.writeFile(configFile, JSON.stringify(_pluginConfig, null, 2) + '\n', 'utf8');
            } catch (e) {
                logger.warn(`[openclaw-zalo-mod] save config.json failed: ${e.message}`);
            }
        }

        // Ghi tên bot đã phát hiện vào bots[profile] (nguồn chuẩn), KHÔNG ghi trùng top-level/openclaw.json.
        // Với default: cập nhật thêm view top-level in-memory để biến toàn cục resolve đúng (không persist).
        async function saveBotName(profile, name) {
            if (!name) return;
            const bots = { ...(pluginCfg.bots || {}) };
            const cur = bots[profile] || {};
            const slashPrefix = cur.slashPrefix || String(name).toLowerCase().replace(/[^a-z0-9-]/g, '') || profile;
            bots[profile] = { ...cur, botName: name, zaloDisplayNames: [name], slashPrefix };
            if (profile === 'default') { pluginCfg.botName = name; pluginCfg.zaloDisplayNames = [name]; }
            await savePluginConfig({ bots });
        }



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
            } catch (e) { }
        }

        // ── groupNames: source of truth cho danh sách groups đang quản lý ──
        // Format mới: { groupId: { name, admins, creatorId } }
        const groupNames = {};
        for (const [gId, val] of Object.entries(_rawGroupNames)) {
            if (typeof val === 'string') {
                groupNames[gId] = { name: val, admins: [], creatorId: '', profile: 'default' };
            } else if (val && typeof val === 'object') {
                groupNames[gId] = { name: val.name || '', admins: val.admins || [], creatorId: val.creatorId || '', profile: val.profile || 'default' };
            }
        }
        // watchGroupIds được derive từ groupNames keys — không cần config riêng
        const watchGroupIds = Object.keys(groupNames).filter(Boolean);

        // ── Multi-bot per group helpers ──────────────────────────────
        // Một group có thể có nhiều bot cùng tham gia. profile được lưu dạng
        // CSV "default,zuli_bot_le". Các helper dưới đây dùng để đọc/ghi list này.
        function parseProfiles(profileStr) {
            return String(profileStr ?? 'default').split(',').map(s => s.trim()).filter(Boolean);
        }
        function primaryProfile(profileStr) {
            return parseProfiles(profileStr)[0] || 'default';
        }
        function mergeProfileStr(existing, prof) {
            // KHÔNG dùng parseProfiles(existing) vì nó fallback undefined→'default',
            // sẽ chèn nhầm 'default' vào group chỉ có bot khác. Existing rỗng ⇒ base rỗng.
            const base = (existing == null || existing === '') ? [] : parseProfiles(existing);
            return [...new Set([...base, prof])].join(',');
        }

        // ── Synchronous botName detection (first-load fix) ──────────
        // When installed via ClawHub, pluginCfg.botName is empty on first load.
        // Detect from multiple sources before falling back to 'Bot':
        let _detectedBotId = '';
        const botName = String(pluginCfg.botName || 'Bot');
        const zaloNames = (pluginCfg.zaloDisplayNames || []).map(String);
        const botNames = [botName, ...zaloNames].filter(Boolean);
        const pfx = String(pluginCfg.slashPrefix || botName).toLowerCase().replace(/[^a-z0-9-]/g, '');
        const cmdPrefix = '/' + (pfx || 'bot') + '-';

        function getBotConfig(profileOrGroupId) {
            let profile = 'default';
            if (profileOrGroupId && String(profileOrGroupId).startsWith('group:')) {
                const gId = String(profileOrGroupId).replace(/^group:/, '');
                profile = primaryProfile(groupNames[gId]?.profile);
            } else if (profileOrGroupId && groupNames[profileOrGroupId]) {
                profile = primaryProfile(groupNames[profileOrGroupId]?.profile);
            } else if (profileOrGroupId) {
                profile = profileOrGroupId;
            }

            const botSpecific = pluginCfg.bots?.[profile] || {};

            let bName = botSpecific.botName || pluginCfg.botName;
            if (!bName) {
                // Plain 'Bot' is the only fallback left to make: a name detected from IDENTITY.md or
                // the Zalo API is persisted by saveBotName() into bots[profile].botName (and
                // pluginCfg.botName for 'default'), which the line above already reads. This used to
                // consult an undeclared per-profile name map, which threw a ReferenceError on a fresh
                // install (no name configured yet) and took the whole before_dispatch hook down with
                // it — so owner claims and slash commands were silently dropped. See the regression
                // test in tests/owner-claim.test.js.
                bName = 'Bot';
            }

            const zNames = botSpecific.zaloDisplayNames || pluginCfg.zaloDisplayNames || [];
            const bNames = [bName, ...zNames].filter(Boolean);

            const slashPrefix = botSpecific.slashPrefix || pluginCfg.slashPrefix || bName;
            const pfx = String(slashPrefix).toLowerCase().replace(/[^a-z0-9-]/g, '');
            const cPrefix = '/' + (pfx || 'bot') + '-';

            const ownId = botSpecific.ownerId || (profile === 'default' ? pluginCfg.ownerId : '') || '';

            return {
                profile,
                botName: bName,
                botNames: bNames,
                cmdPrefix: cPrefix,
                ownerId: ownId
            };
        }
        let ownerId = String(pluginCfg.ownerId || '');  // Zalo ID chủ nhân bot
        // adminIds: derive từ ownerId — không cần config riêng
        // (per-group admins lưu trong groupNames[gId].admins và settings.json)
        const adminIds = new Set(ownerId ? [ownerId] : []);
        const allowedDmUsers = new Set((pluginCfg.allowedDmUsers || []).map(String)); // DM whitelist
        const welcomeEnabled = pluginCfg.welcomeEnabled !== false;
        const spamRepeatN = Number(pluginCfg.spamRepeatN || 5);
        const spamWindowMs = Number(pluginCfg.spamWindowSeconds || 300) * 1000;
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

        /**
         * Workspace của MỌI agent, không chỉ agent đầu tiên.
         * Multi-bot (mỗi bot Zalo = 1 agent) thì bot thứ 2 trở đi cũng cần skill.
         */
        function agentWorkspaceDirs() {
            const dirs = new Set();
            const resolveWs = (value) => {
                const raw = String(value || '').trim();
                if (!raw) return '';
                return path.isAbsolute(raw) ? raw : path.resolve(_openclawHome, raw);
            };
            for (const agent of (cfg?.agents?.list || [])) {
                const dir = resolveWs(agent?.workspace);
                if (dir) dirs.add(dir);
            }
            const fallback = resolveWs(cfg?.agents?.defaults?.workspace) || path.join(_openclawHome, 'workspace');
            if (!dirs.size) dirs.add(fallback);
            return [...dirs];
        }

        /**
         * Host đã publish skill native của plugin chưa? Nếu rồi thì KHÔNG ghi bản
         * fallback vào workspace (tránh 2 skill trùng nội dung, và tránh bản
         * workspace bị cũ so với plugin).
         */
        function pluginSkillPublished() {
            const candidates = [
                path.join(_openclawHome, '.openclaw', 'plugin-skills', 'zalo-mod-control'),
                path.join(_openclawHome, 'plugin-skills', 'zalo-mod-control'),
            ];
            return candidates.some((p) => existsSync(p));
        }

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

        const store = createStore(dataDir);
        const spamTracker = createSpamTracker(spamRepeatN, spamWindowMs);



        function getDeviceId() {
            // ỔN ĐỊNH qua recreate container: persist vào plugins-data (volume mount).
            // Trước đây md5(platform+hostname+cpus) — nhưng hostname Docker = container id, ĐỔI mỗi lần
            // recreate (update/up -d) → deviceId đổi → key device-bound mất hiệu lực → tụt FREE khi update.
            const idFile = path.join(dataDir, 'device-id');
            try {
                if (existsSync(idFile)) {
                    const saved = String(readFileSync(idFile, 'utf8')).trim().toUpperCase();
                    if (/^[0-9A-F]{16}$/.test(saved)) return saved;
                }
            } catch { /* ignore */ }
            // Generate a persistent random install ID without collecting hardware,
            // hostname, MAC address, or operating-system identifiers.
            const id = crypto.randomBytes(8).toString('hex').toUpperCase();
            try { mkdirSync(dataDir, { recursive: true }); writeFileSync(idFile, id, 'utf8'); } catch { /* ignore */ }
            return id;
        }

        function getLicenseStatus() {
            const deviceId = getDeviceId();
            const free = { ...capabilitiesForPlan('free', false), plan: 'free', expiry: null, deviceId, isTrial: false };
            if (!store) return free;
            const license = store.getSetting('global', 'license') || {};

            // Online activation/trial proofs are signed by the license server and
            // bound to this persistent Device ID. Cached payload fields alone are
            // never trusted because users can edit local JSON files.
            const signed = verifySignedEntitlement(license.entitlement, MKT_PUBLIC_KEY, deviceId);
            if (signed.valid) {
                const plan = signed.payload.plan || license.plan || 'personal';
                return {
                    ...capabilitiesForPlan(plan, true),
                    plan,
                    expiry: signed.payload.licenseExpiry || license.expiry || null,
                    deviceId,
                    isTrial: Array.isArray(signed.payload.features) && signed.payload.features.includes('trial'),
                };
            }

            // KHÔNG tin license.valid — sửa tay license.json thành {valid:true} là bypass được.
            // Thay vào đó verify LẠI chữ ký RSA của key ZALOMKT mỗi lần đọc: bind theo deviceId + hạn.
            // Sai chữ ký / sai máy / hết hạn ⇒ free. Không có private key ⇒ không tạo được trạng thái PRO.
            const v = verifyZalomktKey(license.key, deviceId);
            if (v.valid) {
                return {
                    ...capabilitiesForPlan(v.plan || license.plan || 'personal', true),
                    plan: v.plan || license.plan || 'personal',
                    expiry: v.expiry,
                    deviceId,
                    key: license.key,
                    isTrial: false,
                };
            }
            return free;
        }

        const MKT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAprIHnNwUmG/ypmyzbajn
ydzZ529CdGnqT9cUVhYJ6EUVJ64gnOwKvw0oB1pBqzV4KTFh8GlIK6Gnhmg2ONeQ
ljAnHnPWQqRwXbRjmcty5SZRml6yXfZI8k47nnF2O2S1Hin0Gzcy2hPsrr1+vGz3
w4Wym8f9dVLFW1zKMNrmB2uDayfN2/OnIy+tmDS0I1F+uszD6Z9qEK8wkmN51UHQ
E9ezoe+3jA7vBpZ4cQke7W6U+UF7IVj3zdnpSrx2IjYL6egTlvvdx+wNW09RmfgF
Y8EuoNu0MnwfbY670xW/IA22rrtzHU0Qgfl4GNHImN9+BVHtjrqRdx5MmuP6M1w0
YwIDAQAB
-----END PUBLIC KEY-----`;

        // Verify offline ZALOMKT-<PLAN>-<YYYYMMDD>-<sig>. Chữ ký RSA ký chuỗi
        // `${DEVICEID}:${plan}:${expiry}` (deviceId uppercase) bằng private key trên
        // license server (KHÔNG có trong bản phân phối). Không có private key ⇒ không giả nổi key.
        function verifyZalomktKey(key, deviceId) {
            if (!key || typeof key !== 'string' || !key.startsWith('ZALOMKT-')) return { valid: false };
            try {
                const parts = key.split('-');
                if (parts.length < 4) return { valid: false };
                const plan = String(parts[1] || '').toLowerCase();
                const rawExpiry = parts[2] || '';
                if (!/^\d{8}$/.test(rawExpiry)) return { valid: false };
                const expiry = `${rawExpiry.slice(0, 4)}-${rawExpiry.slice(4, 6)}-${rawExpiry.slice(6, 8)}`;
                const signature = parts.slice(3).join('-'); // base64 có thể chứa '-'
                const dataToVerify = `${String(deviceId).toUpperCase()}:${plan}:${expiry}`;
                const verifier = crypto.createVerify('sha256');
                verifier.update(dataToVerify);
                if (!verifier.verify(MKT_PUBLIC_KEY, signature, 'base64')) return { valid: false };
                const expired = new Date() > new Date(`${expiry}T23:59:59`);
                return { valid: !expired, expired, plan, expiry };
            } catch { return { valid: false }; }
        }

        async function verifyLicenseKey(key) {
            if (!key) return { valid: false, error: 'Key is empty' };
            const deviceId = getDeviceId();

            // Chỉ chấp nhận key ZALOMKT ký RSA (offline, bind theo thiết bị).
            // ĐÃ BỎ backdoor DEV-* không ký (ai có source cũng chế được) — chỉ key server ký mới hợp lệ.
            const v = verifyZalomktKey(key, deviceId);
            if (v.valid) return { valid: true, plan: v.plan, expiry: v.expiry, deviceId };
            if (v.expired) return { valid: false, error: 'Key đã hết hạn.' };
            return { valid: false, error: 'Key kích hoạt không hợp lệ cho thiết bị này!' };
        }

        let storeLoaded = false;
        let _settingsMtime = 0;
        const _settingsFile = path.join(dataDir, 'settings.json');
        async function ensureStore() {
            // Reload khi settings.json đổi (mtime). Plugin register nhiều lần (mỗi bot 1 closure,
            // mỗi closure 1 store riêng) → dashboard toggle ghi file ở closure này, các closure
            // khác PHẢI đọc lại file mới thấy, nếu không sẽ dùng silent/welcome CŨ → lệch/không ăn.
            try {
                const m = (await fs.stat(_settingsFile)).mtimeMs;
                if (!storeLoaded || m > _settingsMtime) {
                    await store.load();
                    storeLoaded = true;
                    _settingsMtime = m;
                }
            } catch {
                if (!storeLoaded) { await store.load(); storeLoaded = true; }
            }
        }

        // Force reload store from disk (for /memory, /report)
        async function reloadStore() {
            await store.load();
            storeLoaded = true;
        }

        // ── Skill fallback trong workspace ──────────────────────────────────
        // Đường CHÍNH là skill native `skills/zalo-mod-control` khai trong
        // openclaw.plugin.json → host tự symlink vào <home>/plugin-skills/ cho MỌI
        // agent, luôn khớp version plugin. Chỉ khi host không publish được (bản cũ
        // chưa hỗ trợ plugin skills) mới ghi bản fallback vào workspace.
        //
        // Bản cũ có 2 lỗ đã sửa ở đây: (a) chỉ ghi vào workspace của agent ĐẦU TIÊN
        // nên multi-bot thì bot sau không có skill; (b) chỉ ghi khi file chưa tồn tại
        // nên skill đóng băng vĩnh viễn, update plugin không cập nhật được.
        async function ensureWorkspaceSkillFallback() {
            if (pluginSkillPublished()) return { skipped: 'plugin-skill-published' };
            const written = [];
            for (const wsDir of agentWorkspaceDirs()) {
                const skillDir = path.join(wsDir, 'skills', 'zalo-group-admin');
                const skillMdPath = path.join(skillDir, 'SKILL.md');
                const botCfg = getBotConfig('default');
                const skillContent = buildWorkspaceSkillMarkdown({
                    botName: botCfg.botName,
                    cmdPrefix: botCfg.cmdPrefix,
                    memoryPathHint: path.join(wsDir, 'skills/memory/zalo-groups'),
                });
                let existing = '';
                try { existing = await fs.readFile(skillMdPath, 'utf8'); } catch { /* chưa có */ }
                if (existing === skillContent) continue;
                // Không có dòng version do plugin sinh ra → người dùng sửa tay, giữ nguyên.
                if (existing && !/^version: \d+\.\d+\.\d+$/m.test(existing)) {
                    logger.info(`[openclaw-zalo-mod] giữ nguyên SKILL.md đã sửa tay: ${skillMdPath}`);
                    continue;
                }
                await fs.mkdir(skillDir, { recursive: true });
                await fs.writeFile(skillMdPath, skillContent, 'utf8');
                written.push(skillMdPath);
                logger.info(`[openclaw-zalo-mod] wrote fallback skill ${skillMdPath} (v${WORKSPACE_SKILL_VERSION})`);
            }
            return { written };
        }
        // ── Auto-bootstrap workspace files on first load ─────────
        // Creates SKILL.md + memory INDEX.md if they don't exist.
        // This runs automatically so ClawHub installs work without manual setup.js.
        async function bootstrapWorkspaceFiles() {
            try {
                // Bước 1 (skill) chạy trễ ở dưới — host publish plugin-skills sau khi
                // plugin register xong, kiểm tra ngay lúc này sẽ luôn thấy "chưa có".
                // 2. Create memory INDEX.md cho mỗi group đang follow
                for (const gId of watchGroupIds) {
                    if (!isFollowOn(gId)) continue;
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

                // Bootstrap template files if not exists
                const templateFiles = [
                    { name: 'noi-quy.txt', content: DEFAULT_NOI_QUY },
                    { name: 'huong-dan.txt', content: DEFAULT_HUONG_DAN },
                    { name: 'menu.txt', content: DEFAULT_MENU },
                ];
                for (const t of templateFiles) {
                    const tPath = path.join(dataDir, t.name);
                    try {
                        await fs.access(tPath);
                    } catch {
                        await fs.writeFile(tPath, t.content, 'utf8');
                        logger.info(`[openclaw-zalo-mod] bootstrapped default template ${t.name}`);
                    }
                }

                // 4. Bootstrap plugin-local data only. Do not mutate openclaw.json
                // while `openclaw plugins install/update` is validating the newly
                // extracted plugin: the CLI rejects mid-flight config changes.
                const configNeedsPatch = !pluginCfg.botName || Object.keys(groupNames).length === 0;
                if (configNeedsPatch) {
                    // 4a. Write detected botName to config (bots.default) so it is saved
                    if (botName && botName !== 'Bot') {
                        await saveBotName('default', botName);
                        logger.info(`[openclaw-zalo-mod] auto-saving botName="${botName}" to bots.default`);
                    }

                    // 4b. Scan session data for groups (DEPRECATED: only sync via API)
                    logger.info('[openclaw-zalo-mod] initialized with empty group list — please click "Sync Account" on the dashboard to import groups via Zalo API');

                }
            } catch (e) {
                logger.warn(`[openclaw-zalo-mod] bootstrap workspace files failed: ${e.message}`);
            }
        }

        // Fire-and-forget bootstrap (don't block plugin registration)
        bootstrapWorkspaceFiles();

        // Skill fallback kiểm tra TRỄ: host publish <home>/plugin-skills/ sau khi
        // plugin register xong, nên phải chờ mới biết có cần bản workspace hay không.
        const _skillTimer = globalThis.__zaloModSkillTimer;
        if (_skillTimer) clearTimeout(_skillTimer);
        globalThis.__zaloModSkillTimer = setTimeout(() => {
            ensureWorkspaceSkillFallback()
                .then((r) => { if (r?.skipped) logger.info('[openclaw-zalo-mod] plugin skill zalo-mod-control đã được host publish — bỏ qua bản workspace'); })
                .catch((e) => logger.warn(`[openclaw-zalo-mod] skill fallback failed: ${e.message}`));
        }, 20000);
        globalThis.__zaloModSkillTimer?.unref?.();

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

        // ── Helper giờ VN (UTC+7) — mọi mốc "ngày" trong tính năng tổng hợp dùng giờ VN ──
        function vnNow() {
            // Dịch epoch +7h rồi format bằng UTC → ra đúng wall-clock VN
            return new Date(Date.now() + 7 * 3600 * 1000);
        }
        function vnDateStr(d) {
            return (d || vnNow()).toISOString().slice(0, 10); // YYYY-MM-DD theo giờ VN
        }
        function vnTimeStr(d) {
            return (d || vnNow()).toISOString().slice(11, 16); // HH:MM theo giờ VN
        }
        function extractLinks(text) {
            const re = /https?:\/\/[^\s<>"')\]]+/gi;
            return [...new Set((String(text).match(re) || []).map(u => u.replace(/[.,;:]+$/, '')))];
        }

        // ── Chat history có cấu trúc (JSONL, append-only theo ngày VN) ──
        // Mỗi dòng = 1 tin: {ts, t, userId, name, text, links[]}. Dùng để AI tóm tắt + UI xem.
        function chatHistoryDir(groupId) {
            return path.join(dataDir, 'chat-history', String(groupId).replace(/^group:/, ''));
        }
        async function recordChatMessage(groupId, userId, name, text) {
            try {
                const dir = chatHistoryDir(groupId);
                await fs.mkdir(dir, { recursive: true });
                const entry = {
                    ts: new Date().toISOString(),
                    t: vnTimeStr(),
                    userId: String(userId || ''),
                    name: String(name || ''),
                    text: String(text || '').slice(0, 2000),
                    links: extractLinks(text),
                };
                await fs.appendFile(path.join(dir, `${vnDateStr()}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
            } catch (e) {
                logger.warn(`[openclaw-zalo-mod] recordChatMessage failed: ${e.message}`);
            }
        }
        async function readChatHistory(groupId, dateStr) {
            try {
                const file = path.join(chatHistoryDir(groupId), `${dateStr}.jsonl`);
                const raw = await fs.readFile(file, 'utf8');
                return raw.split('\n').filter(Boolean).map(l => {
                    try { return JSON.parse(l); } catch { return null; }
                }).filter(Boolean);
            } catch {
                return [];
            }
        }
        /** Liệt kê các ngày (YYYY-MM-DD) đã có lịch sử chat cho group */
        async function listChatHistoryDates(groupId) {
            try {
                const files = await fs.readdir(chatHistoryDir(groupId));
                return files.filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, '')).sort().reverse();
            } catch {
                return [];
            }
        }

        // ── Notes có cấu trúc (notes.json) ──
        async function addNote(groupId, userId, userName, text) {
            const all = await readPluginDataJson('notes.json');
            const gid = String(groupId).replace(/^group:/, '');
            if (!Array.isArray(all[gid])) all[gid] = [];
            const note = { id: `${Date.now()}-${all[gid].length}`, userId: String(userId || ''), userName: String(userName || ''), text: String(text || '').trim(), ts: new Date().toISOString() };
            all[gid].push(note);
            await writePluginDataJson('notes.json', all);
            return note;
        }
        async function getNotes(groupId) {
            const all = await readPluginDataJson('notes.json');
            return all[String(groupId).replace(/^group:/, '')] || [];
        }

        // ── Memory tri thức của group (agent openclaw đọc group-memory.md) ──
        async function addGroupMemory(groupId, userId, userName, text) {
            const clean = String(text || '').trim();
            if (!clean) return null;
            const all = await readPluginDataJson('group-memories.json');
            const gid = String(groupId).replace(/^group:/, '');
            if (!Array.isArray(all[gid])) all[gid] = [];
            if (all[gid].some(m => String(m.text).trim().toLowerCase() === clean.toLowerCase())) return { duplicate: true };
            const mem = { id: `${Date.now()}-${all[gid].length}`, userId: String(userId || ''), userName: String(userName || ''), text: clean, ts: new Date().toISOString() };
            all[gid].push(mem);
            await writePluginDataJson('group-memories.json', all);
            // Ghi file markdown để agent đọc khi trả lời
            await appendToMemoryFile(groupId, 'group-memory.md', `- (${vnDateStr()}) ${userName}: ${clean}`);
            return mem;
        }
        async function getGroupMemories(groupId) {
            const all = await readPluginDataJson('group-memories.json');
            return all[String(groupId).replace(/^group:/, '')] || [];
        }

        // ── Phân quyền lệnh (Phase 1: cơ bản, mặc định 'admin'; UI chi tiết ở Phase 6) ──
        // scope: 'owner' | 'admin' | 'list' | 'all'
        // Permissions đọc từ globalThis (chia sẻ giữa các closure khi plugin register nhiều lần
        // cho nhiều bot) → dashboard save cập nhật là MỌI closure thấy ngay, không bị closure cũ chặn.
        function livePermissions() {
            return globalThis.__zaloModPermissions || pluginCfg.permissions || {};
        }
        function getCmdPermission(cmd, groupId) {
            const p = (livePermissions())[cmd] || {};
            const gid = String(groupId || '').replace(/^group:/, '');
            if (p.perGroup && p.perGroup[gid]) {
                return { scope: p.perGroup[gid].scope || p.scope || 'admin', allowList: p.perGroup[gid].allowList || p.allowList || [], allowNames: p.perGroup[gid].allowNames || p.allowNames || [] };
            }
            return { scope: p.scope || 'admin', allowList: p.allowList || [], allowNames: p.allowNames || [] };
        }
        function canRunCmd(cmd, senderId, groupId, senderName) {
            const { scope, allowList, allowNames } = getCmdPermission(cmd, groupId);
            if (scope === 'all') return true;
            if (scope === 'owner') {
                const botCfg = getBotConfig(groupId || 'default');
                return String(senderId) === String(botCfg.ownerId || ownerId);
            }
            if (scope === 'list') {
                const sname = String(senderName || '').trim().toLowerCase();
                return allowList.map(String).includes(String(senderId))
                    || (sname && (allowNames || []).map(n => String(n).toLowerCase()).includes(sname))
                    || isAdmin(senderId, groupId);
            }
            return isAdmin(senderId, groupId); // default 'admin'
        }

        // ── Phân quyền DM & Group (Phase 5) ──
        function isDmAllowed(senderId, senderName) {
            const dm = livePermissions().dm || {};
            const mode = dm.mode || (allowedDmUsers.size ? 'list' : 'all'); // backward-compat
            const sid = String(senderId);
            if (mode === 'all') return true;
            if (mode === 'none') return false;
            if (mode === 'owner') return false; // owner đã được xử lý trước gate này
            const list = (dm.allowList && dm.allowList.length) ? dm.allowList.map(String) : [...allowedDmUsers];
            // Khớp thêm theo TÊN: Zalo cấp id per-account nên id chọn từ góc nhìn 1 bot
            // không khớp id bot kia thấy. Tên hiển thị thì nhất quán → bắc cầu giữa các bot.
            const sname = String(senderName || '').trim().toLowerCase();
            const names = (dm.allowNames || []).map(n => String(n).toLowerCase());
            const ok = list.includes(sid) || (sname && names.includes(sname));
            if (mode === 'list') return ok;
            if (mode === 'friends') return ok || _friendIdCache.has(sid) || _friendIdCache.size === 0; // cache trống → không khoá nhầm
            return true;
        }
        // DM event của Zalo KHÔNG kèm displayName (senderName = id). Để khớp allowNames
        // (bắc cầu qua id per-account), resolve tên thật qua API của bot nhận tin. Có cache.
        const _dmNameCache = new Map();
        async function resolveUserName(profile, userId) {
            const key = (profile || 'default') + ':' + userId;
            if (_dmNameCache.has(key)) return _dmNameCache.get(key);
            let name = '';
            try {
                const withZaloApi = await getSafeZaloApi();
                if (withZaloApi) {
                    name = await withZaloApi(profile || 'default', async (api) => {
                        if (typeof api.getUserInfo !== 'function') return '';
                        const info = await api.getUserInfo([String(userId)]);
                        const names = collectProfileNames(info, {});
                        return names[String(userId).replace(/_0$/, '')] || names[String(userId)] || '';
                    });
                }
            } catch (_) { name = ''; }
            _dmNameCache.set(key, name || '');
            return name || '';
        }
        function isGroupAllowed(groupId) {
            const gp = livePermissions().group || {};
            const mode = gp.mode || 'all';
            if (mode === 'all') return true;
            if (mode === 'none') return false;
            return (gp.allowList || []).map(String).includes(String(groupId));
        }
        // Trích id+tên từ kết quả getAllFriends (cấu trúc Zalo không cố định) — best-effort
        function extractFriendList(raw) {
            const out = []; const seen = new Set();
            const visit = (o) => {
                if (!o || typeof o !== 'object') return;
                if (Array.isArray(o)) { o.forEach(visit); return; }
                const id = o.userId || o.uid || o.id || o.user_id;
                const name = o.displayName || o.zaloName || o.name || o.username;
                if (id && /^\d{5,}$/.test(String(id).replace(/_0$/, '')) && !seen.has(String(id))) {
                    seen.add(String(id));
                    out.push({ id: String(id).replace(/_0$/, ''), name: String(name || '') });
                }
                for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v);
            };
            visit(raw);
            return out;
        }

        // ── Tổng hợp lịch sử chat theo ngày (smart-route AI) ──
        // Đọc endpoint + API key THẬT của 9router từ openclaw.json (provider mà agent đang dùng).
        // Trước đây hardcode 'sk-no-key' → 9router trả 401 "API key required for remote API access".
        let _smartRouteCache = null;
        function resolveSmartRoute() {
            if (_smartRouteCache) return _smartRouteCache;
            let baseUrl = 'http://9router:20128/v1';
            let apiKey = String(pluginCfg.smartRouteApiKey || '');
            try {
                const cfg = JSON.parse(readFileSync(getOpenclawJsonPath(), 'utf8'));
                const providers = cfg?.models?.providers || {};
                let prov = providers['9router']
                    || Object.values(providers).find(p => /9router|:20128/.test(String(p?.baseUrl || p?.baseURL || '')));
                if (prov) {
                    baseUrl = String(prov.baseUrl || prov.baseURL || baseUrl).replace(/\/$/, '');
                    if (prov.apiKey) apiKey = String(prov.apiKey);
                }
            } catch (_) { /* dùng mặc định */ }
            const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
            const resolved = { url, apiKey: apiKey || 'sk-no-key' };
            if (apiKey) _smartRouteCache = resolved; // chỉ cache khi lấy được key thật
            return resolved;
        }
        async function callSmartRoute(prompt, { temperature = 0.3, timeoutMs = 45000 } = {}) {
            const { url, apiKey } = resolveSmartRoute();
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model: 'smart-route', messages: [{ role: 'user', content: prompt }], temperature, stream: false }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) throw new Error(`smart-route HTTP ${res.status}`);
            const data = await res.json();
            return data.choices?.[0]?.message?.content?.trim() || '';
        }

        // ── /note thông minh: AI phân loại note thường vs lời nhắc, plugin tự quản lịch nhắc ──
        // Dùng scheduler riêng của plugin + sendGroupMsg (đã ổn định) thay vì cron native OpenClaw:
        // giao qua Zalo Connect announce tới group không tin cậy (cần threadId + agent gọi tool). Cách này chủ động 100%.
        // Parser deterministic cho lời nhắc TƯƠNG ĐỐI phổ biến ("N phút/giờ/tiếng nữa", "sau N phút").
        // Chạy tức thì, KHÔNG gọi AI → không dính timeout model. Không khớp thì trả null (để AI lo).
        function parseReminderHeuristic(text) {
            const t = String(text || '').toLowerCase().normalize('NFC');
            let minutes = 0;
            // phút: "5 phút nữa" / "sau 5 phút" / "trong 5p"
            const mMin = t.match(/(\d{1,4})\s*(?:phút|phut)\s*(?:nữa|nua|sau)/)
                || t.match(/(?:sau|trong|còn|con)\s*(\d{1,4})\s*(?:phút|phut|p)\b/);
            if (mMin) minutes += Number(mMin[1]);
            // giờ/tiếng: "2 giờ nữa" / "2 tiếng nữa" / "sau 2 tiếng" (KHÔNG bắt "8h" = mốc đồng hồ)
            const mHour = t.match(/(\d{1,3})\s*(?:tiếng|tieng)\s*(?:nữa|nua|sau)?/)
                || t.match(/(\d{1,3})\s*(?:giờ|gio)\s*(?:nữa|nua|sau)/)
                || (/(?:sau|trong)\s*(\d{1,3})\s*(?:giờ|gio)\b/.test(t) && /(?:nữa|nua|sau)/.test(t) ? t.match(/(\d{1,3})\s*(?:giờ|gio)/) : null);
            if (mHour) minutes += Number(mHour[1]) * 60;
            if (minutes > 0) {
                return { reminder: true, kind: 'once', offsetMinutes: minutes, title: text.slice(0, 60), message: text };
            }
            return null;
        }
        // Hỏi AI: note này có phải lời nhắc theo thời gian? Có mốc hiện tại (giờ VN) để suy "mai", "3h chiều"…
        async function classifyNoteReminder(text) {
            const nowVn = vnDateStr() + ' ' + vnTimeStr();
            const prompt = `Bây giờ là ${nowVn} (ngày giờ Việt Nam, Asia/Ho_Chi_Minh).
Người dùng ghi chú trong nhóm chat: "${String(text).slice(0, 500)}".
Xác định đây là ghi nhớ thường hay LỜI NHẮC theo thời gian (cần bot nhắc lại đúng lúc).
Trả về DUY NHẤT một JSON, không markdown:
{"reminder":true|false,"kind":"once"|"recurring","offsetMinutes":<số>,"at":"YYYY-MM-DDTHH:mm","cron":"phút giờ * * *","title":"tiêu đề ngắn","message":"nội dung bot sẽ nhắc trong nhóm"}
Quy tắc:
- Ghi nhớ thường (không mốc thời gian) → {"reminder":false}.
- Tương đối ("N phút/giờ nữa", "sau N phút") → kind="once" + "offsetMinutes" = SỐ PHÚT kể từ bây giờ (2 giờ=120). ĐỪNG tự tính giờ đồng hồ, chỉ điền offsetMinutes.
- Mốc tuyệt đối ("8h sáng mai", "20:00 hôm nay") → kind="once" + "at" (YYYY-MM-DDTHH:mm giờ VN, suy từ hiện tại).
- Lặp lại ("mỗi sáng 8h") → kind="recurring" + "cron" (phút giờ theo giờ VN).
"message" viết như lời bot nhắc, ngắn gọn tự nhiên.`;
            const raw = await callSmartRoute(prompt, { timeoutMs: 30000 });
            const m = raw.match(/\{[\s\S]*\}/);
            if (!m) return { reminder: false };
            try { return JSON.parse(m[0]); } catch { return { reminder: false }; }
        }

        // ── Lịch nhắc (reminders.json) — plugin tự bắn qua sendGroupMsg ──
        // "YYYY-MM-DDTHH:mm" (giờ VN) → epoch ms (VN = UTC+7).
        function vnLocalToMs(at) {
            const m = String(at || '').match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
            if (!m) return NaN;
            return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5], 0); // trừ 7h để ra UTC
        }
        // Khớp 1 field cron với giá trị hiện tại: hỗ trợ *, số, danh sách "a,b", bước "*/n".
        function cronFieldMatch(field, val) {
            for (const part of String(field).split(',')) {
                if (part === '*') return true;
                const step = part.match(/^\*\/(\d+)$/);
                if (step) { if (val % (+step[1]) === 0) return true; continue; }
                if (Number(part) === val) return true;
            }
            return false;
        }
        // Cron 5-field (phút giờ ngày tháng thứ) khớp với "now" theo giờ VN.
        function cronMatchesVn(expr, nowMs) {
            const f = String(expr || '').trim().split(/\s+/);
            if (f.length < 5) return false;
            const vn = new Date(nowMs + 7 * 3600 * 1000); // dịch sang giờ VN, đọc bằng getUTC*
            return cronFieldMatch(f[0], vn.getUTCMinutes())
                && cronFieldMatch(f[1], vn.getUTCHours())
                && cronFieldMatch(f[2], vn.getUTCDate())
                && cronFieldMatch(f[3], vn.getUTCMonth() + 1)
                && cronFieldMatch(f[4], vn.getUTCDay());
        }
        // Guard chia sẻ giữa các register closure (plugin register 2 lần/2 bot) — chống bắn trùng.
        const _zmFiredOnce = globalThis.__zmFiredOnce = globalThis.__zmFiredOnce || new Set();
        const _zmTimers = globalThis.__zmTimers = globalThis.__zmTimers || new Map();
        const _zmRecLast = globalThis.__zmRecLast = globalThis.__zmRecLast || new Map();

        async function addReminder(groupId, profile, cls, createdBy) {
            const all = await readPluginDataJson('reminders.json');
            const id = `${Date.now()}-${Math.floor((Date.now() % 100000))}`;
            const rec = {
                id, groupId: String(groupId).replace(/^group:/, ''), profile: profile || 'default',
                kind: cls.kind === 'recurring' ? 'recurring' : 'once',
                message: String(cls.message || cls.title || '').trim(),
                title: String(cls.title || '').trim(),
                createdBy: createdBy || '', createdAt: new Date().toISOString(),
            };
            if (rec.kind === 'recurring') rec.cron = String(cls.cron || '').trim();
            else {
                // Tương đối ("N phút nữa") → cộng thẳng từ now (không để LLM tính giờ). Tuyệt đối → parse "at".
                const off = Number(cls.offsetMinutes);
                rec.fireAtMs = (Number.isFinite(off) && off > 0) ? (Date.now() + off * 60000) : vnLocalToMs(cls.at);
            }
            all[id] = rec;
            await writePluginDataJson('reminders.json', all);
            if (rec.kind === 'once') armOnceTimer(rec); // hẹn giờ CHÍNH XÁC (không đợi nhịp poll 60s)
            return rec;
        }
        // Bắn 1 lời nhắc once đúng thời điểm; xoá khỏi store. Guard toàn cục chống bắn trùng giữa các closure.
        async function fireOnceReminder(id) {
            if (_zmFiredOnce.has(id)) return;
            _zmFiredOnce.add(id);
            const h = _zmTimers.get(id); if (h) { clearTimeout(h); _zmTimers.delete(id); }
            try {
                const all = await readPluginDataJson('reminders.json');
                const r = all[id];
                if (r) {
                    await sendGroupMsg({ accountId: r.profile || 'default' }, r.groupId, `⏰ Nhắc: ${r.message}`);
                    delete all[id];
                    await writePluginDataJson('reminders.json', all);
                }
            } catch (e) { logger.warn(`[openclaw-zalo-mod] fire once ${id}: ${e.message}`); }
        }
        // Đặt setTimeout đúng fireAtMs cho lời nhắc once (chính xác giây). Quá xa → để poll lo.
        function armOnceTimer(rec) {
            if (!rec || rec.kind !== 'once' || !Number.isFinite(rec.fireAtMs)) return;
            if (_zmTimers.has(rec.id) || _zmFiredOnce.has(rec.id)) return;
            const delay = rec.fireAtMs - Date.now();
            if (delay > 2_000_000_000) return; // >~23 ngày → poll backstop xử lý
            const h = setTimeout(() => { fireOnceReminder(rec.id); }, Math.max(0, delay));
            if (h.unref) h.unref();
            _zmTimers.set(rec.id, h);
        }
        // Khôi phục timer cho các lời nhắc once còn treo (sau restart) + dọn cái đã quá hạn.
        async function rehydrateReminderTimers() {
            try {
                const all = await readPluginDataJson('reminders.json');
                for (const r of Object.values(all)) if (r.kind === 'once') armOnceTimer(r);
            } catch (_) { }
        }
        // Lưới an toàn (poll 60s): once bị lỡ timer (restart) + lịch lặp (recurring cron).
        async function fireDueReminders() {
            const nowMs = Date.now();
            const minKey = new Date(nowMs + 7 * 3600 * 1000).toISOString().slice(0, 16); // theo phút giờ VN
            const all = await readPluginDataJson('reminders.json');
            for (const [id, r] of Object.entries(all)) {
                try {
                    if (r.kind === 'once') {
                        if (Number(r.fireAtMs) && nowMs >= Number(r.fireAtMs) && !_zmFiredOnce.has(id)) {
                            await fireOnceReminder(id);
                        }
                    } else if (r.kind === 'recurring' && r.cron) {
                        if (_zmRecLast.get(id) !== minKey && cronMatchesVn(r.cron, nowMs)) {
                            _zmRecLast.set(id, minKey);
                            await sendGroupMsg({ accountId: r.profile || 'default' }, r.groupId, `⏰ Nhắc: ${r.message}`);
                        }
                    }
                } catch (e) {
                    logger.warn(`[openclaw-zalo-mod] fire reminder ${id} lỗi: ${e.message}`);
                }
            }
        }

        function summariesDir(groupId) {
            return path.join(dataDir, 'summaries', String(groupId).replace(/^group:/, ''));
        }
        async function getSummary(groupId, dateStr) {
            try { return JSON.parse(await fs.readFile(path.join(summariesDir(groupId), `${dateStr}.json`), 'utf8')); }
            catch { return null; }
        }
        async function listSummaryDates(groupId) {
            try {
                return (await fs.readdir(summariesDir(groupId))).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort().reverse();
            } catch { return []; }
        }

        const SUMMARY_TRANSCRIPT_MAX = 15000; // ký tự transcript tối đa đưa cho AI

        /** Tạo bản tổng hợp 1 ngày: trích xuất link/note/memory (chính xác) + AI lo overview/nổi bật/lặp/hẹn lịch */
        async function generateDailySummary(groupId, dateStr, opts = {}) {
            const date = dateStr || vnDateStr();
            const history = await readChatHistory(groupId, date);

            // Backfill tên: log cũ (hoặc lỡ ghi thiếu) có name == userId → resolve ID→tên qua API (cache),
            // để transcript đưa cho AI + danh sách người tham gia hiển thị ĐÚNG TÊN, không phải dãy số.
            const _prof = primaryProfile(groupNames[String(groupId).replace(/^group:/, '')]?.profile);
            const _needResolve = [...new Set(history.filter(e => !e.name || e.name === e.userId).map(e => String(e.userId || '')).filter(Boolean))];
            const _nameMap = {};
            for (const uid of _needResolve) { const rn = await resolveUserName(_prof, uid); if (rn) _nameMap[uid] = rn; }
            for (const e of history) {
                e.dispName = _nameMap[String(e.userId || '')] || (e.name && e.name !== e.userId ? e.name : '') || e.name || String(e.userId || '');
            }

            // Phần trích xuất deterministic
            const linkMap = new Map();
            for (const e of history) for (const u of (e.links || [])) if (!linkMap.has(u)) linkMap.set(u, e.dispName || '');
            const links = [...linkMap.entries()].map(([url, name]) => ({ url, name }));
            const notes = (await getNotes(groupId)).filter(n => vnDateStr(new Date(n.ts)) === date).map(n => ({ name: n.userName, text: n.text }));
            const memories = (await getGroupMemories(groupId)).filter(m => vnDateStr(new Date(m.ts)) === date).map(m => ({ name: m.userName, text: m.text }));

            // Người tham gia (deterministic) — đếm số tin theo tên, loại tin của chính bot.
            const _botLc = new Set([botName, ...(botNames || [])].map(n => String(n).toLowerCase()));
            const talkCount = new Map();
            for (const e of history) {
                const nm = String(e.dispName || '').trim();
                if (!nm || _botLc.has(nm.toLowerCase())) continue;
                talkCount.set(nm, (talkCount.get(nm) || 0) + 1);
            }
            const participants = [...talkCount.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

            // Phần AI
            let ai = { overview: '', keySpeakers: [], highlights: [], repeatedTopics: [], appointments: [] };
            let aiOk = false;
            if (history.length > 0) {
                let transcript = history.filter(e => !_botLc.has(String(e.dispName || '').toLowerCase())).map(e => `${e.t} ${e.dispName}: ${e.text}`).join('\n');
                if (transcript.length > SUMMARY_TRANSCRIPT_MAX) transcript = '(…đã rút gọn, chỉ phần gần nhất trong ngày)\n' + transcript.slice(-SUMMARY_TRANSCRIPT_MAX);
                const prompt = `Bạn là trợ lý tổng hợp hội thoại nhóm chat Zalo. Dưới đây là tin nhắn trong ngày ${date} (giờ VN) của nhóm "${getGroupName(groupId)}".\n\n[TIN NHẮN]\n${transcript}\n\nTrả về DUY NHẤT một JSON (không kèm giải thích, không markdown) theo schema:\n{"overview":"tóm tắt 3-5 câu nội dung chính","keySpeakers":[{"name":"","gist":""}],"highlights":["điểm quan trọng/nổi bật"],"repeatedTopics":["chủ đề nhắc lại nhiều lần"],"appointments":[{"name":"","what":"hẹn việc gì","when":"thời gian nếu có"}]}\nMục nào không có thì để mảng rỗng. Viết tiếng Việt tự nhiên, ngắn gọn.`;
                try {
                    const raw = await callSmartRoute(prompt);
                    const m = raw.match(/\{[\s\S]*\}/);
                    if (m) {
                        const p = JSON.parse(m[0]);
                        ai = {
                            overview: String(p.overview || ''),
                            keySpeakers: Array.isArray(p.keySpeakers) ? p.keySpeakers : [],
                            highlights: Array.isArray(p.highlights) ? p.highlights : [],
                            repeatedTopics: Array.isArray(p.repeatedTopics) ? p.repeatedTopics : [],
                            appointments: Array.isArray(p.appointments) ? p.appointments : [],
                        };
                        aiOk = true;
                    }
                } catch (e) {
                    logger.warn(`[openclaw-zalo-mod] generateDailySummary AI failed: ${e.message}`);
                }
            }

            const summary = {
                groupId: String(groupId).replace(/^group:/, ''),
                date,
                generatedAt: new Date().toISOString(),
                by: opts.by || 'manual',
                messageCount: history.length,
                aiOk,
                sections: { overview: ai.overview, participants, keySpeakers: ai.keySpeakers, highlights: ai.highlights, repeatedTopics: ai.repeatedTopics, links, notes, memories, appointments: ai.appointments },
            };

            // Lưu JSON (cho UI) + markdown (cho agent đọc)
            try {
                const dir = summariesDir(groupId);
                await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(path.join(dir, `${date}.json`), JSON.stringify(summary, null, 2), 'utf8');
                await fs.mkdir(getMemoryDir(groupId), { recursive: true });
                await fs.writeFile(path.join(getMemoryDir(groupId), `daily-summary-${date}.md`), summaryToMarkdown(summary), 'utf8');
            } catch (e) {
                logger.warn(`[openclaw-zalo-mod] save summary failed: ${e.message}`);
            }
            return summary;
        }

        function summaryToMarkdown(s) {
            const x = s.sections; const L = [`# Tổng hợp ${s.date} — ${getGroupName(s.groupId)}`, '', `> ${s.messageCount} tin nhắn · tạo ${vnTimeStr(new Date(new Date(s.generatedAt).getTime() + 7 * 3600 * 1000))} ${s.date}`, ''];
            if (x.overview) L.push('## Tổng quan', x.overview, '');
            if (x.participants?.length) L.push('## Người tham gia', ...x.participants.map(p => `- **${p.name}** (${p.count} tin)`), '');
            if (x.highlights?.length) L.push('## Nổi bật', ...x.highlights.map(h => `- ${h}`), '');
            if (x.repeatedTopics?.length) L.push('## Chủ đề lặp lại', ...x.repeatedTopics.map(t => `- ${t}`), '');
            if (x.keySpeakers?.length) L.push('## Người nói chính', ...x.keySpeakers.map(k => `- **${k.name}**: ${k.gist}`), '');
            if (x.appointments?.length) L.push('## Hẹn lịch', ...x.appointments.map(a => `- ${a.name || ''}: ${a.what}${a.when ? ` (${a.when})` : ''}`), '');
            if (x.links?.length) L.push('## Link', ...x.links.map(l => `- ${l.url}${l.name ? ` — ${l.name}` : ''}`), '');
            if (x.notes?.length) L.push('## Note', ...x.notes.map(n => `- ${n.name}: ${n.text}`), '');
            if (x.memories?.length) L.push('## Memory', ...x.memories.map(m => `- ${m.name}: ${m.text}`), '');
            return L.join('\n') + '\n';
        }

        function formatSummaryText(s) {
            const x = s.sections; const L = [`📊 TỔNG HỢP ${s.date} — ${getGroupName(s.groupId)}`, `💬 ${s.messageCount} tin nhắn`];
            if (s.messageCount === 0) { L.push('\n(Không có tin nhắn nào được ghi trong ngày này. Cần bật tracking cho group.)'); return L.join('\n'); }
            if (x.overview) L.push(`\n📌 ${x.overview}`);
            if (x.participants?.length) L.push(`\n👥 Người tham gia (${x.participants.length}):\n${x.participants.map(p => `• ${p.name} (${p.count} tin)`).join('\n')}`);
            if (x.keySpeakers?.length) L.push(`\n🗣️ Ai nói gì:\n${x.keySpeakers.map(k => `• ${k.name}: ${k.gist}`).join('\n')}`);
            if (x.highlights?.length) L.push(`\n⭐ Nổi bật:\n${x.highlights.map(h => `• ${h}`).join('\n')}`);
            if (x.repeatedTopics?.length) L.push(`\n🔁 Lặp lại: ${x.repeatedTopics.join(', ')}`);
            if (x.appointments?.length) L.push(`\n📅 Hẹn lịch:\n${x.appointments.map(a => `• ${a.name || ''}: ${a.what}${a.when ? ` (${a.when})` : ''}`).join('\n')}`);
            if (x.links?.length) L.push(`\n🔗 Link (${x.links.length}):\n${x.links.slice(0, 10).map(l => `• ${l.url}${l.name ? ` — ${l.name}` : ''}`).join('\n')}`);
            if (x.notes?.length) L.push(`\n📝 Note:\n${x.notes.map(n => `• ${n.name}: ${n.text}`).join('\n')}`);
            if (x.memories?.length) L.push(`\n🧠 Memory:\n${x.memories.map(m => `• ${m.name}: ${m.text}`).join('\n')}`);
            if (!s.aiOk) L.push('\n⚠️ (AI tóm tắt tạm không khả dụng — chỉ hiển thị phần trích xuất tự động)');
            return L.join('\n');
        }

        function parseHistoryDate(arg) {
            const a = String(arg || '').trim().toLowerCase();
            if (!a || ['today', 'hom-nay', 'hôm nay', 'homnay', 'nay'].includes(a)) return vnDateStr();
            if (['yesterday', 'hom-qua', 'hôm qua', 'homqua', 'qua'].includes(a)) return vnDateStr(new Date(Date.now() + 7 * 3600 * 1000 - 86400000));
            if (/^\d{4}-\d{2}-\d{2}$/.test(a)) return a;
            const m = a.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?$/);
            if (m) return `${m[3] || vnNow().getUTCFullYear()}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
            return vnDateStr();
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

        async function appendChatLog(groupId, senderName, content, senderId = '') {
            try {
                // 1. Dedup check
                const fp = chatFingerprint(String(groupId) + senderName, content);
                if (isTrackingDuplicate(fp)) return;

                // 1b. Ghi lịch sử có cấu trúc (JSONL) song song với markdown
                await recordChatMessage(groupId, senderId, senderName, content);

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

        // Mọi thao tác Zalo dùng facade trên bridge công khai của Zalo Connect.
        async function resolveZaloApiModule() {
            const facade = getZcaFacade();
            if (facade?.serviceAvailable()) return facade.compatModule;
            return null;
        }

        // Send wrappers route qua Zalo Connect bridge/service công khai.
        async function sendGroupMsg(ctx, groupId, text) {
            if (!groupId || !text) return { ok: false, error: 'groupId and text are required' };
            const profile = ctx?.accountId || 'default';
            logger.info(`[openclaw-zalo-mod] sendGroupMsg → threadId=${groupId}, profile=${profile}, textLen=${text.length}`);
            try {
                const r = await zEngine.bridge.execute(profile, {
                    action: 'send-message', threadId: String(groupId), isGroup: true, message: String(text),
                });
                return { ok: r?.ok !== false, messageId: r?.messageId, error: r?.error };
            } catch (err) {
                logger.error(`[openclaw-zalo-mod] sendGroupMsg failed: ${err.message}`);
                return { ok: false, error: err.message };
            }
        }

        async function sendDmMsg(ctx, userId, text, imageUrl = null) {
            if (!userId || (!text && !imageUrl)) return { ok: false, error: 'userId and message content are required' };
            const profile = ctx?.accountId || 'default';
            try {
                const r = await zEngine.bridge.execute(profile, {
                    action: imageUrl ? 'send-image' : 'send-message',
                    threadId: String(userId), isGroup: false,
                    message: String(text || ''), imageUrl: imageUrl || undefined,
                });
                return { ok: r?.ok !== false, messageId: r?.messageId, error: r?.error };
            } catch (err) {
                logger.error(`[openclaw-zalo-mod] sendDmMsg failed to ${userId}: ${err.message}`);
                return { ok: false, error: err.message };
            }
        }

        function isAdmin(senderId, groupId) {
            const botCfg = getBotConfig(groupId || 'default');
            const botOwnerId = botCfg.ownerId || (botCfg.profile === 'default' ? ownerId : '');
            if (String(senderId) === botOwnerId) return true;
            if (String(senderId) === ownerId) return true;
            if (adminIds.has(String(senderId)) || (botCfg.ownerId && String(senderId) === botCfg.ownerId)) return true;
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

        let _memberDirMtime = 0;
        async function loadMemberDir() {
            try {
                const raw = await fs.readFile(memberDirPath, 'utf8');
                _memberDir = JSON.parse(raw) || {};
                try { _memberDirMtime = (await fs.stat(memberDirPath)).mtimeMs; } catch { }
            } catch { _memberDir = {}; }
        }
        // Nạp lại từ disk khi file đổi (mtime). Plugin register 2 lần (mỗi bot 1 closure, mỗi closure 1
        // _memberDir RAM). Không reload trước khi ghi → closure này ghi đè state cũ của closure kia
        // (vd resurrect member vừa bị kick). Giống ensureStore cho settings.
        async function reloadMemberDirIfChanged() {
            try {
                const m = (await fs.stat(memberDirPath)).mtimeMs;
                if (m > _memberDirMtime) { _memberDir = JSON.parse(await fs.readFile(memberDirPath, 'utf8')) || {}; _memberDirMtime = m; }
            } catch { }
        }

        async function saveMemberDir() {
            try {
                await fs.mkdir(dataDir, { recursive: true });
                await fs.writeFile(memberDirPath, JSON.stringify(_memberDir, null, 2), 'utf8');
                try { _memberDirMtime = (await fs.stat(memberDirPath)).mtimeMs; } catch { }
            } catch (e) {
                logger.warn(`[openclaw-zalo-mod] save member-dir failed: ${e.message}`);
            }
        }

        // Xoá member khỏi memberDir (sau kick/block) → reload không còn hiện + giảm memberCount.
        // Đa-bot: xoá trên MỌI ID cùng nhóm (siblingGroupIds) vì mỗi bot có groupId + userId theo view riêng.
        async function removeMembersFromDir(groupId, memberIds) {
            const ids = new Set((Array.isArray(memberIds) ? memberIds : [memberIds]).map(x => String(x).replace(/_0$/, '')));
            if (!ids.size) return;
            await reloadMemberDirIfChanged(); // làm việc trên state đĩa mới nhất (đa-closure)
            let changed = false;
            for (const gid of siblingGroupIds(String(groupId).replace(/^group:/, ''))) {
                const dir = _memberDir[gid];
                if (!dir) continue;
                for (const uid of Object.keys(dir)) {
                    if (ids.has(String(uid).replace(/_0$/, ''))) { delete dir[uid]; changed = true; }
                }
                const cur = Number(store.getSetting(gid, 'memberCount', 0)) || 0;
                if (cur > 0) store.setSetting(gid, 'memberCount', Math.max(0, cur - ids.size));
            }
            if (changed) { await saveMemberDir(); await store.saveSettings().catch(() => { }); }
        }

        /**
         * Cập nhật member directory cho 1 group từ kết quả poll.
         * Trả về true nếu thực sự có thành viên mới / đổi tên (cần ghi file),
         * false nếu không có gì thay đổi → bỏ qua ghi file để tránh I/O liên tục.
         */
        function updateMemberDir(groupId, members) {
            if (!Array.isArray(members)) return false;
            if (!_memberDir[groupId]) _memberDir[groupId] = {};
            const dir = _memberDir[groupId];
            let changed = false;
            for (const m of members) {
                if (!m.id) continue;
                const newName = m.name || dir[m.id] || m.id;
                if (dir[m.id] !== newName) {
                    dir[m.id] = newName;
                    changed = true;
                }
            }
            return changed;
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
        // OpenClaw Zalo Connect channel ONLY forwards text messages to before_dispatch.
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
        const _friendIdCache = new Set();    // cache id bạn bè (cho permissions.dm mode 'friends')

        async function loadZaloApi() {
            if (_G.zaloApiModule) return _G.zaloApiModule;
            if (_watcherApiUnavailable) return null;  // đã biết không có, không thử nữa

            const mod = await resolveZaloApiModule();
            if (mod) {
                _G.zaloApiModule = mod;
                return mod;
            }

            // Tất cả path fail
            logger.warn(`[openclaw-zalo-mod] [WATCHER] Zalo Connect bridge not available — member watcher disabled. Restart gateway nếu vừa cài xong OpenClaw.`);
            _watcherApiUnavailable = true;
            return null;
        }

        async function pollGroupMembers(groupId) {
            const failKey = String(groupId);
            try {
                const api = await loadZaloApi();
                if (!api?.listZaloGroupMembers) return null;

                const profile = primaryProfile(groupNames[groupId]?.profile);
                const members = await api.listZaloGroupMembers(profile, String(groupId));
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
        // Solution: use withZaloApi from Zalo Connect to safely access the active API instance without breaking cipher keys.

        // Facade route mọi API zca-js qua ZaloConnectBridge (lazy — cần zEngine.bridge).
        let _zcaFacade = null;
        function getZcaFacade() {
            if (_zcaFacade) return _zcaFacade;
            const bridge = globalThis.__zaloModEngine?.bridge;
            if (!bridge) return null;
            _zcaFacade = createZcaFacade({ getBridge: () => globalThis.__zaloModEngine?.bridge, logger });
            return _zcaFacade;
        }

        async function getSafeZaloApi() {
            const facade = getZcaFacade();
            if (facade?.serviceAvailable()) return facade.withZaloApi;
            logger.info('[openclaw-zalo-mod] OpenClaw Zalo Connect bridge chưa sẵn sàng');
            return null;
        }

        function _invalidateZcaApi() {
            // No-op: we no longer manage a separate zca-js instance
        }

        /**
         * Gọi ZCA getGroupInfo trực tiếp → trả { creatorId, adminIds, totalMember, name }
         */
        async function fetchGroupAdminsFromZCA(groupId, targetProfile = null) {
            try {
                const withZaloApi = await getSafeZaloApi();
                if (!withZaloApi) return null;

                const profile = targetProfile || primaryProfile(groupNames[groupId]?.profile);
                return await withZaloApi(profile, async (api) => {
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

        // ── Follow (đã GỘP tracking): theo dõi nhóm = ghi lịch sử chat + memory ──
        // Đọc cả key 'tracking' cũ để tương thích dữ liệu; mọi toggle set cả 2 key cho đồng bộ.
        function isFollowOn(gid) {
            return store.getSetting(gid, 'follow', false) === true || store.getSetting(gid, 'tracking', false) === true;
        }
        function setFollow(gid, val) {
            store.setSetting(gid, 'follow', !!val);
            store.setSetting(gid, 'tracking', !!val);
        }

        /**
         * ĐƯỜNG GHI DUY NHẤT cho mọi toggle per-group.
         *
         * Trước đây slash command và dashboard có 2 implementation riêng và đã
         * lệch thật: `/mute` ghi settings cho ĐÚNG MỘT groupId nhưng lại sync
         * runtime cho toàn bộ sibling, còn dashboard thì ghi cho mọi sibling.
         * Hệ quả: owner gõ `/rules mute <gid> on` với gid của bot A thì badge của
         * cùng nhóm đó dưới bot B vẫn tắt → nhìn như "bot nói đã mute mà UI không
         * đổi". Giờ slash, dashboard và agent tool dùng chung hàm này.
         *
         * Một nhóm Zalo có nhiều groupId — mỗi bot một id per-account. Không có
         * `profile` = áp cho mọi bot trong nhóm đó (mặc định đúng cho owner);
         * có `profile` = chỉ đúng id được truyền vào.
         */
        async function applyToggleSetting({ groupIds, key, value, profile, scope } = {}) {
            const cleanKey = String(key || '').trim();
            if (!TOGGLE_KEYS.includes(cleanKey)) throw new Error(`Invalid setting key: ${cleanKey || '(empty)'}`);
            const ids = (Array.isArray(groupIds) ? groupIds : [groupIds]).map((g) => String(g || '').replace(/^group:/, '').trim()).filter(Boolean);
            if (!ids.length) throw new Error('Invalid setting payload: empty groupIds');

            // scope:'self' = chỉ đúng groupId truyền vào (dùng khi đăng ký group mới
            // cho riêng bot này). Mặc định fan-out sang mọi bot cùng nhóm.
            const perBot = scope === 'self' || (!!profile && String(profile).trim() !== '' && String(profile) !== 'all');
            const targets = new Set();
            for (const gid of ids) {
                if (perBot) targets.add(gid);
                else for (const sib of siblingGroupIds(gid)) targets.add(sib);
            }
            const val = !!value;
            // follow/tracking đã gộp → set cả 2 key cho đồng bộ dữ liệu cũ.
            for (const id of targets) {
                if (cleanKey === 'follow' || cleanKey === 'tracking') setFollow(id, val);
                else store.setSetting(id, cleanKey, val);
            }
            await store.saveSettings();
            const runtimePolicy = (cleanKey === 'muted' || cleanKey === 'silent')
                ? await syncZaloConnectRuntimePolicies([...targets])
                : undefined;
            return { key: cleanKey, value: val, count: targets.size, groupIds: [...targets], runtimePolicy };
        }

        /**
         * Sync group admins từ ZCA API → settings.json + groupNames config
         * Gọi khi /groupid-add hoặc ${cmdPrefix}rules groupid
         */
        async function syncGroupAdminsFromZCA(groupId, targetProfile = null) {
            const resolvedProfile = targetProfile || primaryProfile(groupNames[groupId]?.profile);
            const zcaInfo = await fetchGroupAdminsFromZCA(groupId, resolvedProfile);
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
                if (!groupNames[groupId].profile) groupNames[groupId].profile = resolvedProfile;
            } else {
                groupNames[groupId] = { name: zcaInfo.name || '', admins: adminList, creatorId: zcaInfo.creatorId || '', profile: resolvedProfile };
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

            // Baseline BỀN VỮNG = member-dir đã lưu trên đĩa (chụp TRƯỚC khi cập nhật).
            // Nhờ sống sót qua restart, người vào nhóm lúc bot offline vẫn được tính là
            // "mới" và được chào — thay vì bị nuốt vào baseline RAM khi gateway khởi động lại.
            const knownBefore = new Set(Object.keys(_memberDir[groupId] || {}));
            const hadDiskBaseline = knownBefore.size > 0;
            const hadMemSnapshot = _G.memberSnapshots.has(groupId);

            // Cập nhật member directory (persistent) — chỉ ghi file khi có thay đổi
            await reloadMemberDirIfChanged(); // tránh ghi đè removal của closure/kick khác
            if (updateMemberDir(groupId, members)) {
                saveMemberDir(); // fire-and-forget
            }

            const currentIds = new Set(members.map(m => m.id));
            _G.memberSnapshots.set(groupId, currentIds);

            if (!hadDiskBaseline && !hadMemSnapshot) {
                // Chưa từng biết group này (member-dir trống + chưa snapshot) →
                // chỉ lập baseline, không chào cả nhóm.
                logger.info(`[openclaw-zalo-mod] [WATCHER] initial snapshot for group ${groupId}: ${currentIds.size} members (member-dir seeded)`);
                return;
            }

            // Mới = chưa từng xuất hiện trong member-dir trên đĩa.
            // Đã chào → nằm trong member-dir (đã persist) → không bao giờ chào lại, kể cả sau restart.
            const newMembers = members.filter(m => !knownBefore.has(m.id));

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
                    const botCfg = getBotConfig(groupId);
                    const welcomeTpl = await loadTemplateContent(dataDir, 'welcome');
                    const welcomeText = renderTemplate(welcomeTpl, { memberName, groupName: getGroupName(groupId), botName: botCfg.botName, cmdPrefix: botCfg.cmdPrefix });
                    await sendGroupMsg({ accountId: botCfg.profile }, groupId, welcomeText);
                    await appendToMemoryFile(groupId, 'chat-highlights.md', `| ${nowShort()} | SYSTEM | Welcome: ${memberName} joined (detected by watcher) |`);
                    logger.info(`[openclaw-zalo-mod] [WATCHER] welcome sent for ${memberName} in group ${groupId}`);
                } catch (e) {
                    logger.error(`[openclaw-zalo-mod] [WATCHER] welcome send failed for ${memberName}: ${e.message}`);
                }
                // Small delay between messages to avoid rate limiting
                await new Promise(r => setTimeout(r, 2000));
            }
            if (toWelcome.length > 5) {
                const botCfg = getBotConfig(groupId);
                await sendGroupMsg({ accountId: botCfg.profile }, groupId,
                    `👋 Và ${toWelcome.length - 5} bạn mới nữa — chào mừng tất cả! 🎉\n${botCfg.cmdPrefix}noi-quy để xem nội quy nhóm.`
                );
            }
        }

        // ── Scheduler báo cáo tự động cuối ngày (Phase 4) ──
        // Chuẩn hoá "H:MM"/"HH:MM" → "HH:MM" (so sánh chuỗi theo giờ VN cần zero-pad).
        function normReportTime(t) {
            const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
            if (!m) return '23:55';
            const hh = String(Math.min(23, Number(m[1]))).padStart(2, '0');
            return `${hh}:${m[2]}`;
        }
        // Gửi báo cáo cuối ngày cho MỘT nhóm theo cấu hình gửi RIÊNG của nhóm đó.
        async function runOneGroupReport(gid, date) {
            const summary = await generateDailySummary(gid, date, { by: 'auto' });
            const text = formatSummaryText(summary);
            const prof = primaryProfile(groupNames[gid]?.profile);
            const toGroup = store.getSetting(gid, 'reportDeliverThisGroup', true) === true;
            const toOwner = store.getSetting(gid, 'reportDeliverOwnerDm', false) === true;
            if (toGroup) await sendGroupMsg({ accountId: prof }, gid, text);
            if (toOwner) {
                const oid = getBotConfig(gid).ownerId || ownerId;
                if (oid) await sendDmMsg({ accountId: prof }, oid, text);
            }
        }
        // ══ LỊCH BÁO CÁO (report jobs) ═══════════════════════════════════════════════════════
        // Trước đây lịch là 4 setting rời trên TỪNG nhóm (autoSummary/reportTime/reportDeliver*),
        // nên không thể diễn tả "12 nhóm này gộp thành MỘT tin lúc 22:30, DM owner". Nay lịch là
        // một thực thể riêng: chọn tập nhóm + giờ + nơi nhận + kiểu (lẻ / tổng hợp).
        //   kind 'group'  → mỗi nhóm một báo cáo riêng (hành vi cũ)
        //   kind 'digest' → MỘT báo cáo gộp cho cả tập nhóm
        // deliver.eachGroup chỉ có nghĩa với kind 'group' (một tin gộp không có "nhóm của nó").
        const REPORT_JOBS_FILE = 'report-jobs.json';
        // Zalo tự cắt tin quá dài, cắt giữa câu, nên digest tự cắt trước theo ranh giới NHÓM.
        // ~3500 ký tự là ngưỡng an toàn quan sát được cho một tin nhóm.
        const DIGEST_SAFE_CHARS = 3500;

        function normalizeReportJob(j) {
            if (!j || typeof j !== 'object') return null;
            const id = String(j.id || '').trim() || `job-${Math.random().toString(36).slice(2, 10)}`;
            const kind = j.kind === 'digest' ? 'digest' : 'group';
            const groups = j.groups === '*' ? '*' : (Array.isArray(j.groups) ? j.groups.map(String).filter(Boolean) : []);
            const d = j.deliver || {};
            return {
                id,
                name: String(j.name || '').trim() || (kind === 'digest' ? 'Báo cáo tổng hợp' : 'Báo cáo từng nhóm'),
                enabled: j.enabled !== false,
                kind,
                groups,
                time: normReportTime(j.time),
                deliver: {
                    ownerDm: d.ownerDm === true,
                    // Một digest không có "nhóm của chính nó" để gửi vào.
                    eachGroup: kind === 'group' && d.eachGroup === true,
                    groups: Array.isArray(d.groups) ? d.groups.map(String).filter(Boolean) : [],
                },
            };
        }

        async function readReportJobs() {
            const raw = await readPluginDataJson(REPORT_JOBS_FILE);
            return (Array.isArray(raw?.jobs) ? raw.jobs : []).map(normalizeReportJob).filter(Boolean);
        }
        async function writeReportJobs(jobs) {
            await writePluginDataJson(REPORT_JOBS_FILE, { jobs: jobs.map(normalizeReportJob).filter(Boolean) });
        }

        /** '*' cố ý resolve lúc chạy, để nhóm mới thêm vào sau tự được lịch "tất cả" bao gồm. */
        function resolveJobGroups(job) {
            const all = watchGroupIds.filter(gid => isFollowOn(gid));
            if (job.groups === '*') return all;
            return job.groups.filter(gid => watchGroupIds.includes(gid));
        }

        /**
         * Gộp cấu hình per-group cũ thành job, một lần.
         *
         * Nhóm theo (giờ + nơi nhận) nên 24 nhóm cùng 22:30 cùng cách gửi trở thành MỘT job thay vì
         * 24 job vụn. Không chạy nếu đã có job — người dùng sửa tay rồi thì không được ghi đè.
         */
        async function ensureReportJobsMigrated() {
            const existing = await readReportJobs();
            if (existing.length) return existing;
            const legacy = watchGroupIds.filter(gid => store.getSetting(gid, 'autoSummary', false) === true);
            if (!legacy.length) return [];
            const buckets = new Map();
            for (const gid of legacy) {
                const time = normReportTime(store.getSetting(gid, 'reportTime', '23:55'));
                const toGroup = store.getSetting(gid, 'reportDeliverThisGroup', true) === true;
                const toOwner = store.getSetting(gid, 'reportDeliverOwnerDm', false) === true;
                const key = `${time}|${toGroup}|${toOwner}`;
                if (!buckets.has(key)) buckets.set(key, { time, toGroup, toOwner, gids: [] });
                buckets.get(key).gids.push(gid);
            }
            const jobs = [...buckets.values()].map((b, i) => normalizeReportJob({
                id: `legacy-${i + 1}`,
                name: `Lịch cũ ${b.time}`,
                kind: 'group',
                groups: b.gids,
                time: b.time,
                deliver: { ownerDm: b.toOwner, eachGroup: b.toGroup, groups: [] },
            }));
            await writeReportJobs(jobs);
            logger.info(`[openclaw-zalo-mod] [REPORT] đã chuyển ${legacy.length} nhóm cấu hình cũ thành ${jobs.length} lịch báo cáo`);
            return jobs;
        }

        /**
         * Dựng báo cáo tổng hợp — KHÔNG gọi model thêm lần nào.
         *
         * Bản tóm tắt từng nhóm đã được model viết và lưu ở summaries/<gid>/<date>.json, nên digest chỉ
         * chọn lọc lại: mỗi nhóm lấy tối đa 3 điểm (ưu tiên highlights của model), việc có hẹn/chưa xong
         * gắn ⚠️. Nhờ vậy thêm digest tốn 0 token — quan trọng vì mỗi request đang ~26k prompt token.
         */
        async function buildDigestParts(groupIds, date) {
            const blocks = [];
            let totalMsgs = 0, totalLinks = 0, totalAppts = 0;
            for (const gid of groupIds) {
                let s = await getSummary(gid, date);
                if (!s) s = await generateDailySummary(gid, date, { by: 'auto' }).catch(() => null);
                if (!s || !s.messageCount) continue;
                const x = s.sections || {};
                totalMsgs += s.messageCount;
                totalLinks += (x.links || []).length;
                totalAppts += (x.appointments || []).length;
                const bullets = [];
                for (const h of (x.highlights || [])) {
                    if (bullets.length >= 3) break;
                    bullets.push(`  • ${h}`);
                }
                for (const a of (x.appointments || [])) {
                    if (bullets.length >= 3) break;
                    bullets.push(`  • ⚠️ ${a.name ? `${a.name}: ` : ''}${a.what}${a.when ? ` (${a.when})` : ''}`);
                }
                if (!bullets.length && x.overview) bullets.push(`  • ${String(x.overview).split(/(?<=[.!?])\s/)[0]}`);
                blocks.push(`📋 ${getGroupName(gid)} — ${s.messageCount} tin · ${(x.participants || []).length} người\n${bullets.join('\n')}`);
            }
            return { blocks, totalMsgs, totalLinks, totalAppts, groupCount: blocks.length };
        }

        /** Digest đã format, cắt sẵn theo ranh giới nhóm để Zalo không cắt giữa câu. */
        async function buildDigestMessages(groupIds, date) {
            const { blocks, totalMsgs, totalLinks, totalAppts, groupCount } = await buildDigestParts(groupIds, date);
            const head = `📊 TỔNG HỢP ${date} · ${groupCount} nhóm · ${totalMsgs} tin`;
            if (!groupCount) return [`${head}\n\n(Không có nhóm nào có tin nhắn được ghi trong ngày này.)`];
            const foot = [
                totalLinks ? `🔗 ${totalLinks} link` : '',
                totalAppts ? `📅 ${totalAppts} hẹn lịch` : '',
            ].filter(Boolean).join(' · ');
            const tail = foot ? `\n\n${foot} → xem chi tiết ở dashboard` : '';

            // Gom block cho tới ngưỡng an toàn, rồi sang phần mới. Cắt GIỮA CÁC NHÓM, không giữa câu.
            const pages = [];
            let cur = [];
            let len = head.length + tail.length;
            for (const b of blocks) {
                if (cur.length && len + b.length + 2 > DIGEST_SAFE_CHARS) {
                    pages.push(cur); cur = []; len = head.length + tail.length;
                }
                cur.push(b); len += b.length + 2;
            }
            if (cur.length) pages.push(cur);
            return pages.map((page, i) => {
                const label = pages.length > 1 ? `${head}  (phần ${i + 1}/${pages.length})` : head;
                const isLast = i === pages.length - 1;
                return `${label}\n\n${page.join('\n\n')}${isLast ? tail : ''}`;
            });
        }

        /** Gửi một danh sách tin tới các đích của job (DM owner / nhóm nhận chỉ định). */
        async function deliverReportTexts(job, texts, { selfGroupId = '' } = {}) {
            const prof = primaryProfile(groupNames[selfGroupId]?.profile);
            const send = async (fn) => {
                for (const t of texts) { await fn(t); await new Promise(r => setTimeout(r, 1200)); }
            };
            if (job.deliver.eachGroup && selfGroupId) {
                await send((t) => sendGroupMsg({ accountId: prof }, selfGroupId, t));
            }
            if (job.deliver.ownerDm) {
                const oid = getBotConfig(selfGroupId).ownerId || ownerId;
                if (oid) await send((t) => sendDmMsg({ accountId: prof }, oid, t));
            }
            for (const gid of job.deliver.groups) {
                await send((t) => sendGroupMsg({ accountId: primaryProfile(groupNames[gid]?.profile) }, gid, t));
            }
        }

        /** Chạy một job ngay (dùng cho scheduler và cho nút "Gửi thử" trên dashboard). */
        async function runReportJob(job, date) {
            const gids = resolveJobGroups(job);
            if (!gids.length) return { sent: 0, groups: 0 };
            if (job.kind === 'digest') {
                const texts = await buildDigestMessages(gids, date);
                await deliverReportTexts(job, texts);
                return { sent: texts.length, groups: gids.length };
            }
            let sent = 0;
            for (const gid of gids) {
                const summary = await generateDailySummary(gid, date, { by: 'auto' });
                await deliverReportTexts(job, [formatSummaryText(summary)], { selfGroupId: gid });
                sent++;
                await new Promise(r => setTimeout(r, 2000)); // tránh rate limit
            }
            return { sent, groups: gids.length };
        }

        // Quét mỗi phút: tới giờ của job nào thì chạy job đó — một lần/ngày/job, chống lặp qua
        // report-state.json khoá theo (NGÀY + GIỜ đã hẹn) nên đổi giờ trong ngày vẫn chạy lịch mới.
        // Lưu ý: 'follow' chỉ bật ghi lịch sử chat; việc có báo cáo hay không do lịch báo cáo.
        async function runDueReports() {
            const jobs = (await ensureReportJobsMigrated()).filter(j => j.enabled);
            if (!jobs.length) return;
            const today = vnDateStr();
            const now = vnTimeStr();
            const raw = await readPluginDataJson('report-state.json');
            const byJob = (raw && typeof raw === 'object' && raw.byJob && typeof raw.byJob === 'object') ? raw.byJob : {};
            const byGroup = (raw && typeof raw === 'object' && raw.byGroup && typeof raw.byGroup === 'object') ? raw.byGroup : {};
            for (const job of jobs) {
                if (now < job.time) continue;
                const ran = byJob[job.id];
                if (ran && ran.date === today && ran.time === job.time) continue;
                byJob[job.id] = { date: today, time: job.time };
                await writePluginDataJson('report-state.json', { byJob, byGroup });
                try {
                    const r = await runReportJob(job, today);
                    logger.info(`[openclaw-zalo-mod] [REPORT] lịch "${job.name}" (${job.kind}, giờ ${job.time}) → ${r.sent} tin cho ${r.groups} nhóm, ngày ${today}`);
                } catch (e) {
                    logger.warn(`[openclaw-zalo-mod] [REPORT] lỗi lịch "${job.name}": ${e.message}`);
                }
            }
        }

        // ── Auto-duyệt member chờ (pendingAuto) — CHỈ khi bot là admin nhóm; lọc theo từ khoá tên ──
        // Lọc: pluginCfg.pendingBlockKeywords (mảng) — tên chứa từ khoá này thì BỎ QUA (không duyệt).
        async function autoApprovePending() {
            const withZaloApi = await getSafeZaloApi();
            if (!withZaloApi) return;
            const blockKw = (pluginCfg.pendingBlockKeywords || []).map(s => String(s).toLowerCase()).filter(Boolean);
            for (const gid of watchGroupIds) {
                if (store.getSetting(gid, 'pendingAuto', false) !== true) continue;
                // Group nhiều bot → thử từng bot; bot NÀO là admin mới xem/duyệt được pending (API tự chặn).
                const profiles = parseProfiles(groupNames[gid]?.profile);
                let handled = false;
                for (const profile of profiles) {
                    if (handled) break;
                    try {
                        await withZaloApi(profile, async (zaloApi) => {
                            if (typeof zaloApi.getPendingGroupMembers !== 'function') return;
                            const list = pendingListFromResult(await zaloApi.getPendingGroupMembers(gid));
                            handled = true; // bot này gọi được (là admin) → không cần thử bot khác
                            if (!list.length) { store.setSetting(gid, 'pendingCount', 0); return; }
                            const approve = []; let skipped = 0;
                            for (const m of list) {
                                const uid = String(m.userId || m.uid || m.id || (typeof m === 'string' ? m : '')).trim();
                                if (!uid) continue;
                                const nm = String(m.displayName || m.dName || m.name || '').toLowerCase();
                                if (blockKw.length && blockKw.some(k => nm.includes(k))) { skipped++; continue; }
                                approve.push(uid);
                            }
                            if (approve.length) {
                                await zaloApi.reviewPendingMemberRequest({ members: approve, isApprove: true }, gid);
                                logger.info(`[openclaw-zalo-mod] [pendingAuto] ${getGroupName(gid)}: duyệt ${approve.length} (bot=${profile})${skipped ? `, bỏ ${skipped} theo lọc` : ''}`);
                            } else {
                                logger.info(`[openclaw-zalo-mod] [pendingAuto] ${getGroupName(gid)}: ${list.length} pending, bỏ hết theo lọc (bot=${profile})`);
                            }
                            store.setSetting(gid, 'pendingCount', skipped);
                        });
                        await store.saveSettings();
                        await new Promise(r => setTimeout(r, 1200)); // giãn cách tránh rate limit
                    } catch (e) {
                        // Bot này không phải admin (hoặc API lỗi) → thử bot kế; log để lộ nguyên nhân.
                        logger.warn(`[openclaw-zalo-mod] [pendingAuto] ${getGroupName(gid)} bot=${profile}: ${e.message}`);
                    }
                }
            }
        }
        // Làm mới pendingCount + memberCount cho MỌI group (batch getGroupInfo, không admin-gated).
        // Nhờ vậy UI hiện đúng số chờ duyệt / member mà không cần bấm Sync thủ công.
        async function refreshGroupStats() {
            const withZaloApi = await getSafeZaloApi();
            if (!withZaloApi) return;
            const byProfile = {};
            for (const gid of watchGroupIds) {
                const prof = primaryProfile(groupNames[gid]?.profile);
                (byProfile[prof] = byProfile[prof] || []).push(gid);
            }
            let changed = false;
            for (const [prof, gids] of Object.entries(byProfile)) {
                try {
                    await withZaloApi(prof, async (zaloApi) => {
                        for (const chunk of chunkArray(gids, 50)) {
                            let res; try { res = await zaloApi.getGroupInfo(chunk); } catch { continue; }
                            const map = res?.gridInfoMap || {};
                            for (const gid of chunk) {
                                const info = map[gid] || map[String(gid)];
                                if (!info) continue;
                                const pc = extractPendingCount(info);
                                if (pc != null && Number(store.getSetting(gid, 'pendingCount', 0)) !== pc) { store.setSetting(gid, 'pendingCount', pc); changed = true; }
                                const mc = Math.max(extractGroupMemberCount(info, 0), Number(store.getSetting(gid, 'memberCount', 0)) || 0);
                                if (mc && Number(store.getSetting(gid, 'memberCount', 0)) !== mc) { store.setSetting(gid, 'memberCount', mc); changed = true; }
                            }
                            await new Promise(r => setTimeout(r, 300));
                        }
                    });
                } catch (_) { /* profile lỗi → bỏ qua */ }
            }
            if (changed) await store.saveSettings();
        }
        function startReportScheduler() {
            const _R = globalThis.__zaloModReport = globalThis.__zaloModReport || { timer: null, lastRunDate: '' };
            if (_R.timer) clearInterval(_R.timer);
            _R.timer = setInterval(async () => {
                try {
                    // Lịch nhắc từ /note — quét mỗi phút, chạy độc lập với báo cáo cuối ngày.
                    await fireDueReminders();
                } catch (e) {
                    logger.warn(`[openclaw-zalo-mod] [REMINDER] scan error: ${e.message}`);
                }
                try {
                    // Làm mới pendingCount/memberCount mỗi ~3 phút (batch getGroupInfo).
                    if (Date.now() - (globalThis.__zmStatsLast || 0) > 180000) {
                        globalThis.__zmStatsLast = Date.now();
                        await refreshGroupStats();
                    }
                } catch (e) {
                    logger.warn(`[openclaw-zalo-mod] [STATS] refresh error: ${e.message}`);
                }
                try {
                    // Auto-duyệt member chờ — mỗi ~2 phút (throttle toàn cục, tránh gọi API dày).
                    if (Date.now() - (globalThis.__zmPendLast || 0) > 120000) {
                        globalThis.__zmPendLast = Date.now();
                        await autoApprovePending();
                    }
                } catch (e) {
                    logger.warn(`[openclaw-zalo-mod] [pendingAuto] scan error: ${e.message}`);
                }
                try {
                    // Báo cáo cuối ngày: mỗi nhóm bật autoSummary tự chạy theo giờ RIÊNG của nó.
                    await runDueReports();
                } catch (e) {
                    logger.warn(`[openclaw-zalo-mod] [REPORT] scheduler error: ${e.message}`);
                }
            }, 60 * 1000);
            if (_R.timer.unref) _R.timer.unref();
            logger.info('[openclaw-zalo-mod] [REPORT] scheduler started (kiểm tra mỗi phút theo giờ VN)');
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

            // Initial snapshot after a delay (let Zalo Connect fully connect first)
            _G.initTimer = setTimeout(async () => {
                _G.initTimer = null;
                await ensureStore();

                // Filter: only poll groups where welcome is ON
                const activeGroups = watchGroupIds.filter(gId => store.getSetting(gId, 'welcome', true));
                const skippedGroups = watchGroupIds.filter(gId => !store.getSetting(gId, 'welcome', true));
                logger.info(`[openclaw-zalo-mod] [WATCHER] starting member watcher — polling ${activeGroups.length}/${watchGroupIds.length} group(s), poll every ${intervalMs / 1000}s`);
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
            }, 30000); // 30s delay for Zalo Connect to connect
            if (_G.initTimer && _G.initTimer.unref) _G.initTimer.unref();
        }

        async function processGroupidAddAll(ctx, targetId, isGroupTarget, currentGroupId) {
            const sendMsg = isGroupTarget ? (m) => sendGroupMsg(ctx, targetId, m) : (m) => sendDmMsg(ctx, targetId, m);
            try {
                await sendMsg('🔍 Đang đồng bộ danh sách nhóm từ ZCA...');

                const withZaloApi = await getSafeZaloApi();
                if (!withZaloApi) throw new Error('Không thể khởi tạo ZCA API');

                const profile = ctx?.accountId || 'default';
                const { groupIds, infoMap } = await withZaloApi(profile, async (api) => {
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
                            infoMapMerged = await getGroupInfoInBatches(api, gids);
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
                        mergedNames[gId] = { name: zcaInfo.name || (typeof mergedNames[gId] === 'string' ? mergedNames[gId] : ''), admins: [], creatorId: '', profile };
                    } else {
                        mergedNames[gId].profile = mergeProfileStr(mergedNames[gId].profile, profile);
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
                if (!pluginCfg.botName || pluginCfg.botName === 'Bot') {
                    const detectedName = await _readBotNameFromIdentity(workspaceDir);
                    if (detectedName) await saveBotName('default', detectedName);
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
        async function handleOwnerDm(content, senderId, ctx, cmdPrefix, botName) {
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
                    renderRulesPanel(cmdPrefix)
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
                    await applyToggleSetting({ groupIds: watchGroupIds, key: 'muted', value: val });
                    await sendDmMsg(ctx, senderId, `${val ? '🔇' : '🔊'} Mute ${val ? 'BẬT' : 'TẮT'} cho TẤT CẢ ${watchGroupIds.length} groups`);
                } else {
                    await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules mute all on/off`);
                }
                return { handled: true };
            }

            // ── mute <groupId> on/off
            if (sub === 'mute' && args[1]) {
                const targetGid = args[1].replace(/^<|>$/g, ''); // strip <>
                const toggle = args[2]?.toLowerCase();
                if (toggle === 'on') {
                    await applyToggleSetting({ groupIds: [targetGid], key: 'muted', value: true });
                    await sendDmMsg(ctx, senderId, `🔇 Mute BẬT cho ${getGroupName(targetGid)} (${targetGid})\nBot sẽ im lặng hoàn toàn trong group này.`);
                } else if (toggle === 'off') {
                    await applyToggleSetting({ groupIds: [targetGid], key: 'muted', value: false });
                    await sendDmMsg(ctx, senderId, `🔊 Mute TẮT cho ${getGroupName(targetGid)} (${targetGid})\nBot hoạt động bình thường trở lại.`);
                } else {
                    await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules mute <groupId> on/off`);
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
                    await applyToggleSetting({ groupIds: watchGroupIds, key: 'silent', value: val });
                    await sendDmMsg(ctx, senderId, `${val ? '🔕' : '🔊'} Silent mode ${val ? 'BẬT' : 'TẮT'} cho TẤT CẢ ${watchGroupIds.length} groups`);
                } else {
                    await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules silent all on/off`);
                }
                return { handled: true };
            }

            // ── silent <groupId> on/off
            if (sub === 'silent' && args[1]) {
                const targetGid = args[1].replace(/^<|>$/g, '');
                const toggle = args[2]?.toLowerCase();
                if (toggle === 'on') {
                    await applyToggleSetting({ groupIds: [targetGid], key: 'silent', value: true });
                    await sendDmMsg(ctx, senderId, `🔕 Silent mode BẬT cho ${getGroupName(targetGid)} (${targetGid})`);
                } else if (toggle === 'off') {
                    await applyToggleSetting({ groupIds: [targetGid], key: 'silent', value: false });
                    await sendDmMsg(ctx, senderId, `🔊 Silent mode TẮT cho ${getGroupName(targetGid)} (${targetGid})`);
                } else {
                    await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules silent <groupId> on/off`);
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
                    await applyToggleSetting({ groupIds: watchGroupIds, key: 'welcome', value: val });
                    await sendDmMsg(ctx, senderId, `${val ? '🎉' : '🔕'} Welcome ${val ? 'BẬT' : 'TẮT'} cho TẤT CẢ ${watchGroupIds.length} groups`);
                } else {
                    await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules welcome all on/off`);
                }
                return { handled: true };
            }

            // ── welcome <groupId> on/off
            if (sub === 'welcome' && args[1]) {
                const targetGid = args[1].replace(/^<|>$/g, ''); // strip <>
                const toggle = args[2]?.toLowerCase();
                if (toggle === 'on') {
                    await applyToggleSetting({ groupIds: [targetGid], key: 'welcome', value: true });
                    await sendDmMsg(ctx, senderId, `✅ Welcome BẬT cho ${getGroupName(targetGid)} (${targetGid})`);
                } else if (toggle === 'off') {
                    await applyToggleSetting({ groupIds: [targetGid], key: 'welcome', value: false });
                    await sendDmMsg(ctx, senderId, `✅ Welcome TẮT cho ${getGroupName(targetGid)} (${targetGid})`);
                } else {
                    await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules welcome <groupId> on/off`);
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
                    await applyToggleSetting({ groupIds: watchGroupIds, key: 'follow', value: val });
                    await sendDmMsg(ctx, senderId, `${val ? '✅' : '❌'} Tracking ${val ? 'BẬT' : 'TẮT'} cho TẤT CẢ ${watchGroupIds.length} groups`);
                } else {
                    await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules tracking all on/off`);
                }
                return { handled: true };
            }

            // ── tracking <groupId> on/off
            if (sub === 'tracking' && args[1]) {
                const targetGid = args[1].replace(/^<|>$/g, '');
                const toggle = args[2]?.toLowerCase();
                if (toggle === 'on') {
                    await applyToggleSetting({ groupIds: [targetGid], key: 'follow', value: true });
                    await sendDmMsg(ctx, senderId, `✅ Follow BẬT cho ${getGroupName(targetGid)} (${targetGid})`);
                } else if (toggle === 'off') {
                    await applyToggleSetting({ groupIds: [targetGid], key: 'follow', value: false });
                    await sendDmMsg(ctx, senderId, `✅ Follow TẮT cho ${getGroupName(targetGid)} (${targetGid})`);
                } else {
                    await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules tracking <groupId> on/off`);
                }
                return { handled: true };
            }

            // ── dm-list: danh sách users được DM
            if (sub === 'dm-list') {
                if (allowedDmUsers.size === 0) {
                    await sendDmMsg(ctx, senderId, `💬 DM Whitelist: TRỐNG\n\nTất cả mọi người đều có thể DM bot.\nDùng ${cmdPrefix}rules dm-add <tên> để giới hạn.`);
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
                    // Lưu vào config.json (allowedDmUsers is not an openclaw.json key)
                    await savePluginConfig({ allowedDmUsers: [...allowedDmUsers] });
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
                    await savePluginConfig({ allowedDmUsers: [...allowedDmUsers] });
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
                    await applyToggleSetting({ groupIds: watchGroupIds, key: 'follow', value: val });
                    await sendDmMsg(ctx, senderId, `${val ? '👁️' : '🚫'} Follow ${val ? 'BẬT' : 'TẮT'} cho TẤT CẢ ${watchGroupIds.length} groups`);
                } else {
                    await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules follow all on/off`);
                }
                return { handled: true };
            }

            // ── follow <groupId> on/off
            if (sub === 'follow' && args[1]) {
                const targetGid = args[1].replace(/^<|>$/g, ''); // strip <>
                const toggle = args[2]?.toLowerCase();
                if (toggle === 'on') {
                    await applyToggleSetting({ groupIds: [targetGid], key: 'follow', value: true });
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
                    await applyToggleSetting({ groupIds: [targetGid], key: 'follow', value: false });
                    await sendDmMsg(ctx, senderId, `✅ Follow TẮT cho ${getGroupName(targetGid)} (${targetGid})`);
                } else {
                    await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules follow <groupId> on/off`);
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
                if (watchGroupIds.length === 0) lines.push(`⚠️ Chưa có group nào. Gõ ${cmdPrefix}rules groupid trong group để thêm.`);
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
                const prof = ctx?.accountId || 'default';
                const existingEntry = _rawGroupNames[targetGid];
                const newEntry = (existingEntry && typeof existingEntry === 'object')
                    ? { ...existingEntry, name: gName || existingEntry.name, profile: mergeProfileStr(existingEntry.profile, prof) }
                    : { name: gName, admins: [], creatorId: '', profile: prof };
                // Merge vào groupNames hiện tại
                const mergedNames = { ..._rawGroupNames, [targetGid]: newEntry };
                const isNew = !_rawGroupNames[targetGid];
                await saveGroupNames(mergedNames);
                if (isNew) {
                    if (!watchGroupIds.includes(targetGid)) watchGroupIds.push(targetGid);
                    groupNames[targetGid] = newEntry;
                }
                // Sync admins từ ZCA API (creatorId + adminIds)
                const zcaInfo = await syncGroupAdminsFromZCA(targetGid, ctx?.accountId || 'default');
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
                await sendDmMsg(ctx, senderId, `⚠️ Cú pháp: ${cmdPrefix}rules groupid-add <groupId>`);
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

        async function writePluginDataJson(name, data) {
            await safeWriteJson(path.join(dataDir, name), data);
        }

        async function appendDashboardAudit(entry) {
            const file = path.join(dataDir, 'dashboard-audit.json');
            const res = await safeReadJson(file);
            const list = Array.isArray(res) ? res : [];
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

        function buildCustomModesText(groupId, cmdPrefix) {
            const modes = getGroupCustomModes(groupId);
            if (!modes || modes.length === 0) return '';
            const lines = ['🧩 Chế độ (Custom Modes):'];
            for (const m of modes) {
                const descStr = m.description ? ` (${m.description})` : '';
                lines.push(`  ${cmdPrefix}bot-${m.slug}-on   — Bật ${m.label}${descStr}`);
                lines.push(`  ${cmdPrefix}bot-${m.slug}-off  — Tắt ${m.label}`);
            }
            return lines.join('\n');
        }

        const excludedDashboardGroups = new Set([
            // Không hardcode exclude — tất cả groups từ ZCA đều hiển thị
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

        // Cùng 1 nhóm vật lý có NHIỀU groupId (Zalo cấp ID per-account cho mỗi bot). Trả về mọi
        // groupId cùng "tên chuẩn hoá" để áp setting (silent/welcome/…) cho TẤT CẢ bot, không sót.
        function siblingGroupIds(groupId) {
            const gid = String(groupId);
            const self = groupNames[gid];
            const key = self ? groupDedupeKey(self.name) : '';
            if (!key) return [gid];
            const out = new Set([gid]);
            for (const [id, info] of Object.entries(groupNames)) {
                if (info && groupDedupeKey(info.name) === key) out.add(String(id));
            }
            return [...out];
        }

        // Map hai toggle lưu trong Zalo Mod sang 3 mode runtime của ZaloConnect.
        // muted ưu tiên cao nhất; khi tắt mute thì quay lại silent/free trước đó.
        function getZaloConnectRuntimeMode(groupId) {
            if (store.getSetting(groupId, 'muted', false)) return 'mute';
            if (store.getSetting(groupId, 'silent', true)) return 'silent';
            return 'free';
        }

        /**
         * Đồng bộ policy vào listener ZaloConnect (RAM-only, không ghi config,
         * không restart). Thất bại không làm mất setting đã lưu; startup replay
         * sẽ thử lại khi bridge load sau Zalo Mod.
         */
        async function syncZaloConnectRuntimePolicies(groupIds, { quiet = false } = {}) {
            const bridge = globalThis.__zaloModEngine?.bridge;
            const ids = [...new Set((groupIds || []).map(String).filter(Boolean))];
            if (!bridge?.setGroupPolicy) {
                return { applied: 0, failed: ids.length, unavailable: true };
            }
            let applied = 0;
            const errors = [];
            for (const groupId of ids) {
                const accountId = primaryProfile(groupNames[groupId]?.profile || 'default');
                const mode = getZaloConnectRuntimeMode(groupId);
                try {
                    await bridge.setGroupPolicy(accountId, groupId, mode);
                    applied++;
                } catch (e) {
                    errors.push({ groupId, accountId, error: e.message });
                }
            }
            if (errors.length && !quiet) {
                logger.warn(`[openclaw-zalo-mod] live group policy: ${applied}/${ids.length} applied; first error: ${errors[0].error}`);
            }
            return { applied, failed: errors.length, errors };
        }

        // ── Silent-mode name triggers (per bot/account) ─────────────────────────
        // Aliases that let a silent-mode bot answer when addressed by name (besides
        // @mention). Persisted here (settings.json), pushed live into the ZaloConnect
        // runtime via bridge — RAM-only there, no openclaw.json write, no restart.
        function dedupeAliases(list) {
            const seen = new Set();
            const out = [];
            for (const raw of Array.isArray(list) ? list : []) {
                const value = String(raw ?? '').trim();
                if (!value) continue;
                const key = value.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(value);
            }
            return out;
        }
        function readTriggerMap() {
            const map = store.getSetting('global', 'nameTriggersByAccount', {});
            return (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
        }
        function getStoredNameTriggers(accountId) {
            const id = primaryProfile(String(accountId || 'default')) || 'default';
            const value = readTriggerMap()[id];
            return Array.isArray(value) ? value : [];
        }
        async function persistNameTriggers(accountId, list) {
            const id = primaryProfile(String(accountId || 'default')) || 'default';
            const clean = dedupeAliases(list);
            const map = { ...readTriggerMap() };
            if (clean.length === 0) delete map[id]; else map[id] = clean;
            store.setSetting('global', 'nameTriggersByAccount', map);
            await store.saveSettings();
            return clean;
        }
        // Replay persisted aliases into the ZaloConnect runtime after (re)start.
        async function replayNameTriggers() {
            const bridge = globalThis.__zaloModEngine?.bridge;
            if (!bridge?.setNameTriggers) return { unavailable: true };
            const map = readTriggerMap();
            let applied = 0;
            for (const [accountId, list] of Object.entries(map)) {
                try { await bridge.setNameTriggers(accountId, Array.isArray(list) ? list : []); applied++; }
                catch (e) { logger.warn(`[openclaw-zalo-mod] name-trigger replay ${accountId}: ${e.message}`); }
            }
            return { applied, total: Object.keys(map).length };
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
        // Số member CHỜ DUYỆT — getGroupInfo trả `pendingApprove.uids` (KHÔNG phải field pendingCount).
        // Trả null khi info KHÔNG chứa tín hiệu pending tin cậy: getGroupInfo dạng batch
        // thường bỏ `pendingApprove` (Zalo chỉ trả cho admin / hay lược trong batch). Nếu ép
        // về 0 sẽ GHI ĐÈ số đúng đã lấy từ getPendingGroupMembers → UI lúc đúng lúc 0 sai.
        // Caller phải bỏ qua khi null để giữ giá trị đã biết trước đó.
        function extractPendingCount(info) {
            const u = info?.pendingApprove?.uids;
            if (Array.isArray(u)) return u.length;
            const n = Number(info?.pendingCount);
            if (Number.isFinite(n) && n >= 0) return n;
            return null; // không rõ — đừng ghi đè
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
            // Facade zalo-connect: lấy tên toàn bộ member trong 1 call (get-group-members-info theo groupId).
            const hasBulk = typeof zaloApi.getGroupMembers === 'function';
            if (hasBulk) {
                try {
                    const all = await zaloApi.getGroupMembers(groupId);
                    for (const m of all) {
                        const mid = String(m.userId || '').replace(/_0$/, '');
                        if (mid && m.displayName) names[mid] = m.displayName;
                    }
                } catch (_) { }
            }
            if (ids.length) {
                for (const batch of chunkArray(ids, 200)) {
                    if (!hasBulk) {
                        try {
                            const detail = await zaloApi.getGroupMembersInfo(batch);
                            Object.assign(names, collectProfileNames(detail, names));
                        } catch (_) { }
                    }
                    const missing = batch.filter(id => !names[id]);
                    if (missing.length) {
                        try {
                            const profiles = await zaloApi.getUserInfo(missing);
                            Object.assign(names, collectProfileNames(profiles, names));
                        } catch (_) { }
                    }
                }
            }
            const members = ids.map(id => ({ id, name: names[id] || _memberDir[groupId]?.[id] || id }));
            await reloadMemberDirIfChanged(); // tránh ghi đè removal của closure/kick khác
            if (updateMemberDir(groupId, members)) {
                await saveMemberDir();
            }
            // Số member THẬT = totalMember từ getGroupInfo (cộng đồng chỉ liệt kê được 1 phần danh sách,
            // nên members.length thấp hơn thực tế). Lấy max để không báo thiếu.
            const realTotal = extractGroupMemberCount(info, 0);
            const memberCount = Math.max(realTotal || 0, members.length);
            store.setSetting(groupId, 'memberCount', memberCount);
            await store.saveSettings();
            return { count: memberCount, listed: members.length, groupId, members };
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
                        } catch (_) { }
                        const missing = ids.filter(id => !names[id]);
                        if (missing.length) {
                            try {
                                const profiles = await zaloApi.getUserInfo(missing);
                                names = collectProfileNames(profiles, names);
                            } catch (_) { }
                        }
                    });
                }
            } catch (_) { }
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
            try {
                await refreshEntitlementIfNeeded(false);
            } catch (e) {
                logger.warn('[openclaw-zalo-mod] dashboard state entitlement refresh failed: ' + e.message);
            }
            const memberDir = await readPluginDataJson('group-members.json');
            const settingsRaw = store.getRawSettings();
            const warnedRaw = await readPluginDataJson('warned.json');
            const violationsRaw = await readPluginDataJson('violations.json');
            const auditRes = await safeReadJson(path.join(dataDir, 'dashboard-audit.json'));
            const audit = Array.isArray(auditRes) ? auditRes : [];

            const rawGroups = [];
            let settingsChanged = false;

            for (const [groupId, info] of Object.entries(groupNames)) {
                if (excludedDashboardGroups.has(String(groupId))) continue;
                const settings = settingsRaw[groupId] || {};
                const membersObj = memberDir[groupId] || {};
                const cachedMemberCount = Number(settings.memberCount || settings.totalMember || 0);
                const warnedCount = Object.values(warnedRaw[groupId] || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
                const violationCount = Object.values(violationsRaw[groupId] || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
                // Tổng thật (settings.memberCount = totalMember) ưu tiên; cộng đồng scan thiếu nên lấy max.
                const memberCount = Math.max(cachedMemberCount, Object.keys(membersObj).length);

                let creatorId = settings.creatorId || info?.creatorId || '';
                let admins = settings.groupAdmins || info?.admins || [];

                // Dynamic, robust sync: if creatorId is missing, pull it immediately from Zalo ZCA API
                if (!creatorId || admins.length === 0) {
                    try {
                        const zcaInfo = await fetchGroupAdminsFromZCA(groupId);
                        if (zcaInfo) {
                            creatorId = zcaInfo.creatorId || '';
                            admins = zcaInfo.adminIds || [];
                            if (!settingsRaw[groupId]) settingsRaw[groupId] = {};
                            settingsRaw[groupId].creatorId = creatorId;
                            settingsRaw[groupId].groupAdmins = admins;
                            settingsChanged = true;

                            if (groupNames[groupId]) {
                                groupNames[groupId].creatorId = creatorId;
                                groupNames[groupId].admins = admins;
                            }
                        }
                    } catch (e) {
                        logger.warn(`[openclaw-zalo-mod] Dynamic admin sync failed for group ${groupId}: ${e.message}`);
                    }
                }

                rawGroups.push({
                    groupId,
                    name: info?.name || settings.name || `Group ${groupId.slice(-6)}`,
                    admins,
                    creatorId,
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
                        tracking: (settings.follow === true || settings.tracking === true),
                        follow: (settings.follow === true || settings.tracking === true),
                        pendingAuto: !!settings.pendingAuto,
                        autoSummary: settings.autoSummary === true,
                        reportTime: settings.reportTime || '23:55',
                        reportDeliverThisGroup: settings.reportDeliverThisGroup !== false,
                        reportDeliverOwnerDm: settings.reportDeliverOwnerDm === true,
                    },
                    customModes: getGroupCustomModes(groupId),
                    profile: info?.profile || 'default',
                });
            }

            if (settingsChanged) {
                await store.saveSettings();
            }

            const byName = new Map();
            // Per-bot state: a physical group has a different groupId per bot, and feature
            // settings are stored per groupId (so they are inherently per-bot). We keep ONE
            // display row per physical group but carry each bot's settings + groupId so the
            // dashboard can read/toggle the SELECTED bot only (no cross-bot leak).
            const seed = (g) => ({
                ...g,
                siblingIds: [g.groupId],
                settingsByProfile: { [primaryProfile(g.profile)]: g.settings },
                groupIdByProfile: { [primaryProfile(g.profile)]: g.groupId },
            });
            for (const group of rawGroups) {
                const key = groupDedupeKey(group.name);
                if (!key) {
                    byName.set(`id:${group.groupId}`, seed(group));
                    continue;
                }
                const existing = byName.get(key);
                if (!existing) {
                    byName.set(key, seed(group));
                    continue;
                }
                // Cùng tên = cùng nhóm vật lý (Zalo cấp ID per-account khác nhau cho mỗi bot).
                // HỢP profile của tất cả bản trùng để badge hiện đủ bot; giữ entry chất lượng cao làm đại diện.
                const prof = primaryProfile(group.profile);
                const unionProfiles = [...new Set([...parseProfiles(existing.profile), ...parseProfiles(group.profile)])].join(',');
                const siblingIds = [...new Set([...(existing.siblingIds || [existing.groupId]), group.groupId])];
                const winner = groupQualityScore(group) > groupQualityScore(existing) ? { ...group } : { ...existing };
                winner.profile = unionProfiles;
                winner.siblingIds = siblingIds;
                winner.settingsByProfile = { ...(existing.settingsByProfile || {}), [prof]: group.settings };
                winner.groupIdByProfile = { ...(existing.groupIdByProfile || {}), [prof]: group.groupId };
                byName.set(key, winner);
            }
            const groups = [...byName.values()];

            // Read version from package.json dynamically
            let currentVersion = '2.8.7';
            try {
                const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
                if (pkg.version) currentVersion = pkg.version;
            } catch (_) { }

            let ownId = _detectedBotId || null;
            try {
                const withZaloApi = await getSafeZaloApi();
                if (withZaloApi) {
                    const apiOwnId = await withZaloApi('default', async (zaloApi) => {
                        if (typeof zaloApi.getOwnId === 'function') {
                            const id = await zaloApi.getOwnId().catch(() => null);
                            if (id) return id;
                        }
                        if (typeof zaloApi.fetchAccountInfo === 'function') {
                            const acc = await zaloApi.fetchAccountInfo().catch(() => null);
                            if (acc?.userId || acc?.uid) return String(acc.userId || acc.uid);
                        }
                        return null;
                    });
                    if (apiOwnId) ownId = apiOwnId;
                }
            } catch (_) { }

            let ownerDisplayName = null;
            let ownerAvatarUrl = null;
            try {
                if (ownerId) {
                    for (const members of Object.values(memberDir)) {
                        if (members?.[ownerId]) {
                            const mData = members[ownerId];
                            ownerDisplayName = typeof mData === 'string' ? mData : mData.name || mData.displayName;
                            break;
                        }
                    }
                    if (!ownerDisplayName) {
                        const withZaloApi = await getSafeZaloApi();
                        if (withZaloApi) {
                            const profile = await withZaloApi('default', async (zaloApi) => {
                                return await zaloApi.getUserInfo(ownerId).catch(() => null);
                            });
                            if (profile) {
                                ownerDisplayName = profile.displayName || profile.name;
                                ownerAvatarUrl = profile.avatar || profile.avatarUrl;
                            }
                        }
                    }
                }
            } catch (e) {
                logger.error('[openclaw-zalo-mod] Error fetching owner profile: ' + e.message);
            }

            // Background member profiles caching and synchronization logic
            const cacheRaw = await readPluginDataJson('zalo-profiles-cache.json');
            const cache = cacheRaw && typeof cacheRaw === 'object' && !Array.isArray(cacheRaw) ? cacheRaw : {};

            let syncQueueAdded = false;
            for (const [gId, membersObj] of Object.entries(memberDir)) {
                if (excludedDashboardGroups.has(String(gId))) continue;
                if (membersObj && typeof membersObj === 'object') {
                    for (const userId of Object.keys(membersObj)) {
                        const cleanId = String(userId).replace(/_0$/, '');
                        if (!cache[cleanId] || !cache[cleanId].displayName) {
                            profileSyncQueue.add(cleanId);
                            syncQueueAdded = true;
                        }
                    }
                }
            }

            if (syncQueueAdded && typeof startProfileSyncJob === 'function') {
                startProfileSyncJob();
            }

            const bots = await getZaloBots();
            const templates = {};
            for (const d of TEMPLATE_DEFS) {
                templates[d.key] = await loadTemplateContent(dataDir, d.key);
            }
            const templateMeta = TEMPLATE_DEFS.map(d => ({ key: d.key, label: d.label, kind: d.kind, defCmd: d.defCmd }));
            const templateCommands = templateCommandsFrom(pluginCfg);
            return {
                ok: true,
                pluginVersion: currentVersion,
                license: getLicenseStatus(),
                bots,
                templateMeta,
                templateCommands,
                bot: {
                    name: botName,
                    cmdPrefix,
                    ownerId,
                    botUserId: ownId,
                    ownerName: ownerDisplayName || ownerId || 'Owner',
                    ownerAvatar: ownerAvatarUrl || '',
                    groups: groups.length,
                    dashboardPort: Number(pluginCfg.dashboardPort || 19790),
                    cachedProfiles: cache, // Send profile database directly to client!
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
                templates,
            };
        }

        const LICENSE_SERVER_URL = 'https://zalo-mod-server.monkeytech.io.vn';

        function getDeviceFingerprint() {
            return { installId: getDeviceId() };
        }

        async function licenseServerFetch(pathname, options = {}) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), Number(pluginCfg.licenseServerTimeoutMs || 10000));
            try {
                const res = await fetch(`${LICENSE_SERVER_URL}${pathname}`, {
                    ...options,
                    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
                    signal: controller.signal,
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
                return data;
            } finally {
                clearTimeout(timeoutId);
            }
        }

        function decodeEntitlementPayload(proof) {
            try {
                const encoded = String(proof || '').split('.')[0];
                if (!encoded) return null;
                return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
            } catch (_) { return null; }
        }

        let trialRequest = null;
        async function ensureTrialIfFirstInstall() {
            const existing = store.getSetting('global', 'license') || {};
            if (existing.entitlement || existing.key || existing.orderId || existing.trialUnavailable) return false;
            if (trialRequest) return trialRequest;
            trialRequest = (async () => {
                try {
                    const deviceId = getDeviceId();
                    const result = await licenseServerFetch('/v1/trials', {
                        method: 'POST',
                        body: JSON.stringify({ deviceId, fingerprint: getDeviceFingerprint() }),
                    });
                    const verified = verifySignedEntitlement(result.entitlement, MKT_PUBLIC_KEY, deviceId);
                    if (!verified.valid) throw new Error('license server returned an invalid trial proof');
                    const payload = verified.payload;
                    store.setSetting('global', 'license', {
                        valid: true,
                        plan: payload.plan || 'personal',
                        expiry: payload.licenseExpiry || null,
                        deviceId,
                        orderId: payload.orderId || payload.sub || '',
                        entitlement: result.entitlement,
                        entitlementPayload: payload,
                        entitlementExp: payload.exp || null,
                        isTrial: true,
                    });
                    await store.saveSettings();
                    logger.info(`[openclaw-zalo-mod] activated 30-day Pro trial for Device ID ${deviceId}`);
                    return true;
                } catch (error) {
                    // Network failures are intentionally not persisted, so a later
                    // startup/dashboard request can retry. Server-side anti-abuse
                    // remains authoritative for duplicate trial claims.
                    logger.warn('[openclaw-zalo-mod] automatic Pro trial unavailable: ' + error.message);
                    return false;
                } finally {
                    trialRequest = null;
                }
            })();
            return trialRequest;
        }

        async function activateEntitlement({ orderId, licenseKey }) {
            const deviceId = getDeviceId();
            const result = await licenseServerFetch('/v1/activations', {
                method: 'POST',
                body: JSON.stringify({ orderId, licenseKey, deviceId, fingerprint: getDeviceFingerprint() }),
            });
            const payload = result.payload || decodeEntitlementPayload(result.entitlement);
            const verified = verifySignedEntitlement(result.entitlement, MKT_PUBLIC_KEY, deviceId);
            if (!verified.valid) throw new Error('license server returned an invalid entitlement proof');
            if (payload) {
                store.setSetting('global', 'license', {
                    valid: true,
                    plan: payload.plan || result.license?.plan || 'personal',
                    expiry: result.license?.expiry || payload.licenseExpiry,
                    deviceId,
                    key: result.license?.key || licenseKey || '',
                    orderId: payload.orderId || orderId || '',
                    entitlement: result.entitlement,
                    entitlementPayload: payload,
                    entitlementExp: payload.exp || null,
                });
                await store.saveSettings();
            }
            return { valid: true, ...result, plan: payload?.plan, expiry: result.license?.expiry || payload?.licenseExpiry, deviceId };
        }

        async function refreshEntitlementIfNeeded(force = false) {
            const license = store.getSetting('global', 'license') || {};
            const payload = license.entitlementPayload || decodeEntitlementPayload(license.entitlement);
            if (!license.orderId || !license.valid) return false;
            const now = Math.floor(Date.now() / 1000);
            if (!force && payload?.exp && payload.exp - now > 3600) return true;
            try {
                const refreshed = await licenseServerFetch('/v1/entitlements/refresh', {
                    method: 'POST',
                    body: JSON.stringify({ orderId: license.orderId, deviceId: license.deviceId || getDeviceId() }),
                });
                const nextPayload = refreshed.payload || decodeEntitlementPayload(refreshed.entitlement);
                const verified = verifySignedEntitlement(refreshed.entitlement, MKT_PUBLIC_KEY, license.deviceId || getDeviceId());
                if (!verified.valid) throw new Error('license server returned an invalid refreshed proof');
                store.setSetting('global', 'license', {
                    ...license,
                    valid: true,
                    plan: nextPayload?.plan || refreshed.license?.plan || license.plan || 'personal',
                    expiry: refreshed.license?.expiry || nextPayload?.licenseExpiry || license.expiry,
                    entitlement: refreshed.entitlement,
                    entitlementPayload: nextPayload,
                    entitlementExp: nextPayload?.exp || null,
                });
                await store.saveSettings();
                return true;
            } catch (e) {
                logger.warn('[openclaw-zalo-mod] entitlement refresh failed: ' + e.message);
                return false;
            }
        }

        async function cancelCurrentPayment(orderId) {
            if (!orderId) return false;
            try {
                await licenseServerFetch(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
                return true;
            } catch (e) {
                logger.warn('[openclaw-zalo-mod] cancel payment failed: ' + e.message);
                return false;
            }
        }

        async function runDashboardZcaAction(action, payload) {
            const withZaloApi = await getSafeZaloApi();
            if (!withZaloApi) throw new Error('ZCA API unavailable. Check Zalo Connect login and zca-js install.');

            const groupId = String(payload.groupId || '').trim();
            const userId = String(payload.userId || '').trim();
            const members = normalizeMembersInput(payload.members || payload.userIds || userId);

            // Determine the profile — group nhiều bot lưu CSV "default,mkt", phải lấy
            // primary (bot đầu) làm profile hợp lệ để gọi withZaloApi, không dùng nguyên chuỗi.
            let targetProfile = 'default';
            if (payload.profile) {
                targetProfile = payload.profile;
            } else if (groupId && groupNames[groupId]?.profile) {
                targetProfile = primaryProfile(groupNames[groupId].profile);
            }

            if (action === 'sync-groups') {
                const bots = await getZaloBots();
                const profilesToSync = payload.profile ? [payload.profile] : (bots.length ? bots.map(b => b.profile) : ['default']);

                let merged = { ..._rawGroupNames }; // start with existing in-memory group names
                const successfulProfiles = [];
                const failedProfiles = [];

                for (const prof of profilesToSync) {
                    try {
                        await withZaloApi(prof, async (zaloApi) => {
                            const allGroups = await zaloApi.getAllGroups();
                            const idsFromVer = Object.keys(allGroups?.gridVerMap || {});
                            const idsFromInfo = Object.keys(allGroups?.gridInfoMap || {});
                            const ids = [...new Set([...idsFromVer, ...idsFromInfo])];

                            const infoMap = await getGroupInfoInBatches(zaloApi, ids);

                            // Gỡ profile hiện tại khỏi list của các group cũ (dọn stale).
                            // Group còn bot khác → giữ lại và chỉ bỏ profile này;
                            // không còn bot nào → mới xóa hẳn group.
                            for (const [gId, gInfo] of Object.entries(merged)) {
                                if (!gInfo) continue;
                                const profs = parseProfiles(gInfo.profile);
                                if (profs.includes(prof) || (profs.length === 0 && prof === 'default')) {
                                    const remaining = profs.filter(p => p !== prof);
                                    if (remaining.length === 0) {
                                        delete merged[gId];
                                    } else {
                                        gInfo.profile = remaining.join(',');
                                    }
                                }
                            }

                            for (const gId of ids) {
                                if (excludedDashboardGroups.has(String(gId))) continue;
                                const z = infoMap[gId];
                                // CHỈ gắn bot vào group nếu getGroupInfo trả info thật (bot THẬT SỰ là thành viên).
                                // getAllGroups() có thể trả ID "ma" (group đã rời / khác account) → z rỗng → bỏ qua,
                                // tránh gắn nhầm badge bot vào nhóm nó không ở trong.
                                if (!z || !z.name) continue;
                                const existing = merged[gId];

                                merged[gId] = {
                                    name: z.name || existing?.name || groupNames[gId]?.name || `Group ${gId.slice(-6)}`,
                                    admins: Array.isArray(z.adminIds) ? z.adminIds.map(String) : (existing?.admins || groupNames[gId]?.admins || []),
                                    creatorId: z.creatorId ? String(z.creatorId) : (existing?.creatorId || groupNames[gId]?.creatorId || ''),
                                    inviteLink: z.inviteLink || z.link || z.groupLink || z.url || existing?.inviteLink || groupNames[gId]?.inviteLink || '',
                                    // Gộp bot hiện tại vào list profile sẵn có thay vì ghi đè
                                    profile: mergeProfileStr(existing?.profile, prof),
                                };

                                groupNames[gId] = merged[gId];
                                if (!watchGroupIds.includes(gId)) watchGroupIds.push(gId);

                                if (merged[gId].admins?.length) store.setSetting(gId, 'groupAdmins', merged[gId].admins);
                                if (merged[gId].creatorId) store.setSetting(gId, 'creatorId', merged[gId].creatorId);
                                if (merged[gId].inviteLink) store.setSetting(gId, 'inviteLink', merged[gId].inviteLink);

                                store.setSetting(gId, 'memberCount', extractGroupMemberCount(z, store.getSetting(gId, 'memberCount', 0)));
                                const _pc = extractPendingCount(z);
                                if (_pc != null) store.setSetting(gId, 'pendingCount', _pc);

                                // Deprecated: Sequential getGroupInfo calls for groups with 0 members are too slow and cause timeouts.
                                // Info is already populated by getGroupInfoInBatches.
                                /*
                                if (!store.getSetting(gId, 'memberCount', 0)) {
                                  try {
                                    const fresh = await zaloApi.getGroupInfo(gId);
                                    const freshInfo = fresh?.gridInfoMap?.[gId];
                                    if (freshInfo) {
                                      const count = extractGroupMemberCount(freshInfo, 0);
                                      if (count) store.setSetting(gId, 'memberCount', count);
                                      if (freshInfo.creatorId) store.setSetting(gId, 'creatorId', String(freshInfo.creatorId));
                                      if (Array.isArray(freshInfo.adminIds) && freshInfo.adminIds.length) {
                                        store.setSetting(gId, 'groupAdmins', freshInfo.adminIds.map(String));
                                      }
                                    }
                                  } catch (_) {}
                                }
                                */
                            }

                            // Deprecated: Sequential getPendingGroupMembers calls are too slow for bots with many groups (>1000) and cause timeouts.
                            // pendingCount is already returned by getGroupInfo and synced above.
                            /*
                            const topIds = ids.slice(0, 30);
                            for (const gId of topIds) {
                              try {
                                const pending = await zaloApi.getPendingGroupMembers(gId);
                                const list = pendingListFromResult(pending);
                                store.setSetting(gId, 'pendingCount', list.length);
                              } catch (_) {}
                            }
                            */

                            successfulProfiles.push(prof);
                        });
                    } catch (err) {
                        failedProfiles.push(prof);
                        logger.warn(`[openclaw-zalo-mod] Sync groups failed for profile ${prof}: ${err.message} — group của bot này KHÔNG được cập nhật lần sync này`);
                    }
                }

                if (successfulProfiles.length > 0) {
                    await saveGroupNames(merged);
                    await store.saveSettings();
                } else {
                    throw new Error('Đồng bộ nhóm thất bại trên tất cả profile. Vui lòng kiểm tra kết nối Zalo.');
                }

                // Sync bot name for default profile if missing/default
                if (successfulProfiles.includes('default')) {
                    const currentBotName = String(pluginCfg.botName || '').trim();
                    const isDefaultBotName = !currentBotName ||
                        ['bot', 'botname', 'openclaw bot', 'openclaw-bot'].includes(currentBotName.toLowerCase()) ||
                        currentBotName.includes('**Mkt**');

                    if (isDefaultBotName) {
                        let detectedName = null;
                        try {
                            await withZaloApi('default', async (zaloApi) => {
                                if (typeof zaloApi.fetchAccountInfo === 'function') {
                                    const acc = await zaloApi.fetchAccountInfo();
                                    const profileObj = acc?.profile || acc;
                                    if (profileObj && profileObj.displayName) {
                                        detectedName = profileObj.displayName;
                                    }
                                }
                            });
                        } catch (err) {
                            logger.warn('[openclaw-zalo-mod] failed to fetch Zalo profile name via API: ' + err.message);
                        }

                        if (detectedName) {
                            await saveBotName('default', detectedName);
                            logger.info('[openclaw-zalo-mod] Synced bot name via Zalo API: "' + detectedName + '"');
                        }
                    }
                }

                // Sync tên hiển thị RIÊNG cho từng bot non-default (để @mention đúng tên thật,
                // tránh kế thừa nhầm tên của bot default). Chỉ ghi khi tên đang trống/generic/bị copy từ default.
                for (const prof of successfulProfiles) {
                    if (prof === 'default') continue;
                    try {
                        const cur = (pluginCfg.bots && pluginCfg.bots[prof]) || {};
                        const curName = String(cur.botName || '').trim();
                        const defName = String(pluginCfg.botName || '').trim();
                        const looksAuto = !curName ||
                            ['bot', 'botname', 'openclaw bot', 'openclaw-bot'].includes(curName.toLowerCase()) ||
                            (defName && curName.toLowerCase() === defName.toLowerCase()); // bị copy từ default
                        if (!looksAuto) continue; // Kent đã đặt tên riêng → tôn trọng, không đụng
                        let detected = null;
                        await withZaloApi(prof, async (zaloApi) => {
                            if (typeof zaloApi.fetchAccountInfo === 'function') {
                                const acc = await zaloApi.fetchAccountInfo();
                                const po = acc?.profile || acc;
                                if (po && po.displayName) detected = po.displayName;
                            }
                        });
                        if (detected && detected !== curName) {
                            const bots = { ...(pluginCfg.bots || {}) };
                            bots[prof] = { ...cur, botName: detected, zaloDisplayNames: [detected] };
                            await savePluginConfig({ bots });
                            pluginCfg.bots = bots;
                            logger.info(`[openclaw-zalo-mod] Synced bot name cho profile ${prof}: "${detected}"`);
                        }
                    } catch (err) {
                        logger.warn(`[openclaw-zalo-mod] fetch tên cho profile ${prof} lỗi: ${err.message}`);
                    }
                }

                // Reset in-memory groupNames và watchGroupIds — chỉ giữ groups từ ZCA của các profile đã sync thành công
                for (const oldId of Object.keys(groupNames)) {
                    const gInfo = groupNames[oldId];
                    const gProfiles = parseProfiles(gInfo?.profile);
                    if (gProfiles.some(p => successfulProfiles.includes(p)) && !merged[oldId]) {
                        delete groupNames[oldId];
                    }
                }
                watchGroupIds.length = 0;
                for (const [gId, entry] of Object.entries(merged)) {
                    groupNames[gId] = entry;
                    watchGroupIds.push(gId);
                }

                return {
                    imported: Object.keys(merged).filter(k => parseProfiles(merged[k].profile).some(p => successfulProfiles.includes(p))).length,
                    synced: successfulProfiles,
                    failed: failedProfiles,
                };
            }

            return await withZaloApi(targetProfile, async (zaloApi) => {
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
                // zca-js: removeUserFromGroup(memberId, groupId) — memberId TRƯỚC, groupId SAU (trước đây gọi ngược → "Nhóm không có thành viên").
                if (action === 'remove-user') {
                    try {
                        const res = await zaloApi.removeUserFromGroup(members.length > 1 ? members : members[0], groupId);
                        await removeMembersFromDir(groupId, members); // dọn khỏi group-members.json để reload không hiện member đã kick
                        return res;
                    } catch (e) {
                        // Member đã rời/không còn trong nhóm (code 165 / "Nhóm không có thành viên") → coi như xong, vẫn dọn khỏi list.
                        const msg = String(e?.message || '').toLowerCase();
                        if (/không có thành viên|not in|165|đã rời|not a member|no member/.test(msg)) {
                            await removeMembersFromDir(groupId, members);
                            return { ok: true, alreadyRemoved: true };
                        }
                        throw e;
                    }
                }
                if (action === 'block-member') {
                    const res = await zaloApi.addGroupBlockedMember(members.length > 1 ? members : members[0], groupId);
                    await removeMembersFromDir(groupId, members); // bị chặn = rời nhóm → cũng dọn
                    return res;
                }
                if (action === 'unblock-member') return await zaloApi.removeGroupBlockedMember(members.length > 1 ? members : members[0], groupId);
                if (action === 'accept-friend') return await zaloApi.acceptFriendRequest(userId);
                if (action === 'reject-friend') return await zaloApi.rejectFriendRequest(userId);
                if (action === 'send-friend-request') {
                    const friendMessage = String(payload.message || '').trim();
                    try {
                        return await zaloApi.sendFriendRequest(friendMessage, userId);
                    } catch (error) {
                        const errMsg = String(error?.message || error || '');
                        if (friendMessage && /(tham s? kh?ng h?p l?|invalid parameter|parameter is invalid|bad request)/i.test(errMsg)) {
                            return await zaloApi.sendFriendRequest('', userId);
                        }
                        throw error;
                    }
                }
                if (action === 'get-friends') {
                    const fr = await zaloApi.getAllFriends();
                    try { for (const f of extractFriendList(fr)) _friendIdCache.add(f.id); } catch (_) { }
                    return fr;
                }
                if (action === 'get-user-info') {
                    const target = payload.userIds || payload.userId || userId;
                    return await zaloApi.getUserInfo(target);
                }

                throw new Error(`Unsupported ZCA action: ${action}`);
            });
        }

        async function runDashboardAction(action, payload = {}) {
            await ensureStore();
            await ensureTrialIfFirstInstall();
            await refreshEntitlementIfNeeded(false);
            const license = getLicenseStatus();
            const botCount = (await getZaloBots().catch(() => [])).length;
            assertActionAllowed(action, payload, license, { botCount });

            // ── Nhật ký nhóm (Phase 3) ──
            if (action === 'journal-data') {
                const groupId = String(payload.groupId || '').trim();
                if (!groupId) throw new Error('groupId is required');
                const summaryDates = await listSummaryDates(groupId);
                const chatDates = await listChatHistoryDates(groupId);
                const date = String(payload.date || summaryDates[0] || chatDates[0] || vnDateStr());
                const chatAll = await readChatHistory(groupId, date);
                return {
                    groupId, date, summaryDates, chatDates,
                    summary: await getSummary(groupId, date),
                    chat: chatAll.slice(-300),
                    chatTotal: chatAll.length,
                    notes: await getNotes(groupId),
                    memories: await getGroupMemories(groupId),
                    autoSummary: store.getSetting(groupId, 'autoSummary', false),
                    reportTime: store.getSetting(groupId, 'reportTime', '23:55'),
                    reportDeliverThisGroup: store.getSetting(groupId, 'reportDeliverThisGroup', true),
                    reportDeliverOwnerDm: store.getSetting(groupId, 'reportDeliverOwnerDm', false),
                };
            }
            if (action === 'generate-summary') {
                const groupId = String(payload.groupId || '').trim();
                if (!groupId) throw new Error('groupId is required');
                const date = String(payload.date || vnDateStr());
                return { summary: await generateDailySummary(groupId, date, { by: 'dashboard' }) };
            }
            // ── Passthrough zalo-connect ────────────────────────────────────────────────────────
            // zalo-connect phơi ~141 action (zca-js) còn zalo-mod chỉ bọc lại vài chục, nên owner nhờ
            // bot "đổi tên nhóm" thì bot trả lời không làm được — đúng, vì nó không có tay. Bridge đã
            // có executeAction, nên mở MỘT cửa có kiểm soát thay vì bọc tay từng action.
            //
            // Ba lớp gác, không lớp nào bỏ được:
            //   1. classifyConnectAction — DENY-BY-DEFAULT. Action lạ (kể cả API mới của zalo-connect
            //      bản sau) không lọt; action không hoàn tác cần agentTools.allowDestructive.
            //   2. assertActionAllowed ở đầu runDashboardAction — luật gói, đã soi vào payload.params
            //      nên "gửi 30 nhóm" qua cửa này vẫn tính là hàng loạt → PRO.
            //   3. Audit log — mọi lời gọi đều ghi lại, giống nút dashboard.
            if (action === 'zalo-api') {
                const target = String(payload.action || '').trim();
                const allowDestructive = pluginCfg?.agentTools?.allowDestructive === true;
                if (target === 'list-actions' || !target) {
                    return { ok: true, ...listConnectActions({ allowDestructive }) };
                }
                const verdict = classifyConnectAction(target, { allowDestructive });
                if (!verdict.allowed) throw new Error(verdict.reason);
                const params = (payload.params && typeof payload.params === 'object') ? payload.params : {};
                const profile = primaryProfile(payload.profile || groupNames[params.threadId]?.profile);
                await appendDashboardAudit({ action: 'zalo-api', target, kind: verdict.kind, params: Object.keys(params) });
                const result = await zEngine.bridge.execute(profile, { action: target, ...params });
                return { ok: result?.ok !== false, action: target, kind: verdict.kind, result };
            }

            // ── Lịch báo cáo ──
            if (action === 'report-jobs') {
                const jobs = await ensureReportJobsMigrated();
                // Kèm danh sách nhóm đang follow để UI dựng bộ chọn mà không phải gọi thêm action.
                const followed = watchGroupIds.filter(gid => isFollowOn(gid))
                    .map(gid => ({ groupId: gid, name: getGroupName(gid) }))
                    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
                return {
                    jobs: jobs.map(j => ({ ...j, resolvedCount: resolveJobGroups(j).length })),
                    groups: followed,
                    state: (await readPluginDataJson('report-state.json')).byJob || {},
                };
            }
            if (action === 'report-job-save') {
                const job = normalizeReportJob(payload.job);
                if (!job) throw new Error('job is required');
                if (job.groups !== '*' && job.groups.length === 0) throw new Error('Chọn ít nhất một nhóm cho lịch này');
                if (!job.deliver.ownerDm && !job.deliver.eachGroup && job.deliver.groups.length === 0) {
                    throw new Error('Chọn ít nhất một nơi nhận báo cáo');
                }
                const jobs = await ensureReportJobsMigrated();
                const i = jobs.findIndex(j => j.id === job.id);
                if (i >= 0) jobs[i] = job; else jobs.push(job);
                await writeReportJobs(jobs);
                await appendDashboardAudit({ action: 'report-job-save', jobId: job.id, name: job.name });
                return { ok: true, job };
            }
            if (action === 'report-job-delete') {
                const id = String(payload.id || '').trim();
                const jobs = (await ensureReportJobsMigrated()).filter(j => j.id !== id);
                await writeReportJobs(jobs);
                await appendDashboardAudit({ action: 'report-job-delete', jobId: id });
                return { ok: true };
            }
            if (action === 'report-job-run') {
                const id = String(payload.id || '').trim();
                const job = (await ensureReportJobsMigrated()).find(j => j.id === id);
                if (!job) throw new Error('Không tìm thấy lịch này');
                const date = String(payload.date || vnDateStr());
                const r = await runReportJob(job, date);
                await appendDashboardAudit({ action: 'report-job-run', jobId: id, sent: r.sent });
                return { ok: true, ...r, date };
            }
            if (action === 'report-digest-preview') {
                // Xem trước ĐÚNG chuỗi sẽ gửi, kể cả cách cắt phần — để owner biết trước có bị tách không.
                const ids = payload.groups === '*'
                    ? watchGroupIds.filter(gid => isFollowOn(gid))
                    : (Array.isArray(payload.groups) ? payload.groups.map(String) : []);
                const date = String(payload.date || vnDateStr());
                const texts = await buildDigestMessages(ids, date);
                return { date, parts: texts.length, texts, chars: texts.reduce((n, t) => n + t.length, 0) };
            }
            if (action === 'get-permissions') {
                const perms = livePermissions();
                const memberDir = await readPluginDataJson('group-members.json');
                const profCache = await readPluginDataJson('zalo-profiles-cache.json');
                const ownerIds = new Set([String(ownerId || '')].filter(Boolean));
                for (const b of Object.values(pluginCfg.bots || {})) if (b?.ownerId) ownerIds.add(String(b.ownerId));
                const avatarOf = (id) => (profCache[id] && profCache[id].avatar) || '';
                const roleOf = (id) => ownerIds.has(String(id)) ? 'owner' : 'member';
                const memberMap = {};
                for (const users of Object.values(memberDir)) for (const [id, name] of Object.entries(users)) memberMap[id] = name;
                const members = Object.entries(memberMap).map(([id, name]) => ({ id, name, avatar: avatarOf(id), role: roleOf(id) })).slice(0, 800);
                // Permissions are per-bot: when a specific bot (profile) is requested,
                // return ONLY that bot's groups. This avoids the same physical group
                // showing twice (each bot has its own per-account groupId). The dashboard
                // requires a specific bot on this page, so `profile` is normally set.
                const permProfile = payload.profile ? String(payload.profile) : '';
                const groups = watchGroupIds
                    .filter(g => !permProfile || parseProfiles(groupNames[g]?.profile).includes(permProfile))
                    .map(g => ({ groupId: g, name: getGroupName(g) }));
                let friends = [];
                try { friends = extractFriendList(await runDashboardZcaAction('get-friends', {})).map(f => ({ ...f, avatar: avatarOf(f.id), role: roleOf(f.id) })); } catch (_) { }
                return {
                    permissions: {
                        dm: { mode: perms.dm?.mode || (allowedDmUsers.size ? 'list' : 'all'), allowList: perms.dm?.allowList || [...allowedDmUsers] },
                        group: { mode: perms.group?.mode || 'all', allowList: perms.group?.allowList || [] },
                        note: { scope: perms.note?.scope || 'admin', allowList: perms.note?.allowList || [] },
                        memory: { scope: perms.memory?.scope || 'admin', allowList: perms.memory?.allowList || [] },
                    },
                    friends, members, groups,
                };
            }
            if (action === 'save-permissions') {
                const p = payload.permissions || {};
                // Resolve TÊN cho từng id (để khớp cross-bot khi id per-account khác nhau)
                const _md = await readPluginDataJson('group-members.json');
                const _pc = await readPluginDataJson('zalo-profiles-cache.json');
                const nameOf = (id) => {
                    if (_pc[id]?.displayName) return _pc[id].displayName;
                    for (const us of Object.values(_md)) if (us[id]) return us[id];
                    return '';
                };
                const namesFor = (ids) => [...new Set((ids || []).map(nameOf).filter(Boolean))];
                const dmList = (p.dm?.allowList || []).map(String);
                const noteList = (p.note?.allowList || []).map(String);
                const memList = (p.memory?.allowList || []).map(String);
                const clean = {
                    dm: { mode: ['all', 'friends', 'list', 'owner', 'none'].includes(p.dm?.mode) ? p.dm.mode : 'all', allowList: dmList, allowNames: namesFor(dmList) },
                    group: { mode: ['all', 'list', 'none'].includes(p.group?.mode) ? p.group.mode : 'all', allowList: (p.group?.allowList || []).map(String) },
                    note: { scope: ['owner', 'admin', 'list', 'all'].includes(p.note?.scope) ? p.note.scope : 'admin', allowList: noteList, allowNames: namesFor(noteList) },
                    memory: { scope: ['owner', 'admin', 'list', 'all'].includes(p.memory?.scope) ? p.memory.scope : 'admin', allowList: memList, allowNames: namesFor(memList) },
                };
                await savePluginConfig({ permissions: clean });
                pluginCfg.permissions = clean;
                globalThis.__zaloModPermissions = clean; // chia sẻ tới mọi closure (đa-register) ngay lập tức
                // Đồng bộ allowedDmUsers (backward-compat với cổng cũ)
                if (clean.dm.mode === 'list' || clean.dm.mode === 'friends') {
                    allowedDmUsers.clear();
                    clean.dm.allowList.forEach(id => allowedDmUsers.add(String(id)));
                }
                return { permissions: clean };
            }
            if (action === 'save-report-schedule') {
                // ⚠️ LEGACY. Lịch báo cáo giờ là thực thể riêng (report-jobs.json) vì một lịch trải trên
                // nhiều nhóm. Action này chỉ còn ghi 4 setting per-group mà scheduler KHÔNG đọc nữa —
                // giữ lại để dashboard/script cũ không lỗi, và để ensureReportJobsMigrated() còn nguồn
                // chuyển đổi cho máy chưa migrate. Cấu hình mới phải đi qua report-job-save.
                // Cấu hình lịch báo cáo THEO NHÓM: áp cho 1/nhiều/tất cả nhóm được chọn.
                const rawIds = Array.isArray(payload.groupIds) ? payload.groupIds.map(String).map(s => s.trim()).filter(Boolean) : [];
                if (!rawIds.length) throw new Error('Chọn ít nhất một nhóm');
                const enabled = !!payload.enabled;
                const time = /^\d{1,2}:\d{2}$/.test(String(payload.time || '')) ? normReportTime(payload.time) : '23:55';
                const toGroup = payload.deliverThisGroup !== false; // mặc định bật
                const toOwner = !!payload.deliverOwnerDm;
                // Fan-out ra MỌI ID cùng nhóm (đa bot → mỗi bot 1 ID) cho từng group đã chọn.
                const ids = new Set();
                for (const gid of rawIds) for (const id of siblingGroupIds(gid)) ids.add(id);
                for (const id of ids) {
                    store.setSetting(id, 'autoSummary', enabled);
                    store.setSetting(id, 'reportTime', time);
                    store.setSetting(id, 'reportDeliverThisGroup', toGroup);
                    store.setSetting(id, 'reportDeliverOwnerDm', toOwner);
                    // Báo cáo cuối ngày cần lịch sử chat → bật auto-report thì bật luôn follow/tracking.
                    if (enabled) { store.setSetting(id, 'follow', true); store.setSetting(id, 'tracking', true); }
                }
                await store.saveSettings();
                return { ok: true, count: ids.size, enabled, time, deliverThisGroup: toGroup, deliverOwnerDm: toOwner };
            }

            if (action === 'create-payment') {
                const planId = String(payload.planId || '').trim();
                if (!planId) throw new Error('planId is required');
                const deviceId = getDeviceId();
                try {
                    const result = await licenseServerFetch('/v1/orders', {
                        method: 'POST',
                        body: JSON.stringify({ planId, deviceId }),
                    });
                    const order = result.order || {};

                    let cleanPlanName = order.planName;
                    try {
                        const plansData = JSON.parse(readFileSync(path.join(__dirname, 'upgrade', 'plans.json'), 'utf8'));
                        const matchedPlan = plansData.plans?.find(p => p.id === planId);
                        if (matchedPlan) cleanPlanName = matchedPlan.name;
                    } catch (e) {
                        logger.warn('[openclaw-zalo-mod] Failed to read plans.json for name fallback: ' + e.message);
                    }

                    return {
                        ok: true,
                        order: {
                            ...order,
                            planName: cleanPlanName || order.planName || '---',
                            orderId: order.orderId,
                            qrUrl: order.qrUrl || '',
                            bankName: order.bankName || order.bank_info?.bank || 'MB Bank',
                            accountNo: order.accountNo || order.bank_info?.account_number || '0962794917',
                            accountName: order.accountName || order.bank_info?.account_name || 'HO LE MINH TUAN',
                            memo: order.memo || order.payment_note || '',
                        },
                    };
                } catch (serverErr) {
                    throw new Error('License service unavailable: ' + serverErr.message);
                }
            }

            if (action === 'check-payment-status') {
                const orderId = String(payload.orderId || '').trim();
                try {
                    const checkResult = await licenseServerFetch(`/v1/orders/${encodeURIComponent(orderId)}`);
                    if (checkResult.paid || checkResult.key) {
                        await activateEntitlement({ orderId, licenseKey: checkResult.key });
                    }
                    return checkResult;
                } catch (serverErr) {
                    throw new Error('License service unavailable: ' + serverErr.message);
                }
            }

            if (action === 'activate-license') {
                const key = String(payload.key || '').trim();
                try {
                    return await activateEntitlement({ licenseKey: key, orderId: payload.orderId });
                } catch (serverErr) {
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
            }

            if (action === 'cancel-payment') {
                const orderId = String(payload.orderId || '').trim();
                const result = await cancelCurrentPayment(orderId);
                return { ok: result, orderId };
            }

            if (action === 'refresh-license') {
                const result = await refreshEntitlementIfNeeded(true);
                return { ok: result, license: getLicenseStatus() };
            }

            // Chẩn đoán chỉ-đọc: với senderId này thì agent được cấp tool nào?
            // Dùng để kiểm tra cổng owner mà không cần gửi tin Zalo thật. KHÔNG nằm
            // trong allowlist của agent nên bot không tự dò được bằng zalo_mod_action.
            if (action === 'agent-tools-status') {
                const senderId = String(payload.senderId || '').trim();
                const ownerIds = [...collectOwnerIds({ ...pluginCfg, ownerId: ownerId || pluginCfg.ownerId })];
                const built = zaloModToolFactory({ requesterSenderId: senderId });
                const out = {
                    senderId: senderId || null,
                    isOwner: ownerIds.includes(senderId),
                    ownerIds,
                    tools: built.map((t) => t.name),
                    destructiveAllowed: pluginCfg.agentTools?.allowDestructive === true,
                };
                // probe: chạy THẬT tool chỉ-đọc zalo_mod_groups để xác nhận đường
                // execute → dispatcher hoạt động, mà không cần gửi tin Zalo thật.
                // Không lộ thêm gì: người có token dashboard vốn đọc được /api/state.
                if (payload.probe) {
                    const groupsTool = built.find((t) => t.name === 'zalo_mod_groups');
                    out.probe = groupsTool
                        ? JSON.parse((await groupsTool.execute('probe', { query: String(payload.query || '') })).content[0].text)
                        : { skipped: 'tool không được cấp cho senderId này' };
                }
                return out;
            }

            if (action === 'toggle-setting') {
                const groupId = String(payload.groupId || '').trim();
                if (!groupId) throw new Error('Invalid setting payload');
                const res = await applyToggleSetting({
                    groupIds: [groupId],
                    key: payload.key,
                    value: payload.value,
                    profile: payload.profile,
                });
                return { groupId, key: res.key, value: res.value, applied: res.count, runtimePolicy: res.runtimePolicy };
            }

            if (action === 'bulk-toggle-setting') {
                const groupIds = Array.isArray(payload.groupIds) ? payload.groupIds.map(String).filter(Boolean) : [];
                if (!groupIds.length) throw new Error('Invalid bulk setting payload');
                return await applyToggleSetting({
                    groupIds,
                    key: payload.key,
                    value: payload.value,
                    profile: payload.profile,
                });
            }

            if (action === 'get-name-triggers') {
                const accountId = primaryProfile(String(payload.accountId || payload.profile || 'default')) || 'default';
                const stored = getStoredNameTriggers(accountId);
                const bridge = globalThis.__zaloModEngine?.bridge;
                if (bridge?.getNameTriggers) {
                    try {
                        const res = await bridge.getNameTriggers(accountId);
                        // Store is the source of truth for the alias list; the bridge adds
                        // the auto display name. Prefer store if the runtime hasn't been
                        // replayed yet (empty runtime but non-empty store).
                        const triggers = (Array.isArray(res.triggers) && res.triggers.length) ? res.triggers : stored;
                        return { accountId, displayName: res.displayName ?? null, triggers, effective: dedupeAliases([res.displayName, ...triggers]) };
                    } catch (e) {
                        logger.warn(`[openclaw-zalo-mod] get-name-triggers ${accountId}: ${e.message}`);
                    }
                }
                return { accountId, displayName: null, triggers: stored, effective: stored, bridgeUnavailable: true };
            }

            if (action === 'set-name-triggers') {
                const accountId = primaryProfile(String(payload.accountId || payload.profile || 'default')) || 'default';
                const input = Array.isArray(payload.triggers) ? payload.triggers.map(String) : [];
                const bridge = globalThis.__zaloModEngine?.bridge;
                let runtime = null;
                if (bridge?.setNameTriggers) {
                    try { runtime = await bridge.setNameTriggers(accountId, input); }
                    catch (e) { logger.warn(`[openclaw-zalo-mod] set-name-triggers ${accountId}: ${e.message}`); }
                }
                // Persist the runtime-cleaned list when available so store and runtime match.
                const persisted = await persistNameTriggers(accountId, runtime ? runtime.triggers : input);
                return {
                    accountId,
                    displayName: runtime?.displayName ?? null,
                    triggers: persisted,
                    effective: runtime?.effective ?? dedupeAliases(persisted),
                    bridgeUnavailable: !runtime,
                };
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

            // Đọc template + KEY hợp lệ. Thiếu action này là lý do bot báo "không cập nhật được
            // welcome": `save-templates` vốn đã cho bot gọi, nhưng bot không có cách nào biết key nào
            // hợp lệ hay nội dung hiện tại đang là gì, nên chỉ còn nước đoán.
            if (action === 'get-templates') {
                const commands = templateCommandsFrom(pluginCfg);
                const items = [];
                for (const d of TEMPLATE_DEFS) {
                    items.push({
                        key: d.key,
                        label: d.label,
                        kind: d.kind,
                        command: commands[d.key] || '',
                        content: await loadTemplateContent(dataDir, d.key),
                    });
                }
                return { keys: TEMPLATE_KEYS, templates: items };
            }
            if (action === 'save-templates') {
                const key = String(payload.key || '').trim();
                const content = String(payload.content || '');
                if (!TEMPLATE_KEYS.includes(key)) {
                    throw new Error('Template key không hợp lệ');
                }
                const filename = `${key}.txt`;
                const filePath = path.join(dataDir, filename);
                await fs.writeFile(filePath, content, 'utf8');
                // Lệnh slash tuỳ chỉnh (tuỳ chọn) — lưu vào config.json để dispatcher tra động.
                let command;
                if (payload.command !== undefined) {
                    command = normCmdWord(payload.command);
                    // Chống trùng lệnh với template khác.
                    const cur = templateCommandsFrom(pluginCfg);
                    for (const k of Object.keys(cur)) {
                        if (k !== key && command && cur[k] === command) {
                            throw new Error(`Lệnh "${command}" đã dùng cho template khác`);
                        }
                    }
                    const map = (pluginCfg.templateCommands && typeof pluginCfg.templateCommands === 'object') ? { ...pluginCfg.templateCommands } : {};
                    map[key] = command;
                    await savePluginConfig({ templateCommands: map });
                }
                logger.info(`[openclaw-zalo-mod] template ${key} saved by dashboard${command !== undefined ? ` (cmd="${command}")` : ''}`);
                return { ok: true, key, command };
            }

            if (action === 'group-detail') {
                const groupId = String(payload.groupId || '').trim();
                if (!groupId) throw new Error('groupId is required');
                const settingsRaw = store.getRawSettings();
                const memberDir = await readPluginDataJson('group-members.json');
                const settings = settingsRaw[groupId] || {};
                let zcaInfo = null;
                let pending = null;
                try { zcaInfo = await runDashboardZcaAction('get-group-info', { groupId }); } catch (_) { }
                try {
                    const pendingRaw = await runDashboardZcaAction('get-pending', { groupId });
                    pending = await enrichPendingResult(groupId, pendingRaw);
                    store.setSetting(groupId, 'pendingCount', pending.list.length);
                    await store.saveSettings();
                } catch (_) { }
                return {
                    groupId,
                    name: groupNames[groupId]?.name || settings.name || `Group ${groupId.slice(-6)}`,
                    memberCount: Math.max(Number(settings.memberCount || settings.totalMember || 0), Object.keys(memberDir[groupId] || {}).length),
                    pendingCount: Number(settings.pendingCount || 0),
                    admins: settings.groupAdmins || groupNames[groupId]?.admins || [],
                    creatorId: settings.creatorId || groupNames[groupId]?.creatorId || '',
                    inviteLink: settings.inviteLink || groupNames[groupId]?.inviteLink || '',
                    settings: {
                        muted: !!settings.muted,
                        silent: settings.silent !== false,
                        welcome: settings.welcome !== false,
                        tracking: (settings.follow === true || settings.tracking === true),
                        follow: (settings.follow === true || settings.tracking === true),
                        pendingAuto: !!settings.pendingAuto,
                        autoSummary: settings.autoSummary === true,
                        reportTime: settings.reportTime || '23:55',
                        reportDeliverThisGroup: settings.reportDeliverThisGroup !== false,
                        reportDeliverOwnerDm: settings.reportDeliverOwnerDm === true,
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

            if (action === 'bulk-friend-request') {
                const userIds = Array.isArray(payload.userIds) ? payload.userIds.map(String).filter(Boolean) : [];
                if (!userIds.length) throw new Error('userIds are required');
                const results = [];
                for (const userId of userIds) {
                    try {
                        results.push({ userId, ok: true, result: await runDashboardZcaAction('send-friend-request', { userId, message: payload.message }) });
                    } catch (error) {
                        results.push({ userId, ok: false, error: error.message });
                    }
                }
                return { count: results.filter((item) => item.ok).length, results };
            }

            if (action === 'send-messages') {
                const targets = Array.isArray(payload.targets) ? payload.targets : [];
                const text = String(payload.text || '').trim();
                if (!targets.length || !text) throw new Error('targets and text are required');
                const results = [];
                for (const target of targets) {
                    const targetId = String(target.targetId || target.groupId || target.userId || '').trim();
                    if (!targetId) continue;
                    try {
                        const result = target.targetType === 'user'
                            ? await sendDmMsg({ accountId: target.profile || 'default' }, targetId, text)
                            : await sendGroupMsg({ accountId: target.profile || 'default' }, targetId, text);
                        if (result && !result.ok) throw new Error(result.error || 'Failed to send message');
                        results.push({ targetId, ok: true, messageId: result?.messageId });
                    } catch (error) {
                        results.push({ targetId, ok: false, error: error.message });
                    }
                }
                return { count: results.filter((item) => item.ok).length, results };
            }

            if (action === 'send-message') {
                const targetId = String(payload.targetId || payload.groupId || payload.userId || '').trim();
                const text = String(payload.text || '').trim();
                if (!targetId || !text) throw new Error('targetId and text are required');
                let result;
                if (payload.targetType === 'user') {
                    result = await sendDmMsg({ accountId: 'default' }, targetId, text);
                } else {
                    result = await sendGroupMsg({ accountId: 'default' }, targetId, text);
                }
                if (result && !result.ok) {
                    throw new Error(result.error || 'Failed to send message');
                }
                return { sent: true, targetId, messageId: result?.messageId };
            }

            // ── CRM actions (crm-*) → src/crm/crm-api.js ──
            if (action.startsWith('crm-')) {
                const res = handleCrmAction(zEngine?.crm ?? null, action, payload, 'dashboard');
                if (!res.body.ok) throw new Error(res.body.error);
                return res.body.data;
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

        const profileSyncQueue = new Set();
        let isProfileSyncing = false;

        async function startProfileSyncJob() {
            if (isProfileSyncing) return;
            isProfileSyncing = true;

            logger.info('[openclaw-zalo-mod] Started background member profiles sync job with queue size: ' + profileSyncQueue.size);

            setInterval(async () => {
                if (profileSyncQueue.size === 0) return;

                const userId = profileSyncQueue.values().next().value;
                profileSyncQueue.delete(userId);

                try {
                    const cleanId = String(userId).replace(/_0$/, '');
                    const cacheRaw = await readPluginDataJson('zalo-profiles-cache.json');
                    const cache = cacheRaw && typeof cacheRaw === 'object' && !Array.isArray(cacheRaw) ? cacheRaw : {};
                    if (cache[cleanId] && cache[cleanId].displayName) {
                        return;
                    }

                    const withZaloApi = await getSafeZaloApi();
                    if (!withZaloApi) return;

                    // Tìm object hồ sơ của cleanId trong response getUserInfo (đệ quy).
                    const findProfile = (raw) => {
                        let found = null;
                        const extract = (obj) => {
                            if (found || !obj || typeof obj !== 'object') return;
                            if (Array.isArray(obj)) { for (const item of obj) { extract(item); if (found) return; } return; }
                            const id = String(obj.userId || obj.uid || obj.id || obj.user_id || '').replace(/_0$/, '');
                            const name = obj.displayName || obj.zaloName || obj.name || obj.userName || obj.fullName;
                            if (id === cleanId && name) { found = obj; return; }
                            for (const val of Object.values(obj)) if (val && typeof val === 'object') { extract(val); if (found) return; }
                        };
                        extract(raw);
                        return found;
                    };

                    // ĐA-AGENT: thử TỪNG bot; sđt/ngày sinh chỉ hiện với bot đã KẾT BẠN → gộp field, bot nào có thì lấy.
                    const _bots = await getZaloBots().catch(() => []);
                    const profiles = (_bots && _bots.length ? _bots.map(b => b.profile) : ['default']).filter(Boolean);
                    const acc = { userId: cleanId, displayName: '', avatar: '', sdob: '', phoneNumber: '' };
                    for (const prof of profiles) {
                        try {
                            const raw = await withZaloApi(prof, async (zaloApi) => await zaloApi.getUserInfo(cleanId).catch(() => null));
                            const f = findProfile(raw);
                            if (f) {
                                acc.displayName = acc.displayName || (f.displayName || f.zaloName || f.name || f.userName || f.fullName || '');
                                acc.avatar = acc.avatar || (f.avatar || f.avatarUrl || f.avatar_url || '');
                                acc.sdob = acc.sdob || (f.sdob || '');
                                acc.phoneNumber = acc.phoneNumber || (f.phoneNumber || f.phone || '');
                            }
                            if (acc.displayName && acc.avatar && acc.sdob && acc.phoneNumber) break; // đủ hết → dừng
                        } catch (_) { /* bot này không lấy được → thử bot kế */ }
                    }

                    if (acc.displayName) {
                        cache[cleanId] = acc;
                        await writePluginDataJson('zalo-profiles-cache.json', cache);
                        logger.info(`[openclaw-zalo-mod] Background synced profile for user ${cleanId}: ${acc.displayName}${acc.phoneNumber ? ' (+sđt)' : ''}`);
                    } else {
                        logger.warn(`[openclaw-zalo-mod] Sync profile parser could not find user ${cleanId} in response`);
                    }
                } catch (e) {
                    logger.warn(`[openclaw-zalo-mod] Background sync failed for user ${userId}: ${e.message}`);
                }
            }, 8000);
        }

        function startDashboardServer() {
            if (pluginCfg.dashboardEnabled === false) return;
            // Docker needs the service to listen on the container interface so the
            // host's 127.0.0.1:<port>:<port> mapping can reach it. Outside Docker,
            // keep the safer localhost-only default.
            const configuredDashboardHost = String(pluginCfg.dashboardHost || '').trim().toLowerCase();
            // OpenClaw applies the manifest's 127.0.0.1 default before plugin
            // startup, so an unset host arrives here as "127.0.0.1". Inside a
            // container that value must still be treated as the managed default.
            const isManagedContainerBind = existsSync('/.dockerenv')
                && (!configuredDashboardHost || configuredDashboardHost === '127.0.0.1' || configuredDashboardHost === 'localhost');
            const host = String(pluginCfg.dashboardHost || (isManagedContainerBind ? '0.0.0.0' : '127.0.0.1'));
            const bindHost = isManagedContainerBind ? '0.0.0.0' : host;
            const port = Number(pluginCfg.dashboardPort || 19790);
            const configuredToken = String(pluginCfg.dashboardToken || cfg?.gateway?.auth?.token || '').trim();
            const token = configuredToken || crypto.randomBytes(24).toString('base64url');
            const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());
            if (!isLoopback && !isManagedContainerBind && configuredToken.length < 24) {
                logger.error('[openclaw-zalo-mod] dashboard disabled: non-loopback dashboardHost requires dashboardToken with at least 24 characters');
                return;
            }
            const key = '__openclawZaloModDashboard';
            const existing = globalThis[key];
            if (existing?.server) {
                try { existing.server.close(); } catch (_) { }
            }

            const dashboardFile = path.join(__dirname, 'index.html');
            const donateQrFile = path.join(__dirname, 'bvbank.jpg');
            const logoFile = path.join(__dirname, 'logo.png');
            const server = http.createServer(async (req, res) => {
                try {
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Zalo-Dashboard-Token');
                    if (req.method === 'OPTIONS') {
                        res.writeHead(204);
                        res.end();
                        return;
                    }
                    const url = new URL(req.url || '/', `http://${host}:${port}`);
                    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
                        if (!isLoopback && !isManagedContainerBind && url.searchParams.get('token') !== token) {
                            sendDashboardJson(res, 401, { ok: false, error: 'Dashboard token required' });
                            return;
                        }
                        let html = existsSync(dashboardFile)
                            ? readFileSync(dashboardFile, 'utf8')
                            : '<!doctype html><meta charset="utf-8"><title>Zalo Dashboard</title><h1>Zalo Dashboard file missing</h1>';
                        html = html.replace('</head>', `<script>window.ZALO_DASHBOARD_TOKEN=${JSON.stringify(token)};</script></head>`);
                        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(html, 'utf8');
                        return;
                    }

                    if (req.method === 'GET' && url.pathname === '/dashboard.css') {
                        const cssFile = path.join(__dirname, 'dashboard.css');
                        if (existsSync(cssFile)) {
                            res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
                            res.end(readFileSync(cssFile, 'utf8'), 'utf8');
                        } else {
                            res.writeHead(404, { 'content-type': 'text/plain' });
                            res.end('CSS file not found');
                        }
                        return;
                    }

                    if (req.method === 'GET' && url.pathname === '/dashboard.js') {
                        const jsFile = path.join(__dirname, 'dashboard.js');
                        if (existsSync(jsFile)) {
                            res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
                            res.end(readFileSync(jsFile, 'utf8'), 'utf8');
                        } else {
                            res.writeHead(404, { 'content-type': 'text/plain' });
                            res.end('JS file not found');
                        }
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
                    try { await appendDashboardAudit({ action: 'error', ok: false, error: e.message }); } catch (_) { }
                    sendDashboardJson(res, 500, { ok: false, error: e.message });
                }
            });

            server.listen(port, bindHost, () => {
                logger.info(`[openclaw-zalo-mod] dashboard listening at http://${bindHost}:${port}/dashboard`);
            });
            globalThis[key] = { server, port, host };
        }

        const isGateway = process.argv.includes('gateway') || process.argv.includes('run');
        if (isGateway) {
            startDashboardServer();
        }

        // ── Z0–Z2 Engine: TurnContext + FIFO + passive context + bridge ──
        // Thay thế pattern mutable "ghi sender lúc dispatch, đọc lúc reply"
        // (nguồn bug A/B cross-tag) bằng TurnContext bất biến + FIFO correlation.
        const zEngine = createZaloModEngine({
            dataDir,
            logger,
            runtime: api.runtime,
            getConfig: () => api.config,
            config: pluginCfg?.contextEngine || {},
        });
        try { globalThis.__zaloModEngine?.shutdown?.(); } catch { }
        globalThis.__zaloModEngine = zEngine; // dashboard/debug access
        const isZaloChannel = (c) => {
            const id = c?.channelId || c?.channel;
            return id === 'zalo-connect';
        };
        const plainGroupId = (...values) => {
            for (const value of values) {
                const id = String(value ?? '').replace(/^group:/, '').trim();
                if (id && groupNames[id]) return id;
            }
            return '';
        };
        const replyMentions = new ReplyMentionCorrelator();
        let handleZaloDispatch = null;
        // ZaloConnect phát mọi tin group đã qua access gate nhưng CHƯA qua mention
        // gate. Capture local tại đây để Silent vẫn có ngữ cảnh khi user tag bot
        // ở tin sau; callback này không dispatch/model nên luôn zero-token.
        try { globalThis.__zaloModInboundUnsubscribe?.(); } catch { }
        globalThis.__zaloModInboundUnsubscribe = zEngine.bridge.onInbound(async (event) => {
            if (!event?.isGroup) return;
            zEngine.captureInbound({
                accountId: event.accountId,
                conversationId: event.conversationId,
                groupId: event.groupId,
                messageId: event.messageId,
                senderId: event.senderId,
                senderName: event.senderName,
                text: event.text,
                timestamp: event.timestamp,
                rawType: event.rawType,
                quote: event.quote,
            });
            // Ghi lịch sử chat (.jsonl mà báo cáo cuối ngày đọc) NGAY tại onInbound.
            // Trên OpenClaw v2026.5.x, runtime plugin KHÔNG nhận before_dispatch nên
            // handleZaloDispatch (nơi duy nhất từng gọi appendChatLog) không chạy cho tin
            // thường → báo cáo luôn 0 tin. Đây là path fire cho MỌI tin group, nên ghi ở
            // đây mới đảm bảo nhóm follow có dữ liệu. appendChatLog tự dedup → an toàn kể
            // cả khi before_dispatch cũng fire ở deployment khác.
            (async () => {
                try {
                    const gid = plainGroupId(event.groupId, event.conversationId);
                    const text = String(event.text || '').trim();
                    if (!gid || !text || text.startsWith('/') || !isFollowOn(gid)) return;
                    let name = String(event.senderName || '').trim();
                    if (!name || name === String(event.senderId)) {
                        name = (await resolveUserName(event.accountId, event.senderId)) || name;
                    }
                    await appendChatLog(gid, name, event.text, event.senderId);
                } catch (e) {
                    logger.warn('[openclaw-zalo-mod] inbound chat-log failed: ' + e.message);
                }
            })();
            // Bridge contract v3 lets Zalo Mod claim slash commands before
            // Zalo Connect's silent/mention gate. This keeps commands zero-token
            // and prevents a second agent reply. Older bridge versions keep the
            // legacy before_dispatch path without risking duplicate execution.
            const bridgeVersion = Number(globalThis.__zaloConnectBridgeService?.version || 0);
            if (bridgeVersion < 3 || typeof handleZaloDispatch !== 'function') return;
            if (!/(?:^|\s)\/[a-z][a-z0-9-]*/i.test(String(event.text || ''))) return;
            return handleZaloDispatch({
                body: event.text,
                content: event.text,
                messageId: event.messageId,
                senderId: event.senderId,
                senderName: event.senderName,
                conversationId: event.conversationId,
                mentions: (event.mentions || []).map((mention) => ({
                    uid: mention.userId || mention.uid,
                    name: mention.displayName || mention.name || '',
                })),
                quote: event.quote,
                timestamp: event.timestamp,
            }, {
                channelId: 'zalo-connect',
                channel: 'zalo-connect',
                accountId: event.accountId || 'default',
                conversationId: event.conversationId || `group:${event.groupId}`,
                senderId: event.senderId,
                isGroup: true,
            });
        });
        zEngine.bridge.getStatus('default').then((s) => {
            logger.info(`[openclaw-zalo-mod] bridge backend: ${s.backend || 'zalo-connect'} connected=${s.connected}`);
        }).catch(() => { });

        // ZaloConnect có thể register sau Zalo Mod. Replay setting đã persist vào
        // runtime bridge với retry ngắn; không chạm openclaw.json và không làm
        // gateway restart. Sau một restart thật, map RAM được dựng lại ở đây.
        (() => {
            let attempt = 0;
            const replay = async () => {
                attempt++;
                try {
                    await ensureStore();
                    const result = await syncZaloConnectRuntimePolicies(watchGroupIds, { quiet: true });
                    if (result.failed === 0) {
                        logger.info(`[openclaw-zalo-mod] live group policy replayed: ${result.applied}/${watchGroupIds.length}`);
                        const nt = await replayNameTriggers().catch(() => null);
                        if (nt && !nt.unavailable && nt.total) {
                            logger.info(`[openclaw-zalo-mod] name triggers replayed: ${nt.applied}/${nt.total} account(s)`);
                        }
                        return;
                    }
                } catch { /* bridge chưa load — retry */ }
                if (attempt < 20) {
                    const timer = setTimeout(replay, 500);
                    if (timer.unref) timer.unref();
                } else {
                    logger.warn('[openclaw-zalo-mod] live group policy unavailable after startup; settings remain persisted for next retry/toggle.');
                }
            };
            const timer = setTimeout(replay, 0);
            if (timer.unref) timer.unref();
        })();
        // Owner claim uses the persistent server Device ID. Only someone with
        // access to the local dashboard/server can obtain it.
        if (!ownerId) {
            logger.info(`[openclaw-zalo-mod] ⚠️ Chưa có owner. Mở dashboard để lấy Device ID rồi DM bot: "im owner ${getDeviceId()}".`);
        }

        // ── Native auto-mention cho phản hồi agent ─────────────────
        // message_received và reply_payload_sending dùng chung runId. Nhờ vậy
        // mỗi reply luôn tag đúng người kích hoạt lượt đó, kể cả hai lượt cùng
        // group chạy gần nhau. ZaloConnect đổi @[Tên] thành mention native khi gửi.
        api.on('message_received', async (event, ctx) => {
            if ((ctx?.channelId || event?.metadata?.provider) !== 'zalo-connect') return;
            const groupId = plainGroupId(
                ctx?.conversationId,
                event?.threadId,
                event?.metadata?.conversationId,
                event?.metadata?.threadId,
            );
            if (!groupId) return;

            const senderId = String(ctx?.senderId || event?.senderId || event?.from || '').trim();
            let senderName = String(
                event?.metadata?.senderName
                || event?.metadata?.displayName
                || event?.metadata?.dName
                || '',
            ).trim();
            const record = replyMentions.capture({
                runId: event?.runId || ctx?.runId,
                sessionKey: event?.sessionKey || ctx?.sessionKey,
                accountId: ctx?.accountId || event?.metadata?.accountId || 'default',
                conversationId: groupId,
                senderId,
                senderName,
            });
            if (record && (!senderName || senderName === senderId)) {
                senderName = await resolveUserName(record.accountId, senderId);
                replyMentions.updateName(record, senderName);
            }
        });

        api.on('reply_payload_sending', (event, ctx) => {
            if ((ctx?.channelId || event?.channel) !== 'zalo-connect') return;
            const result = replyMentions.decorate(event, ctx);
            if (!result) return;
            if (result.changed) {
                logger.info(`[openclaw-zalo-mod] native reply mention: @${result.record.senderName} run=${result.record.runId || 'session-fifo'}`);
            }
            return { payload: { ...event.payload, text: result.text } };
        });

        // ── Event: before_dispatch (legacy command/moderation hook) ──
        handleZaloDispatch = async (event, ctx) => {
            // 1. Chỉ bắt event từ OpenClaw Zalo Connect
            if (pluginCfg.debug === true) { console.log('[ZALO-MOD-DEBUG] ctx:', JSON.stringify(ctx || {})); console.log('[ZALO-MOD-DEBUG] body:', event?.body); }
            if (!isZaloChannel(ctx)) return;

            // NOTE: Zalo strips @mention from event.content but keeps it in event.body
            const content = String(event?.body || event?.content || '').trim();

            await ensureStore();

            // NOTE: Welcome detection is handled by the member watcher (polling-based).
            // OpenClaw Zalo Connect channel does NOT pass system events (join/leave) to plugins.
            // NOTE: Sticker/image/file messages in groups are silently dropped by Zalo Connect channel core
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
            const senderId = String(ctx.senderId || event.senderId || '');
            // Group event thường KHÔNG kèm tên hiển thị → thử các field rẻ trước, resolve qua API sau (bên dưới).
            let senderName = String(event.senderName || event.sender?.name || event.dName || event.data?.dName || '').trim() || senderId;

            // Resolve bot theo account THỰC SỰ nhận tin (ctx.accountId) — không theo
            // profile ghi nhận của group. Nhờ vậy mỗi bot trong group nhiều bot sẽ
            // dùng đúng tên/prefix/owner của chính nó (check @mention, slash, owner...).
            const botCfg = getBotConfig(ctx?.accountId || (isGroupMsg ? rawConvId : 'default'));
            const { profile, botName, botNames, cmdPrefix, ownerId: activeOwnerId } = botCfg;
            const currentOwnerId = activeOwnerId || (profile === 'default' ? ownerId : '');

            // Tên hiển thị: nếu event không kèm tên (senderName == id) → resolve qua API bot nhận tin (có cache).
            // Nhờ vậy lịch sử chat / note / memory / tổng hợp AI hiển thị ĐÚNG TÊN người, không phải dãy ID.
            if (senderName === senderId && senderId) {
                const rn = await resolveUserName(profile, senderId);
                if (rn) senderName = rn;
            }

            // Packaging Gating: Skip automated moderation / anti-spam / commands for Free users
            // LOẠI TRỪ: Cho phép chủ nhân bot (owner) chạy các lệnh cấu hình hoặc kích hoạt bản quyền kể cả khi đang ở gói Free
            const lic = getLicenseStatus();
            if (!lic.isPro) {
                const bodyContent = String(event?.body || event?.content || '').trim();
                const lcBody = bodyContent.toLowerCase();

                const isActivationCmd = lcBody.startsWith(`${cmdPrefix}active-key`) || lcBody.startsWith(`${cmdPrefix}kich-hoat`);
                const cleanLc = lcBody.replace(/['’]/g, '');
                const isClaimOwnerCmd = lcBody.startsWith(`${cmdPrefix}ownerid`) || cleanLc === 'im admin' || cleanLc === 'iam admin' || cleanLc === 'i am admin';
                const isOwnerRulesCmd = currentOwnerId && senderId === currentOwnerId && (lcBody.startsWith(`${cmdPrefix}rules`) || lcBody.startsWith(`${cmdPrefix}mute`) || lcBody.startsWith(`${cmdPrefix}unmute`));

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
                // Z0 security: lệnh claim chấp nhận kèm mã one-time: "im owner <MÃ>"
                const _prefixEsc = cmdPrefix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                const claimRe = new RegExp(`^(?:${_prefixEsc}owner(?:id)?|im owner|iam owner|i am owner|im admin|iam admin|i am admin)(?:\\s+(\\S+))?$`, 'i');
                const claimMatch = content.replace(/['’]/g, '').trim().match(claimRe);
                const ownerIdMatch = !!claimMatch;
                if (ownerIdMatch) {
                    if (!currentOwnerId) {
                        // First-owner claim must match the persistent server Device ID.
                        const suppliedCode = (claimMatch[1] || '').trim();
                        if (!matchesOwnerClaimDeviceId(suppliedCode, getDeviceId())) {
                            logger.warn(`[openclaw-zalo-mod] owner-claim từ ${senderName} (${senderId}) bị TỪ CHỐI — thiếu/sai Device ID.`);
                            await sendDmMsg(ctx, senderId,
                                '🔒 Đăng ký Owner cần Device ID.\nMở Zalo Mod Dashboard → Cài đặt, copy Device ID rồi gửi:\n\nim owner <DEVICE_ID>');
                            return { handled: true };
                        }
                        // Mã hợp lệ → claim sender và ghi nhận đủ các config tương ứng
                        let patched = false;
                        const bName = botCfg.botName || 'Bot';
                        const slashPrefix = bName.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'bot';
                        const botPatch = {
                            botName: bName,
                            zaloDisplayNames: botCfg.botNames.filter(n => n !== bName),
                            slashPrefix: slashPrefix,
                            ownerId: senderId
                        };

                        if (profile && profile !== 'default') {
                            const patch = {
                                bots: {
                                    ...pluginCfg.bots,
                                    [profile]: botPatch
                                }
                            };
                            await savePluginConfig(patch);
                            patched = true;
                        } else {
                            // Default bot: identity (incl. ownerId) lives under bots.default
                            // only — no legacy top-level ownerId, no openclaw.json mirror.
                            // The in-memory global ownerId is backfilled from bots.default on
                            // next load; this session is covered by adminIds.add below.
                            await savePluginConfig({
                                bots: { ...pluginCfg.bots, default: botPatch }
                            });
                            patched = true;
                        }
                        if (patched) {
                            adminIds.add(senderId);
                            await sendDmMsg(ctx, senderId, [
                                '🎉 ĐĂNG KÝ OWNER THÀNH CÔNG',
                                '━━━━━━━━━━━━━━━━━━━━',
                                `👑 Chủ sở hữu:  ${senderName}`,
                                `🆔 Owner ID:  ${senderId}`,
                                '',
                                '✅ Bạn giờ có toàn quyền quản trị bot.',
                                '🔄 Khởi động lại gateway để áp dụng đầy đủ.',
                            ].join('\n'));
                        } else {
                            await sendDmMsg(ctx, senderId, [
                                '⚠️ CHƯA GHI ĐƯỢC CẤU HÌNH',
                                '━━━━━━━━━━━━━━━━━━━━',
                                'Vui lòng thêm thủ công dòng sau vào',
                                `plugins.entries.${PLUGIN_ID}.config:`,
                                '',
                                `"ownerId": "${senderId}"`,
                            ].join('\n'));
                        }
                    } else {
                        // Đã có owner → trả về info
                        const _isYou = String(currentOwnerId) === String(senderId);
                        await sendDmMsg(ctx, senderId, [
                            '👑 THÔNG TIN OWNER',
                            '━━━━━━━━━━━━━━━━━━━━',
                            `🆔 Owner ID:  ${currentOwnerId}`,
                            '',
                            _isYou ? '✅ Chính là bạn — bot đã có chủ sở hữu.'
                                   : 'ℹ️ Bot đã có chủ sở hữu, không thể đăng ký lại.',
                        ].join('\n'));
                    }
                    return { handled: true };
                }

                // Owner DM → config commands hoặc forward LLM
                if (currentOwnerId && senderId === currentOwnerId) {
                    const ownerResult = await handleOwnerDm(content, senderId, ctx, cmdPrefix, botName);
                    if (ownerResult) return ownerResult;
                    return; // forward to LLM
                }

                // Allowed user → forward to LLM (theo permissions.dm)
                if (isDmAllowed(senderId, senderName)) return;
                // Chưa khớp: DM của Zalo không kèm tên + id per-account → resolve tên thật qua
                // API bot nhận tin rồi thử lại theo tên (chỉ khi mode cần danh sách).
                const _dmMode = (livePermissions().dm || {}).mode;
                if (_dmMode === 'list' || _dmMode === 'friends') {
                    const realName = await resolveUserName(profile, senderId);
                    if (realName && isDmAllowed(senderId, realName)) return;
                    logger.info(`[openclaw-zalo-mod] DM blocked from ${realName || senderName} (${senderId}) — chặn theo permissions.dm`);
                    return { handled: true };
                }
                // Bị chặn theo phân quyền DM → block im lặng
                logger.info(`[openclaw-zalo-mod] DM blocked from ${senderName} (${senderId}) — chặn theo permissions.dm`);
                return { handled: true };
            }

            const groupId = rawConvId.replace(/^group:/, '');

            // ── GROUP ACCESS GATE — bot chỉ hoạt động ở group được phép (owner luôn lọt) ──
            if (!isGroupAllowed(groupId) && senderId !== currentOwnerId) return { handled: true };

            // ── MUTE CHECK — first gate, before everything else ───
            const isMuted = store.getSetting(groupId, 'muted', false);
            if (isMuted) {
                // Only allow /unmute from admin to pass through
                const unmuteMatch = content.match(new RegExp(`^${cmdPrefix}(unmute|bat-bot)$`, "i"));
                if (unmuteMatch && isAdmin(senderId, groupId)) {
                    await applyToggleSetting({ groupIds: [groupId], key: 'muted', value: false });
                    logger.info(`[openclaw-zalo-mod] group ${groupId} UNMUTED by ${senderName}`);
                    await sendGroupMsg(ctx, groupId, '🔊 Bot đã bật lại trong group này!');
                    return { handled: true };
                }
                // Muted → ignore everything silently
                return { handled: true };
            }

            // ── Z2: Passive capture (zero-token) — TRƯỚC mention gating ──
            // Mọi tin group được phép vào ConversationBuffer + SQLite; khi bot
            // được tag sẽ inject bounded context. Tuyệt đối không gọi LLM ở đây.
            zEngine.captureInbound({
                accountId: ctx?.accountId,
                conversationId: rawConvId,
                groupId,
                messageId: event?.msgId ?? event?.messageId ?? event?.cliMsgId,
                senderId,
                senderName,
                text: content,
                timestamp: Number(event?.timestamp) || Date.now(),
                quote: event?.quote ? {
                    messageId: event.quote.globalMsgId ?? event.quote.messageId,
                    senderId: event.quote.ownerId ?? event.quote.senderId,
                    text: event.quote.msg ?? event.quote.text,
                } : undefined,
            });

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
                const args = cmdArgs ? cmdArgs.split(/\s+/) : [];
                // Text before the slash command (e.g. "@Bot mai 5h @Mkt đi đá banh /note" → "mai 5h @Mkt đi đá banh")
                const botMentionRe = new RegExp(botNames.map(n => '@' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
                const textBefore = content.slice(0, slashMatch.index + (slashMatch[0].startsWith(' ') ? 1 : 0)).trim()
                    .replace(botMentionRe, '').replace(/\s{2,}/g, ' ').trim(); // strip only bot @mentions

                // /noi-quy (nội quy)
                if (command === '/noi-quy') {
                    const template = await getTemplateContent(path.join(dataDir, 'noi-quy.txt'), DEFAULT_NOI_QUY);
                    const text = renderTemplate(template, {
                        groupName: getGroupName(groupId),
                        botName,
                        cmdPrefix
                    });
                    await sendGroupMsg(ctx, groupId, text);
                    return { handled: true };
                }

                // /mute — admin only: tắt bot hoàn toàn trong group
                if (command === '/mute' || command === '/tat-bot') {
                    if (!isAdmin(senderId, groupId)) return { handled: true };
                    await applyToggleSetting({ groupIds: [groupId], key: 'muted', value: true });
                    logger.info(`[openclaw-zalo-mod] group ${groupId} MUTED by ${senderName}`);
                    await sendGroupMsg(ctx, groupId, `🔇 Bot đã tắt trong group này.\nGõ ${cmdPrefix}unmute để bật lại.`);
                    return { handled: true };
                }

                // /unmute — admin only: bật lại bot (also handled in mute gate above, but kept here for non-muted state)
                if (command === '/unmute' || command === '/bat-bot') {
                    if (!isAdmin(senderId, groupId)) return { handled: true };
                    await applyToggleSetting({ groupIds: [groupId], key: 'muted', value: false });
                    await sendGroupMsg(ctx, groupId, '🔊 Bot đang hoạt động bình thường!');
                    return { handled: true };
                }

                // /menu | /huong-dan
                if (command === '/menu') {
                    const template = await getTemplateContent(path.join(dataDir, 'menu.txt'), DEFAULT_MENU);
                    const customModesText = buildCustomModesText(groupId, cmdPrefix);
                    let text = renderTemplate(template, {
                        groupName: getGroupName(groupId),
                        botName,
                        cmdPrefix,
                        customModes: customModesText
                    });
                    if (customModesText && !template.includes('{customModes}')) {
                        text += '\n\n' + customModesText;
                    }
                    // Nếu sender là owner → hiện thêm owner commands
                    if (currentOwnerId && senderId === currentOwnerId) {
                        text += `\n\n👑 OWNER (DM riêng với bot):\n  ${cmdPrefix}rules groupid-list\n  ${cmdPrefix}rules groupid-add <groupId> [tên]\n  ${cmdPrefix}rules — Panel cấu hình\n  ${cmdPrefix}rules status — Tổng quan`;
                    }
                    await sendGroupMsg(ctx, groupId, text);
                    return { handled: true };
                }
                if (command === '/huong-dan') {
                    const template = await getTemplateContent(path.join(dataDir, 'huong-dan.txt'), DEFAULT_HUONG_DAN);
                    const text = renderTemplate(template, {
                        groupName: getGroupName(groupId),
                        botName,
                        cmdPrefix
                    });
                    await sendGroupMsg(ctx, groupId, text);
                    return { handled: true };
                }

                // Lệnh template tuỳ chỉnh (owner đặt trong mục "Template"): gửi nội dung template tương ứng.
                // Các lệnh mặc định noi-quy/menu/huong-dan đã xử lý ở trên; đây bắt lệnh do owner tự đặt
                // cho bất kỳ template nào (kể cả welcome/spam-warning/maintenance).
                const boundTplKey = resolveTemplateKeyByCommand(command, pluginCfg);
                if (boundTplKey) {
                    const tpl = await loadTemplateContent(dataDir, boundTplKey);
                    const vars = { groupName: getGroupName(groupId), botName, cmdPrefix, memberName: senderName };
                    if (boundTplKey === 'menu') {
                        const customModesText = buildCustomModesText(groupId, cmdPrefix);
                        vars.customModes = customModesText;
                        let text = renderTemplate(tpl, vars);
                        if (customModesText && !tpl.includes('{customModes}')) text += '\n\n' + customModesText;
                        await sendGroupMsg(ctx, groupId, text);
                    } else {
                        await sendGroupMsg(ctx, groupId, renderTemplate(tpl, vars));
                    }
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
                    const rawTarget = (args[0] || '').replace(/^@/, '');
                    const targetId = (targetMentions[0]?.uid || rawTarget || '').replace(/^@/, '');
                    const targetName = (targetMentions[0]?.name || rawTarget || targetId).replace(/^@/, '');
                    const reasonArgs = args.slice(1);
                    const reason = reasonArgs.join(' ').trim() || 'Vui lòng giữ nội dung phù hợp group';
                    if (!targetId) return { handled: true };
                    store.addWarn(groupId, targetId, targetName, reason);
                    await store.saveWarned();
                    const warnCount = store.getWarnCount(groupId, targetId);
                    const kickNote = warnCount >= 3 ? '\n⛔ Đã warn 3 lần — cân nhắc kick.' : '';
                    // Sync to memory
                    await appendToMemoryFile(groupId, 'members.md', `| ${targetName} | ${warnCount} | ${reason} | ${nowShort()} |`);
                    await appendToMemoryFile(groupId, 'chat-highlights.md', `| ${nowShort()} | Admin | /warn ${targetName}: ${reason} |`);
                    await sendGroupMsg(ctx, groupId,
                        `⚠️ ${targetName} — ${reason}.\nLần tiếp theo admin sẽ xử lý.${kickNote}\n✅ Đã ghi nhận. Lần ${warnCount}.`
                    );
                    return { handled: true };
                }

                // /note [text] — ghi note có cấu trúc vào notes.json
                if (command === '/note') {
                    if (!canRunCmd('note', senderId, groupId, senderName)) return { handled: true };
                    const noteText = (textBefore || args.join(' ')).trim();
                    if (!noteText) { await sendGroupMsg(ctx, groupId, '📝 Cú pháp: /note <nội dung cần ghi>'); return { handled: true }; }
                    await addNote(groupId, senderId, senderName, noteText);
                    // Vẫn append vào admin-notes.md để agent đọc được trong context
                    await appendToMemoryFile(groupId, 'admin-notes.md', `| ${nowShort()} | ${senderName} | ${noteText} |`);

                    // AI tự phân loại: note thường vs lời nhắc theo thời gian → tự tạo cron native OpenClaw.
                    let reminderLine = '';
                    try {
                        // Thử parser deterministic trước (tức thì, không cần AI); phức tạp mới hỏi AI.
                        let cls = parseReminderHeuristic(noteText);
                        if (!cls) cls = await classifyNoteReminder(noteText);
                        if (cls && cls.reminder && (cls.offsetMinutes > 0 || cls.at || cls.cron)) {
                            if (!cls.message) cls.message = noteText;
                            const rec = await addReminder(groupId, profile, cls, senderId);
                            if (rec.kind === 'recurring') {
                                reminderLine = `\n⏰ Đã đặt nhắc định kỳ (cron: ${rec.cron}).`;
                            } else if (Number.isFinite(rec.fireAtMs)) {
                                const vnStr = new Date(rec.fireAtMs + 7 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
                                reminderLine = `\n⏰ Đã đặt nhắc lúc ${vnStr} (giờ VN).`;
                            } else {
                                reminderLine = '\n⚠️ (Không hiểu được mốc thời gian — note vẫn đã lưu.)';
                            }
                        }
                    } catch (e) {
                        logger.warn(`[openclaw-zalo-mod] /note reminder failed: ${e.message}`);
                        reminderLine = '\n⚠️ (Không đặt được lịch nhắc tự động — note vẫn đã lưu.)';
                    }
                    await sendGroupMsg(ctx, groupId, `📝 Đã ghi note: ${noteText}${reminderLine}`);
                    return { handled: true };
                }

                // /active-key [key] / /kich-hoat [key] — owner only: kích hoạt key qua chat
                if (command === '/active-key' || command === '/kich-hoat') {
                    if (!currentOwnerId || senderId !== currentOwnerId) return { handled: true };
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
                    if (!currentOwnerId || senderId !== currentOwnerId) return { handled: true };
                    const sub = args[0]?.toLowerCase();
                    if (!sub) {
                        await sendGroupMsg(ctx, groupId,
                            renderCommandPanel(cmdPrefix, ['admin', 'admin-rules'], `⚙️ ADMIN COMMANDS — ${cmdPrefix}rules`)
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
                            const zcaInfo = await syncGroupAdminsFromZCA(groupId, ctx?.accountId || 'default');
                            if (!watchGroupIds.includes(groupId)) watchGroupIds.push(groupId);

                            let autoEnabled = false;
                            const allAdmins = getGroupAdmins(groupId);
                            if (allAdmins.includes(currentOwnerId)) {
                                // scope:'self' — đăng ký group cho ĐÚNG bot này,
                                // không bật lây sang bot khác cùng nhóm.
                                await applyToggleSetting({ groupIds: [groupId], key: 'welcome', value: true, scope: 'self' });
                                await applyToggleSetting({ groupIds: [groupId], key: 'follow', value: true, scope: 'self' });
                                autoEnabled = true;
                            }

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
                    if (sub === 'silent-on') { await applyToggleSetting({ groupIds: [groupId], key: 'silent', value: true }); await sendGroupMsg(ctx, groupId, '✅ Silent mode: BẬT'); return { handled: true }; }
                    if (sub === 'silent-off') { await applyToggleSetting({ groupIds: [groupId], key: 'silent', value: false }); await sendGroupMsg(ctx, groupId, '✅ Silent mode: TẮT'); return { handled: true }; }
                    if (sub === 'welcome-on') { await applyToggleSetting({ groupIds: [groupId], key: 'welcome', value: true }); await sendGroupMsg(ctx, groupId, '✅ Welcome: BẬT'); return { handled: true }; }
                    if (sub === 'welcome-off') { await applyToggleSetting({ groupIds: [groupId], key: 'welcome', value: false }); await sendGroupMsg(ctx, groupId, '✅ Welcome: TẮT'); return { handled: true }; }
                    if (sub === 'follow-on' || sub === 'tracking-on') { await applyToggleSetting({ groupIds: [groupId], key: 'follow', value: true }); await sendGroupMsg(ctx, groupId, '✅ Follow (theo dõi nhóm): BẬT\n📋 Ghi lịch sử chat + memory cho group này.'); return { handled: true }; }
                    if (sub === 'follow-off' || sub === 'tracking-off') { await applyToggleSetting({ groupIds: [groupId], key: 'follow', value: false }); await sendGroupMsg(ctx, groupId, '✅ Follow (theo dõi nhóm): TẮT'); return { handled: true }; }
                    if (sub === 'status') {
                        const muted = store.getSetting(groupId, 'muted', false);
                        const silent = store.getSetting(groupId, 'silent', true);
                        const welcome = store.getSetting(groupId, 'welcome', true);
                        const follow = isFollowOn(groupId);
                        await sendGroupMsg(ctx, groupId,
                            `⚙️ CẤU HÌNH BOT\n━━━━━━━━━━━━━━━━━━\n🔇 Mute: ${muted ? 'BẬT (bot im lặng hoàn toàn)' : 'TẮT'}\n🔕 Silent Mode: ${silent ? 'BẬT' : 'TẮT'}\n🎉 Welcome: ${welcome ? 'BẬT' : 'TẮT'}\n👁️ Follow (ghi lịch sử+memory): ${follow ? 'BẬT' : 'TẮT'}`
                        );
                        return { handled: true };
                    }
                    // Fallback: sub-command không nhận ra → báo lỗi thay vì nuốt im lặng
                    await sendGroupMsg(ctx, groupId, `⚠️ Lệnh ${cmdPrefix}rules ${sub} không hợp lệ.\nGõ ${cmdPrefix}rules để xem danh sách lệnh.`);
                    return { handled: true };
                }

                // /memory [text] — lưu tri thức vào memory nhóm (agent đọc khi trả lời)
                if (command === '/memory') {
                    if (!canRunCmd('memory', senderId, groupId, senderName)) return { handled: true };
                    const memText = (textBefore || args.join(' ')).replace(/\s{2,}/g, ' ').trim();
                    if (!memText) { await sendGroupMsg(ctx, groupId, '🧠 Cú pháp: /memory <điều bot cần ghi nhớ lâu dài>'); return { handled: true }; }
                    const res = await addGroupMemory(groupId, senderId, senderName, memText);
                    if (res?.duplicate) {
                        await sendGroupMsg(ctx, groupId, '🧠 Điều này bot đã nhớ rồi nha.');
                    } else {
                        await sendGroupMsg(ctx, groupId, `🧠 Đã lưu vào trí nhớ nhóm: ${memText}`);
                    }
                    return { handled: true };
                }

                // /history [ngày] — tổng hợp lịch sử chat ngày đó bằng AI
                if (command === '/history') {
                    if (!canRunCmd('history', senderId, groupId, senderName)) return { handled: true };
                    const date = parseHistoryDate(args[0] || textBefore);
                    await sendGroupMsg(ctx, groupId, `⏳ Đang tổng hợp lịch sử chat ngày ${date}...`);
                    try {
                        const summary = await generateDailySummary(groupId, date, { by: 'history-cmd' });
                        await sendGroupMsg(ctx, groupId, formatSummaryText(summary));
                    } catch (e) {
                        logger.error(`[openclaw-zalo-mod] /history failed: ${e.message}`);
                        await sendGroupMsg(ctx, groupId, `⚠️ Lỗi khi tổng hợp: ${e.message}`);
                    }
                    return { handled: true };
                }


                // Unknown slash — block from LLM (prevent error replies)
                return { handled: true };
            }

            // ── @Mention check — let through to LLM ──────────────
            const isMention = isMessageMentioningBot(event, botNames, profile);
            if (isMention) {
                // Log mention + sync to memory
                logger.info(`[openclaw-zalo-mod] @mention from ${senderName} in group ${groupId}: ${content.slice(0, 80)}`);
                await appendToMemoryFile(groupId, 'chat-highlights.md', `| ${nowShort()} | ${senderName} | ${content.slice(0, 80)} |`);

                // Tracking: ghi cả @mention vào chat-log
                if (isFollowOn(groupId)) {
                    await appendChatLog(groupId, senderName, content, senderId);
                }

                // ── File context injection ─────────────────────────────
                // Group attachments are not present in this inbound text event. When user
                // @mentions bot about a file/image, inject a system note so the LLM
                // knows to ask for a link instead of hallucinating "chưa thấy file".
                const FILE_KEYWORDS_RE = /\b(file|pdf|ảnh|hình\s*ảnh|tài\s*liệu|doc|docx|xlsx?|excel|video|mp4|zip|rar|link|tải|download|attachment|đính\s*kèm|xem\s*file|đọc\s*file)\b/i;
                if (FILE_KEYWORDS_RE.test(content)) {
                    const note = '\n[BOT SYSTEM NOTE: Đây là Group Zalo. File/ảnh đính kèm KHÔNG được forward tới bot trong group — Zalo Connect channel chỉ truyền text. Nếu user đang đề cập tới file, hãy hỏi user: (1) copy+paste link tải về, hoặc (2) paste nội dung text trực tiếp vào chat. KHÔNG nói "gửi file vào đây" vì user đã gửi rồi mà bot không nhận được.]';
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
                        await sendGroupMsg(ctx, groupId, `👑 Chưa ghi nhận admin nào. Người tạo group gõ ${cmdPrefix}rules groupid để đăng ký.`);
                    }
                    return { handled: true };
                }

                // Z2: đóng băng danh tính lượt này TRƯỚC khi cho lên LLM —
                // TurnContext bất biến, reply sẽ correlate FIFO đúng người tag
                // (diệt bug A/B cross-tag do state mutable theo group/session).
                zEngine.openTurn({
                    accountId: ctx?.accountId,
                    conversationId: rawConvId,
                    groupId,
                    messageId: event?.msgId ?? event?.messageId ?? event?.cliMsgId,
                    senderId,
                    senderName,
                    timestamp: Number(event?.timestamp) || Date.now(),
                    quote: event?.quote ? {
                        messageId: event.quote.globalMsgId ?? event.quote.messageId,
                        senderId: event.quote.ownerId ?? event.quote.senderId,
                    } : undefined,
                });

                // For all other @mention questions → forward to LLM
                logger.info(`[openclaw-zalo-mod] forwarding to LLM: ${content.slice(0, 80)}`);
                return; // undefined = let LLM handle
            }

            // ── Admin check for violation logging ──────────────────
            const gAdmins = groupNames[groupId]?.admins || getGroupAdmins(groupId) || [];
            const creatorId = groupNames[groupId]?.creatorId;
            const isBotOrOwnerAdmin = currentOwnerId && (gAdmins.map(String).includes(currentOwnerId) || String(creatorId || '') === currentOwnerId);

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
                if (isFollowOn(groupId)) {
                    await appendChatLog(groupId, senderName, content, senderId);
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
            if (isFollowOn(groupId)) {
                await appendChatLog(groupId, senderName, content, senderId);
            }

            // Non-mention, non-slash, non-spam, non-silent → let LLM decide
            return;
        }; // registered below with priority 300, before relay plugin (200)

        // ── Agent tool surface ──────────────────────────────────────────────
        // Slash command là zero-token và LLM không thấy; dashboard thì token-gated.
        // Nên khi owner nhắn "mute nhóm A, nhóm B" bằng lời, LLM không có cách nào
        // ghi state → nó trả lời "đã mute rồi" mà badge dashboard đứng nguyên.
        // 4 tool dưới đây là actuator còn thiếu, và chúng ghi qua ĐÚNG
        // runDashboardAction mà nút dashboard gọi nên không thể lệch hành vi.
        function agentGroupState(gid) {
            const plain = String(gid || '').replace(/^group:/, '');
            const info = groupNames[plain] || {};
            const botCfg = getBotConfig(plain);
            const follow = isFollowOn(plain);
            return {
                groupId: plain,
                name: getGroupName(plain),
                profile: info.profile || 'default',
                botName: botCfg.botName,
                cmdPrefix: botCfg.cmdPrefix,
                muted: store.getSetting(plain, 'muted', false) === true,
                silent: store.getSetting(plain, 'silent', true) !== false,
                welcome: store.getSetting(plain, 'welcome', true) !== false,
                tracking: follow,
                follow,
                pendingAuto: store.getSetting(plain, 'pendingAuto', false) === true,
                autoSummary: store.getSetting(plain, 'autoSummary', false) === true,
                runtimeMode: getZaloConnectRuntimeMode(plain),
            };
        }

        const zaloModToolFactory = createZaloModAgentTools({
            listGroups: async () => { await ensureStore(); return watchGroupIds.map(agentGroupState); },
            getGroupState: agentGroupState,
            runAction: (action, payload) => runDashboardAction(action, payload),
            readHistory: (gid, date) => readChatHistory(gid, date),
            listHistoryDates: (gid) => listChatHistoryDates(gid),
            getNotes: (gid) => getNotes(gid),
            getGroupMemories: (gid) => getGroupMemories(gid),
            getSummary: (gid, date) => getSummary(gid, date),
            generateSummary: (gid, date) => generateDailySummary(gid, date, { by: 'agent-tool' }),
            vnDateStr: (d) => vnDateStr(d),
            // Owner đọc live mỗi lần gọi: owner có thể vừa được ghi qua `im owner`.
            getOwnerIds: () => collectOwnerIds({ ...pluginCfg, ownerId: ownerId || pluginCfg.ownerId }),
            isDestructiveAllowed: () => pluginCfg.agentTools?.allowDestructive === true,
            audit: (entry) => appendDashboardAudit(entry),
            listCommands: () => watchGroupIds.length
                ? listAllCommands(getBotConfig(watchGroupIds[0]).cmdPrefix)
                : listAllCommands(cmdPrefix),
            logger,
        });
        try {
            api.registerTool(zaloModToolFactory, { names: ZALO_MOD_TOOL_NAMES });
            logger.info(`[openclaw-zalo-mod] agent tools registered: ${ZALO_MOD_TOOL_NAMES.join(', ')}`);
        } catch (e) {
            // Host cũ chưa có registerTool → plugin vẫn chạy bình thường, chỉ
            // mất khả năng điều khiển bằng ngôn ngữ tự nhiên.
            logger.warn(`[openclaw-zalo-mod] agent tools unavailable on this host: ${e.message}`);
        }

        // ── Fallback: before_model_resolve + before_agent_reply ─────────────
        // OpenClaw v2026.5.x: runtime plugins cannot register gateway-level hooks.
        // before_dispatch is not fired for runtime plugins. Use agent-session hooks.
        const _adminClaims = globalThis.__zaloModAdminClaims ?? new Map();
        globalThis.__zaloModAdminClaims = _adminClaims;

        api.on('before_model_resolve', async (event, ctx) => {
            if (!isZaloChannel(ctx)) return;
            const conversationId = String(ctx?.conversationId || '');
            const groupId = conversationId.startsWith('group:') ? conversationId.replace(/^group:/, '') : '';
            if (groupId && typeof event?.prompt === 'string') {
                const modePrompt = buildActiveModePrompt(groupId);
                if (modePrompt && !event.prompt.includes('[GROUP MODE CONTEXT]')) {
                    event.prompt = `${modePrompt}\n\n${event.prompt}`;
                }
            }

            // ── Z2: inject bounded passive context (UNTRUSTED) cho lượt group ──
            // Correlate FIFO với TurnContext mở ở before_dispatch; nếu deployment
            // không fire before_dispatch cho runtime plugin → fallback ctx.senderId.
            if (groupId) {
                try {
                    zEngine.injectContext(event, {
                        accountId: ctx?.accountId,
                        conversationId,
                        sessionKey: ctx?.sessionKey,
                        senderId: ctx?.senderId,
                    });
                } catch (e) {
                    logger.warn('[openclaw-zalo-mod] context inject error: ' + e.message);
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
            const botCfg = getBotConfig(ctx?.accountId || groupId || 'default');
            const ownerCmd = botCfg.cmdPrefix + 'owner';
            const ownerIdCmd = botCfg.cmdPrefix + 'ownerid';

            // Z0 security: claim có thể kèm mã one-time — "im owner <MÃ>".
            const claimSrc = [lc, String(event?.prompt || '').toLowerCase().replace(/['’]/g, '').trim()];
            const claimRe = new RegExp(`(?:im owner|i am owner|iam owner|im admin|${ownerCmd.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}|${ownerIdCmd.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')})(?:\\s+([a-z0-9-]+))?\\s*$`, 'i');
            let matched = false;
            let suppliedCode = '';
            for (const src of claimSrc) {
                const m = src.match(claimRe);
                if (m) { matched = true; suppliedCode = (m[1] || '').trim(); break; }
            }

            if (!matched) return;
            const sKey = ctx?.sessionKey || 'default';
            const sId = String(ctx?.senderId || '');
            logger.info('[openclaw-zalo-mod] [OWNER-FALLBACK] im owner from ' + sId + ' sKey=' + sKey);
            _adminClaims.set(sKey, { senderId: sId, code: suppliedCode, ts: Date.now() });
        });
        api.on('before_dispatch', handleZaloDispatch, { priority: 300 });

        api.on('before_agent_reply', async (event, ctx) => {
            if (!isZaloChannel(ctx)) return;

            // ── Z2: đóng TurnContext của lượt vừa reply (FIFO correlation) ──
            try {
                const _convId = String(ctx?.conversationId || '');
                if (_convId) {
                    zEngine.completeTurn({
                        accountId: ctx?.accountId,
                        conversationId: _convId,
                        sessionKey: ctx?.sessionKey,
                        replyText: typeof event?.reply === 'string' ? event.reply
                            : (typeof event?.text === 'string' ? event.text : ''),
                    });
                }
            } catch { /* correlation best-effort — không chặn reply */ }

            const sKey = ctx?.sessionKey || 'default';
            const claim = _adminClaims.get(sKey);
            if (!claim || Date.now() - claim.ts > 60000) { _adminClaims.delete(sKey); return; }
            _adminClaims.delete(sKey);
            const { senderId } = claim;
            logger.info('[openclaw-zalo-mod] [OWNER-FALLBACK] intercepting reply for ' + senderId);
            const profile = ctx?.accountId || 'default';
            try {
                const botCfg = getBotConfig(profile);
                const botOwnerId = botCfg.ownerId || (profile === 'default' ? ownerId : '');
                if (!botOwnerId) {
                    // Fallback path enforces the same persistent Device ID proof.
                    if (!matchesOwnerClaimDeviceId(claim.code, getDeviceId())) {
                        logger.warn(`[openclaw-zalo-mod] [OWNER-FALLBACK] claim từ ${senderId} bị TỪ CHỐI — thiếu/sai Device ID.`);
                        await sendDmMsg(ctx, senderId,
                            '🔒 Đăng ký Owner cần Device ID.\nMở Zalo Mod Dashboard → Cài đặt, copy Device ID rồi gửi:\n\nim owner <DEVICE_ID>');
                        return { handled: true };
                    }
                    const bName = botCfg.botName || 'Bot';
                    const slashPrefix = bName.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'bot';
                    const botPatch = {
                        botName: bName,
                        zaloDisplayNames: botCfg.botNames.filter(n => n !== bName),
                        slashPrefix: slashPrefix,
                        ownerId: senderId
                    };
                    let patched = false;
                    if (profile && profile !== 'default') {
                        const patch = {
                            bots: {
                                ...pluginCfg.bots,
                                [profile]: botPatch
                            }
                        };
                        await savePluginConfig(patch);
                        patched = true;
                    } else {
                        const patch = {
                            bots: {
                                ...pluginCfg.bots,
                                default: botPatch
                            },
                            ownerId: senderId
                        };
                        const res = await _patchOpenclawConfig(_openclawHome, { ownerId: senderId }, logger, true);
                        await savePluginConfig(patch);
                        patched = res.patched || true;
                    }
                    await sendDmMsg(ctx, senderId, patched ? [
                        '🎉 ĐĂNG KÝ OWNER THÀNH CÔNG',
                        '━━━━━━━━━━━━━━━━━━━━',
                        `🆔 Owner ID:  ${senderId}`,
                        '',
                        '✅ Bạn giờ có toàn quyền quản trị bot.',
                        '🔄 Khởi động lại gateway để áp dụng đầy đủ.',
                    ].join('\n') : [
                        '⚠️ CHƯA GHI ĐƯỢC CẤU HÌNH',
                        '━━━━━━━━━━━━━━━━━━━━',
                        `Thêm thủ công: "ownerId": "${senderId}"`,
                    ].join('\n'));
                } else {
                    await sendDmMsg(ctx, senderId, [
                        '👑 THÔNG TIN OWNER',
                        '━━━━━━━━━━━━━━━━━━━━',
                        `🆔 Owner ID:  ${botOwnerId}`,
                        '',
                        String(botOwnerId) === String(senderId)
                            ? '✅ Chính là bạn — bot đã có chủ sở hữu.'
                            : 'ℹ️ Bot đã có chủ sở hữu, không thể đăng ký lại.',
                    ].join('\n'));
                }
            } catch (e) { logger.error('[openclaw-zalo-mod] [OWNER-FALLBACK] error: ' + e.message); }
            return { handled: true };
        });
        // First install receives a server-signed trial; existing activations refresh.
        ensureTrialIfFirstInstall()
            .then(() => refreshEntitlementIfNeeded(false))
            .catch((e) => logger.warn('[openclaw-zalo-mod] startup entitlement refresh failed: ' + e.message));

        // Start member watcher for welcome messages
        startMemberWatcher();

        // Start scheduler báo cáo tổng hợp cuối ngày
        startReportScheduler();
        rehydrateReminderTimers(); // khôi phục timer chính xác cho lời nhắc once còn treo

        logger.info(`[openclaw-zalo-mod] loaded — bot="${botName}" prefix="${cmdPrefix}" owner=${ownerId || 'none'} groups=${watchGroupIds.length} groupNames=${Object.keys(groupNames).length}`);
    },
});

export default plugin;
