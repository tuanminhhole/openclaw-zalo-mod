#!/usr/bin/env node
/**
 * openclaw-zalo-mod — Minimal Setup Script (v2.0)
 * ─────────────────────────────────────────────────
 * Patches openclaw.json to register the zalo-mod plugin.
 * NO interactive prompts — all config is handled at runtime:
 *   - Bot name & display name: read from IDENTITY.md
 *   - Owner ID: auto-set from first DM sender
 *   - Group list: auto-populated via /groupid slash command
 *   - Welcome/follow toggles: configured via owner DM (/rules)
 *
 * Prerequisites (handled by openclaw-setup wizard, NOT this script):
 *   - zalouser channel configured (channels.zalouser)
 *   - bindings set for zalouser → agent
 *   - memory-core auto-enabled via plugins.slots.memory
 *
 * Usage:
 *   node setup.js
 *   node setup.js --openclaw-home "D:\bot\.openclaw"
 *
 * What it does:
 *   1. Detects OPENCLAW_HOME
 *   2. Backs up openclaw.json
 *   3. Adds "zalo-mod" to plugins.allow (if not present)
 *   4. Adds plugins.entries.zalo-mod with minimal config
 *   5. Creates data/ directory
 *
 * @author Kent x Williams
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── ANSI colors ──────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const log = (m) => console.log(m);
const ok = (m) => log(`${C.green}✅ ${m}${C.reset}`);
const warn = (m) => log(`${C.yellow}⚠️  ${m}${C.reset}`);
const err = (m) => log(`${C.red}❌ ${m}${C.reset}`);
const info = (m) => log(`${C.cyan}ℹ️  ${m}${C.reset}`);
const header = (m) => log(`\n${C.bold}${C.magenta}═══ ${m} ═══${C.reset}\n`);

// ── CLI args ─────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx === -1 ? undefined : (args[idx + 1] || '');
}

// ── Detect OPENCLAW_HOME ─────────────────────────────────────
function detectOpenclawHome() {
  const argHome = getArg('openclaw-home');
  if (argHome && fs.existsSync(argHome)) return path.resolve(argHome);

  const envHome = process.env.OPENCLAW_HOME;
  if (envHome && fs.existsSync(envHome)) return path.resolve(envHome);

  // From directory structure: extensions/zalo-mod/setup.js → ../../
  const parent = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(parent, 'openclaw.json'))) return parent;

  // Common locations
  const home = process.env.HOME || process.env.USERPROFILE || '';
  for (const p of [
    path.join(home, '.openclaw'),
    'D:\\bot\\.openclaw', 'C:\\bot\\.openclaw',
    '/root/.openclaw', '/home/bot/.openclaw',
  ]) {
    if (p && fs.existsSync(path.join(p, 'openclaw.json'))) return p;
  }
  return null;
}

// ── Auto-detect bot name from IDENTITY.md ────────────────────
function detectBotName(openclawHome) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(openclawHome, 'openclaw.json'), 'utf8'));
    const workspaceDirs = [];
    if (config?.agents?.list) {
      for (const a of config.agents.list) {
        if (a.workspace) workspaceDirs.push(a.workspace);
      }
    }
    if (config?.agents?.defaults?.workspace) {
      workspaceDirs.push(config.agents.defaults.workspace);
    }
    for (const ws of workspaceDirs) {
      const idPath = path.join(ws, 'IDENTITY.md');
      if (fs.existsSync(idPath)) {
        const content = fs.readFileSync(idPath, 'utf8');
        const nameMatch = content.match(/\*\*Tên:\*\*\s*(.+)/);
        if (nameMatch) {
          info(`Bot name from IDENTITY.md: ${nameMatch[1].trim()}`);
          return nameMatch[1].trim();
        }
      }
    }
  } catch { /* ignore */ }
  return 'Bot';
}

