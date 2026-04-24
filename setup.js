#!/usr/bin/env node
/**
 * openclaw-zalo-mod — Post-Install Setup Script
 * ───────────────────────────────────────────────
 * Run this AFTER copying the extension into your extensions/ directory.
 *
 * Usage:
 *   node setup.js
 *   node setup.js --openclaw-home "D:\bot\.openclaw"
 *   node setup.js --non-interactive
 *
 * What it does:
 *   1. Detects OPENCLAW_HOME (from args, env, or directory structure)
 *   2. Detects Docker vs Native deployment mode
 *   3. Prompts for plugin config (groupName, botName, zaloDisplayNames, adminIds)
 *   4. Backs up openclaw.json
 *   5. Patches openclaw.json with zalo-mod plugin entries
 *   6. Creates data/ directory for plugin storage
 *
 * @author Kent x Williams
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── ANSI colors ──────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(msg) { console.log(msg); }
function ok(msg) { log(`${C.green}✅ ${msg}${C.reset}`); }
function warn(msg) { log(`${C.yellow}⚠️  ${msg}${C.reset}`); }
function err(msg) { log(`${C.red}❌ ${msg}${C.reset}`); }
function info(msg) { log(`${C.cyan}ℹ️  ${msg}${C.reset}`); }
function header(msg) { log(`\n${C.bold}${C.magenta}═══ ${msg} ═══${C.reset}\n`); }

// ── CLI args ─────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1] || '';
}
const isNonInteractive = args.includes('--non-interactive') || args.includes('--silent');

// ── Readline helper ──────────────────────────────────────────
function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    ask(question, defaultVal = '') {
      const hint = defaultVal ? ` ${C.dim}(${defaultVal})${C.reset}` : '';
      return new Promise((resolve) => {
        rl.question(`${C.cyan}? ${C.reset}${question}${hint}: `, (answer) => {
          resolve(answer.trim() || defaultVal);
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

// ── Detect OPENCLAW_HOME ─────────────────────────────────────
function detectOpenclawHome() {
  // 1. From --openclaw-home arg
  const argHome = getArg('openclaw-home');
  if (argHome && fs.existsSync(argHome)) {
    info(`OPENCLAW_HOME from --openclaw-home: ${argHome}`);
    return path.resolve(argHome);
  }

  // 2. From environment variable
  if (process.env.OPENCLAW_HOME && fs.existsSync(process.env.OPENCLAW_HOME)) {
    info(`OPENCLAW_HOME from env: ${process.env.OPENCLAW_HOME}`);
    return path.resolve(process.env.OPENCLAW_HOME);
  }

  // 3. From directory structure: if script is at extensions/zalo-mod/setup.js
  //    then OPENCLAW_HOME = ../../ (the .openclaw directory)
  const parentOfExtensions = path.resolve(__dirname, '..', '..');
  const configPath = path.join(parentOfExtensions, 'openclaw.json');
  if (fs.existsSync(configPath)) {
    info(`OPENCLAW_HOME detected from directory structure: ${parentOfExtensions}`);
    return parentOfExtensions;
  }

  // 4. Common locations
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const commonPaths = [
    path.join(homeDir, '.openclaw'),
    // Windows common paths
    'D:\\bot\\.openclaw',
    'C:\\bot\\.openclaw',
    'D:\\SecondBrain\\.openclaw',
    // Linux/Docker
    '/root/.openclaw',
    '/home/bot/.openclaw',
  ];
  for (const p of commonPaths) {
    if (p && fs.existsSync(path.join(p, 'openclaw.json'))) {
      info(`OPENCLAW_HOME found at common location: ${p}`);
      return p;
    }
  }

  return null;
}

// ── Detect Docker vs Native ──────────────────────────────────
function detectDeployMode(openclawHome) {
  // Check if running inside Docker
  const isDocker =
    fs.existsSync('/.dockerenv') ||
    (fs.existsSync('/proc/1/cgroup') && fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'));

  if (isDocker) {
    return 'docker';
  }

  // Check if the path looks like a Docker mount (WSL-style /mnt/ path)
  try {
    const configRaw = fs.readFileSync(path.join(openclawHome, 'openclaw.json'), 'utf8');
    const config = JSON.parse(configRaw);
    const workspace = config?.agents?.defaults?.workspace || '';
    if (workspace.startsWith('/mnt/')) {
      return 'docker';
    }
  } catch {
    // ignore
  }

  // Check OS
  if (process.platform === 'win32') return 'windows-native';
  if (process.platform === 'darwin') return 'macos-native';
  return 'linux-native';
}

// ── Convert Windows path to Docker mount path ────────────────
function toDockerPath(winPath) {
  // D:\bot\.openclaw\extensions\zalo-mod → /mnt/d/bot/.openclaw/extensions/zalo-mod
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):(.*)/);
  if (match) {
    return `/mnt/${match[1].toLowerCase()}${match[2]}`;
  }
  return normalized;
}

// ── Build installPath based on deployment mode ───────────────
function buildInstallPath(openclawHome, deployMode) {
  const extensionDir = path.join(openclawHome, 'extensions', 'zalo-mod');
  if (deployMode === 'docker') {
    return toDockerPath(extensionDir);
  }
  return extensionDir;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  header('🛡️ zalo-mod — Post-Install Setup');
  log(`${C.dim}Tự động cấu hình plugin zalo-mod cho OpenClaw${C.reset}`);
  log(`${C.dim}Auto-configure zalo-mod plugin for OpenClaw${C.reset}\n`);

  // ── Step 1: Detect OPENCLAW_HOME ─────────────────────────
  let openclawHome = detectOpenclawHome();
  if (!openclawHome) {
    const prompt = createPrompt();
    const manualPath = await prompt.ask(
      'Không tìm thấy OPENCLAW_HOME. Nhập đường dẫn thư mục .openclaw',
      ''
    );
    prompt.close();
    if (manualPath && fs.existsSync(manualPath)) {
      openclawHome = path.resolve(manualPath);
    } else {
      err('Không tìm thấy thư mục .openclaw. Hãy chạy lại với --openclaw-home "path"');
      process.exit(1);
    }
  }

  const configPath = path.join(openclawHome, 'openclaw.json');
  if (!fs.existsSync(configPath)) {
    err(`Không tìm thấy openclaw.json tại: ${configPath}`);
    err('Hãy chạy OpenClaw Setup trước, sau đó chạy lại script này.');
    process.exit(1);
  }

  // ── Step 2: Detect deploy mode ───────────────────────────
  const deployMode = detectDeployMode(openclawHome);
  ok(`Deploy mode: ${deployMode}`);

  const installPath = buildInstallPath(openclawHome, deployMode);
  ok(`Install path: ${installPath}`);

  // ── Step 3: Read current config ──────────────────────────
  let config;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(raw);
  } catch (e) {
    err(`Lỗi đọc openclaw.json: ${e.message}`);
    process.exit(1);
  }

  // Check if zalo-mod is already configured
  const alreadyConfigured = config?.plugins?.entries?.['zalo-mod']?.enabled === true;
  if (alreadyConfigured) {
    warn('Plugin zalo-mod đã được cấu hình trong openclaw.json!');
    const prompt = createPrompt();
    const overwrite = await prompt.ask('Ghi đè config cũ? (y/n)', 'n');
    prompt.close();
    if (overwrite.toLowerCase() !== 'y') {
      info('Giữ nguyên config cũ. Thoát.');
      process.exit(0);
    }
  }

  // ── Step 4: Interactive prompts ──────────────────────────
  let pluginConfig;

  if (isNonInteractive) {
    pluginConfig = {
      groupName: 'My Group',
      botName: 'Bot',
      zaloDisplayNames: [],
      adminIds: [],
      welcomeEnabled: true,
      spamRepeatN: 3,
      spamWindowSeconds: 300,
    };
    info('Non-interactive mode: dùng config mặc định');
  } else {
    const prompt = createPrompt();

    header('📝 Cấu hình Plugin');
    log(`${C.dim}Nhấn Enter để dùng giá trị mặc định${C.reset}\n`);

    const groupName = await prompt.ask(
      'Tên nhóm Zalo (hiện trong templates & memory)',
      'Vọc Tech Không Cọc'
    );
    const botName = await prompt.ask(
      'Tên bot (hiện trong menu)',
      'Williams'
    );
    const zaloNamesRaw = await prompt.ask(
      'Tên hiển thị Zalo của bot (cách nhau bởi dấu phẩy, dùng để detect @mention)',
      ''
    );
    const adminIdsRaw = await prompt.ask(
      'Zalo user IDs admin (cách nhau bởi dấu phẩy, bỏ trống = tất cả)',
      ''
    );
    const welcomeRaw = await prompt.ask(
      'Bật chào mừng member mới? (y/n)',
      'y'
    );
    const watchGroupIdsRaw = await prompt.ask(
      'Group IDs để theo dõi member mới (cách nhau bởi dấu phẩy, bỏ trống nếu chưa biết)',
      ''
    );

    prompt.close();

    const zaloDisplayNames = zaloNamesRaw
      ? zaloNamesRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const adminIds = adminIdsRaw
      ? adminIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const watchGroupIds = watchGroupIdsRaw
      ? watchGroupIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    pluginConfig = {
      groupName,
      botName,
      zaloDisplayNames,
      welcomeEnabled: welcomeRaw.toLowerCase() !== 'n',
      spamRepeatN: 3,
      spamWindowSeconds: 300,
    };
    if (adminIds.length > 0) pluginConfig.adminIds = adminIds;
    if (watchGroupIds.length > 0) {
      pluginConfig.watchGroupIds = watchGroupIds;
      pluginConfig.welcomePollSeconds = 30;
    }
  }

  // ── Step 5: Backup openclaw.json ─────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = `${configPath}.bak-${timestamp}`;
  try {
    fs.copyFileSync(configPath, backupPath);
    ok(`Backup: ${path.basename(backupPath)}`);
  } catch (e) {
    warn(`Không backup được: ${e.message}`);
  }

  // ── Step 6: Patch openclaw.json ──────────────────────────
  // 6a. plugins.allow — add "zalo-mod" if missing
  config.plugins = config.plugins || {};
  config.plugins.allow = config.plugins.allow || [];
  if (!config.plugins.allow.includes('zalo-mod')) {
    config.plugins.allow.push('zalo-mod');
  }
  // Also ensure "zalouser" is in allow list (required for Zalo channel)
  if (!config.plugins.allow.includes('zalouser')) {
    config.plugins.allow.push('zalouser');
  }

  // 6b. plugins.entries — add/overwrite zalo-mod config
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries['zalo-mod'] = {
    enabled: true,
    config: pluginConfig,
  };

  // Ensure zalouser plugin is enabled
  if (!config.plugins.entries.zalouser) {
    config.plugins.entries.zalouser = { enabled: true };
  }

  // 6c. plugins.installs — add zalo-mod with correct path
  config.plugins.installs = config.plugins.installs || {};
  config.plugins.installs['zalo-mod'] = {
    source: 'path',
    installPath: installPath,
    version: '1.2.0',
    installedAt: new Date().toISOString(),
  };

  // 6d. Ensure zalouser channel is configured
  config.channels = config.channels || {};
  if (!config.channels.zalouser) {
    config.channels.zalouser = {
      enabled: true,
      defaultAccount: 'default',
      dmPolicy: 'open',
      allowFrom: ['*'],
      groupPolicy: 'allowlist',
      groupAllowFrom: ['*'],
      historyLimit: 50,
      groups: {
        '*': {
          enabled: true,
          requireMention: false,
        },
      },
    };
    ok('Đã thêm cấu hình channel zalouser');
  }

  // ── Step 7: Write patched config ─────────────────────────
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    ok(`Đã cập nhật: ${configPath}`);
  } catch (e) {
    err(`Lỗi ghi openclaw.json: ${e.message}`);
    err(`Khôi phục backup: cp "${backupPath}" "${configPath}"`);
    process.exit(1);
  }

  // ── Step 8: Create data directory ────────────────────────
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    ok(`Đã tạo thư mục data/`);
  } else {
    ok(`Thư mục data/ đã tồn tại`);
  }

  // ── Done ─────────────────────────────────────────────────
  header('✅ Setup Hoàn Tất!');
  log(`${C.green}Plugin zalo-mod đã được cấu hình thành công.${C.reset}\n`);

  log(`${C.bold}Config đã lưu:${C.reset}`);
  log(`  📁 ${configPath}`);
  log(`  💾 Backup: ${path.basename(backupPath)}\n`);

  log(`${C.bold}Plugin config:${C.reset}`);
  log(`  📋 Group: ${pluginConfig.groupName}`);
  log(`  🤖 Bot: ${pluginConfig.botName}`);
  log(`  👤 Zalo names: ${(pluginConfig.zaloDisplayNames || []).join(', ') || '(chưa đặt)'}`);
  log(`  🔑 Admin IDs: ${(pluginConfig.adminIds || []).join(', ') || '(tất cả)'}`);
  log(`  🎉 Welcome: ${pluginConfig.welcomeEnabled ? 'BẬT' : 'TẮT'}`);
  if (pluginConfig.watchGroupIds) {
    log(`  👀 Watch groups: ${pluginConfig.watchGroupIds.join(', ')}`);
  }

  log(`\n${C.bold}Bước tiếp theo:${C.reset}`);
  log(`  1. ${C.cyan}Đăng nhập Zalo (nếu chưa):${C.reset}`);
  log(`     openclaw channels login --channel zalouser --verbose`);
  log(`  2. ${C.cyan}Khởi động lại gateway:${C.reset}`);
  log(`     openclaw gateway run`);
  log(`  3. ${C.cyan}Lấy Group ID (gõ trong group Zalo):${C.reset}`);
  log(`     /groupid`);
  log(`  4. ${C.cyan}Sửa config nếu cần:${C.reset}`);
  log(`     Mở ${configPath}`);
  log(`     Thêm Group ID vào "watchGroupIds" để bật welcome message\n`);

  log(`${C.dim}Tài liệu: https://github.com/tuanminhhole/openclaw-zalo-mod${C.reset}`);
}

main().catch((e) => {
  err(`Setup thất bại: ${e.message}`);
  process.exit(1);
});