// ── Main ─────────────────────────────────────────────────────
function main() {
  header('🛡️ zalo-mod v2.0 — Setup');
  log(`${C.dim}Register zalo-mod plugin in openclaw.json${C.reset}`);
  log(`${C.dim}Runtime self-config via /groupid + owner DM${C.reset}\n`);

  // 1. Detect OPENCLAW_HOME
  const openclawHome = detectOpenclawHome();
  if (!openclawHome) {
    err('Không tìm thấy .openclaw directory');
    err('Chạy lại với: node setup.js --openclaw-home "path/to/.openclaw"');
    process.exit(1);
  }
  ok(`OPENCLAW_HOME: ${openclawHome}`);

  const configPath = path.join(openclawHome, 'openclaw.json');
  if (!fs.existsSync(configPath)) {
    err(`Không tìm thấy openclaw.json tại: ${configPath}`);
    process.exit(1);
  }

  // 2. Read config
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    err(`Lỗi đọc openclaw.json: ${e.message}`);
    process.exit(1);
  }

  // Check prerequisite: zalouser channel must be configured
  if (!config?.channels?.zalouser?.enabled) {
    warn('Channel zalouser chưa được cấu hình.');
    warn('Chạy openclaw-setup wizard trước (chọn kênh Zalo Personal).');
    warn('Sau đó chạy lại script này.');
  }

  // Already configured?
  if (config?.plugins?.entries?.['zalo-mod']?.enabled === true) {
    ok('Plugin zalo-mod đã được cấu hình.');
    ok('Dùng /groupid trong group Zalo để quét groups.');
    ok('Dùng DM với bot để cấu hình (follow/welcome toggles).');
    process.exit(0);
  }

  // 3. Auto-detect bot name
  const botName = detectBotName(openclawHome);

  // 4. Backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = `${configPath}.bak-${timestamp}`;
  try {
    fs.copyFileSync(configPath, backupPath);
    ok(`Backup: ${path.basename(backupPath)}`);
  } catch (e) {
    warn(`Không backup được: ${e.message}`);
  }

  // 5. Patch config — ONLY zalo-mod specific
  config.plugins = config.plugins || {};

  // 5a. plugins.allow — add only "zalo-mod"
  config.plugins.allow = config.plugins.allow || [];
  if (!config.plugins.allow.includes('zalo-mod')) {
    config.plugins.allow.push('zalo-mod');
  }

  // 5b. plugins.entries.zalo-mod — minimal config, runtime handles the rest
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries['zalo-mod'] = {
    enabled: true,
    config: {
      botName,
      groupNames: {},
      zaloDisplayNames: [botName],
      welcomeEnabled: true,
      spamRepeatN: 3,
      spamWindowSeconds: 300,
    },
  };

  // 6. Write config
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    ok(`Đã cập nhật: ${configPath}`);
  } catch (e) {
    err(`Lỗi ghi openclaw.json: ${e.message}`);
    process.exit(1);
  }

  // 7. Create data directory
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    ok('Đã tạo thư mục data/');
  }

  // Done
  header('✅ Setup Hoàn Tất!');
  log(`${C.bold}Plugin đã đăng ký. Bước tiếp theo:${C.reset}\n`);
  log(`  1. ${C.cyan}Khởi động lại gateway${C.reset}`);
  log(`  2. ${C.cyan}Gõ /groupid trong group Zalo bất kỳ${C.reset}`);
  log(`     ${C.dim}→ Tự động quét & lưu danh sách groups${C.reset}`);
  log(`  3. ${C.cyan}Cấu hình qua DM với bot:${C.reset}`);
  log(`     /rules welcome <groupId> on/off`);
  log(`     /rules follow <groupId> on/off`);
  log(`     /rules dm-add <tên>`);
  log(`     ${C.dim}→ Owner = người đầu tiên DM bot${C.reset}\n`);
  log(`${C.dim}Docs: https://github.com/tuanminhhole/openclaw-zalo-mod${C.reset}`);
}

main();
