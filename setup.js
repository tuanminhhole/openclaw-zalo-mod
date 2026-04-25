#!/usr/bin/env node
/**
 * openclaw-zalo-mod — Post-Install Setup Script
 * ───────────────────────────────────────────────
 * Run this AFTER copying the extension into your extensions/ directory.
 *
 * Usage:
 *   node setup.js
 *   node setup.js --openclaw-home "D:\bot\.openclaw"
 *   node setup.js --host-project-root "D:\bot"
 *   node setup.js --host-project-root "..\.." --container-project-root "/mnt/project"
 *   node setup.js --non-interactive
 *
 * What it does:
 *   1. Detects OPENCLAW_HOME (from args, env, or directory structure)
 *   2. Detects Docker vs Native deployment mode
 *   3. Prompts for plugin config (groupName, botName, zaloDisplayNames, adminIds)
 *   4. Backs up openclaw.json
 *   5. Patches openclaw.json with zalo-mod plugin entries and load path
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
const DEFAULT_DOCKER_INSTALL_PATH = '/opt/openclaw/extensions/zalo-mod';

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1] || '';
}
const isNonInteractive = args.includes('--non-interactive') || args.includes('--silent');

function getHostProjectRoot(openclawHome) {
  const explicitRoot = getArg('host-project-root') || process.env.OPENCLAW_HOST_PROJECT_ROOT;
  if (explicitRoot) {
    return explicitRoot;
  }
  return path.resolve(openclawHome, '..');
}

function getContainerProjectRoot() {
  const explicitRoot = getArg('container-project-root') || process.env.OPENCLAW_CONTAINER_PROJECT_ROOT;
  if (!explicitRoot) {
    return null;
  }
  return explicitRoot.replace(/\/+$/, '');
}

function toDockerMntPath(hostPath) {
  const normalized = hostPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const driveMatch = normalized.match(/^([A-Z]):\/(.+)$/i);
  if (!driveMatch) {
    return null;
  }
  const driveLetter = driveMatch[1].toLowerCase();
  const restPath = driveMatch[2];
  return `/mnt/${driveLetter}/${restPath}`;
}

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
  // Check if running inside Docker container
  const isInsideDocker =
    fs.existsSync('/.dockerenv') ||
    (fs.existsSync('/proc/1/cgroup') && fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'));

  if (isInsideDocker) {
    return 'docker';
  }

  // Check if this is a Docker Compose project (running setup on Windows host)
  const projectRoot = path.resolve(openclawHome, '..');
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

  // 1. Check project root for compose files
  const hasComposeAtRoot = composeFiles.some(f => fs.existsSync(path.join(projectRoot, f)));
  if (hasComposeAtRoot) return 'docker-compose';

  // 2. Check common subdirectories (docker/*, docker/openclaw, etc.)
  try {
    const subdirs = [
      'docker', 'docker/openclaw', '.docker',
      'deploy', 'infra', 'compose',
    ];
    for (const sub of subdirs) {
      const subPath = path.join(projectRoot, sub);
      if (fs.existsSync(subPath) && composeFiles.some(f => fs.existsSync(path.join(subPath, f)))) {
        return 'docker-compose';
      }
    }
    // 3. Also scan any immediate child directories for compose files
    const children = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.')) continue;
      const childPath = path.join(projectRoot, child.name);
      if (composeFiles.some(f => fs.existsSync(path.join(childPath, f)))) {
        return 'docker-compose';
      }
      // Also check one level deeper (e.g., docker/openclaw/)
      try {
        const grandchildren = fs.readdirSync(childPath, { withFileTypes: true });
        for (const gc of grandchildren) {
          if (!gc.isDirectory()) continue;
          const gcPath = path.join(childPath, gc.name);
          if (composeFiles.some(f => fs.existsSync(path.join(gcPath, f)))) {
            return 'docker-compose';
          }
        }
      } catch { /* ignore permission errors */ }
    }
  } catch { /* ignore */ }

  // 4. Check if the workspace path in config uses Docker-style paths
  try {
    const configRaw = fs.readFileSync(path.join(openclawHome, 'openclaw.json'), 'utf8');
    const config = JSON.parse(configRaw);
    const workspace = config?.agents?.defaults?.workspace || '';
    if (workspace.startsWith('/mnt/') || workspace.startsWith('/root/')) {
      return 'docker-compose';
    }
    // Check gateway port — non-standard port may indicate Docker
    const port = config?.gateway?.port;
    if (port && port !== 19789) {
      // Different from default suggests Docker port mapping
    }
  } catch {
    // ignore
  }

  // Check OS
  if (process.platform === 'win32') return 'windows-native';
  if (process.platform === 'darwin') return 'macos-native';
  return 'linux-native';
}

// ── Build installPath based on deployment mode ───────────────
// Docker Compose pattern:
//   Install the plugin into the image/container filesystem:
//   /opt/openclaw/extensions/zalo-mod
// Windows bind mounts commonly show up as mode=777 in Docker, and OpenClaw
// rejects world-writable plugin paths.
function buildInstallPath(openclawHome, deployMode) {
  const explicitInstallPath = getArg('install-path');
  if (explicitInstallPath) {
    return explicitInstallPath;
  }

  if (deployMode === 'docker' || deployMode === 'docker-compose') {
    return DEFAULT_DOCKER_INSTALL_PATH;
  }
  return path.join(openclawHome, 'extensions', 'zalo-mod');
}

function isLikelyWorldWritableDockerPath(installPath, deployMode) {
  return (
    (deployMode === 'docker' || deployMode === 'docker-compose') &&
    (installPath.startsWith('/root/project/.openclaw/') ||
      installPath.includes('/.openclaw/extensions/'))
  );
}

function isDefaultDockerInstallPath(installPath, deployMode) {
  return (
    (deployMode === 'docker' || deployMode === 'docker-compose') &&
    installPath === DEFAULT_DOCKER_INSTALL_PATH
  );
}

// ── Docker Compose volume mount instructions ─────────────────
// Returns the volume mount line the user needs to add to docker-compose.yml
function getDockerVolumeMountInstruction(openclawHome) {
  const hostPath = getHostProjectRoot(openclawHome).replace(/\\/g, '/').replace(/\/+$/, '');
  const containerPath = getContainerProjectRoot() || toDockerMntPath(hostPath);
  if (containerPath) {
    return {
      hostPath,
      containerPath,
      volumeLine: `      - ${hostPath}:${containerPath}`,
    };
  }
  return null;
}

// ── SKILL.md template ────────────────────────────────────────
function buildSkillMd(groupName, botName, memoryGroupSlug) {
  return `---
name: Zalo Group Admin
slug: zalo-group-admin
version: 1.0.0
description: Quy tắc reply và quản lý group Zalo — ưu tiên ngắn gọn, súc tích, không dùng markdown trong group chat.
---

# Zalo Group Admin 💬

## Khi nào dùng skill này

Khi \`chat_id\` chứa \`group:\` → Bot đang ở trong Zalo group. Áp dụng toàn bộ quy tắc bên dưới.

---

## ⚡ NGUYÊN TẮC SỐ 1 — NGẮN GỌN LÀ ĐẶC QUYỀN CỦA GROUP

> Trong group chat, **ngắn gọn = tôn trọng**. AI nói dài = spam group.

### Giới hạn cứng (KHÔNG vi phạm):
- **Tối đa 5 dòng** mỗi reply trong group, trừ khi có lệnh rõ ràng cần dài hơn
- **KHÔNG dùng markdown headers** (\`##\`, \`###\`) — Zalo không render, trông ugly
- **KHÔNG dùng bullet list dài** — tối đa 3 bullets nếu cần
- **KHÔNG dùng bold italic** (\`**text**\`) — Zalo không render
- **Chỉ 1 câu hỏi nếu cần làm rõ** — không hỏi "1 trong mấy thứ này: 1. 2. 3. 4."

### Format chuẩn cho group reply:
\`\`\`
[emoji] [nội dung ngắn gọn]

Nếu cần thêm: [1-2 câu bổ sung]
\`\`\`

### Ví dụ XẤU:
\`\`\`
"Nội thất T89 của tôi" còn mơ hồ quá bro.

"Nội thất T89" có thể là mấy kiểu:
- tên công ty / brand của ông
- mã căn hộ / nhà mẫu T89
...
\`\`\`
→ **QUÁ DÀI, dùng markdown không render, hỏi nhiều cái một lúc**

### Ví dụ TỐT:
\`\`\`
T89 là thương hiệu nội thất của bác hay đang hỏi về căn hộ T89?
\`\`\`
→ 1 câu hỏi duy nhất, rõ ràng.

---

## 📖 Đọc Group Memory Trước Khi Reply

Khi @mention trong group "${groupName}":
1. Đọc \`~/skills/memory/zalo-groups/${memoryGroupSlug}/INDEX.md\`
2. Kiểm tra \`chat-highlights.md\` xem context gần nhất
3. Nếu user từng mention trước → reference lại, không hỏi lại

**Path:** \`~/skills/memory/zalo-groups/${memoryGroupSlug}/\`

---

## 🔍 Khi Cần Tìm Kiếm Thông Tin Bên Ngoài

### Quy trình tìm (không announce từng bước):
1. Search + fetch **im lặng** — KHÔNG nhắn "Tui đang tìm hiểu..." rồi stop
2. Tổng hợp xong **MỚI reply** — 1 message ngắn gọn với kết quả
3. Nếu fetch lâu (>10s) → chỉ nhắn 1 dòng: "Để mình check nhanh nha bác"

### Không làm:
- ❌ Reply rỗng (content = "") rồi fetch rồi mới reply thật
- ❌ Nhắn nhiều message liên tiếp trong group
- ❌ Dùng \`##\` headers trong reply group

---

## 🎯 Xưng Hô Trong Group

- Với **member thường**: xưng "mình", gọi "bác" hoặc tên
- Với **câu hỏi kỹ thuật**: trả lời thẳng, không giải thích quá nhiều context
- Với **câu hỏi mơ hồ**: hỏi 1 câu làm rõ — chỉ 1 câu thôi

---

## 📝 Ghi Memory Sau Reply

Sau mỗi @mention được xử lý:
\`\`\`
~/skills/memory/zalo-groups/${memoryGroupSlug}/chat-highlights.md
\`\`\`
Format: \`| YYYY-MM-DD HH:MM | {tên user} | {tóm tắt 1 dòng} |\`

---

## ⏰ Cron Job / System Reminder

Khi nhận \`agentTurn\` từ cron job (payload từ scheduler):
- **Reply tối đa 1-2 dòng** — đây là nhắc nhở, không phải hội thoại
- Format: \`⏰ Nhắc: {nội dung cron}\`
- **KHÔNG elaborate**, KHÔNG thêm "3 bước để làm", KHÔNG hỏi thêm

---

## Tóm Tắt Nhanh

| Ngữ cảnh | Max dòng | Markdown OK? | Hỏi lại |
|----------|----------|--------------| ---------|
| Group @mention | 5 dòng | ❌ Không | 1 câu |
| Group Q&A | 3-5 dòng | ❌ Không | 1 câu |
| Cron reminder | 1-2 dòng | ❌ Không | ❌ Không |
| DM riêng | Tùy | ✅ Có | Thoải mái |
`;
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
  if (isLikelyWorldWritableDockerPath(installPath, deployMode)) {
    warn('Install path nằm trong .openclaw/extensions trên Docker. OpenClaw tự quét thư mục này và có thể block plugin nếu thấy mode=777.');
    warn(`Khuyến nghị: dùng --install-path "${DEFAULT_DOCKER_INSTALL_PATH}" và COPY plugin vào Docker image với chmod 755.`);
  }

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
  if (config.plugins.entries?.browser?.enabled === true && !config.plugins.allow.includes('browser')) {
    config.plugins.allow.push('browser');
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

  // 6c. plugins.load.paths — official discovery path for local plugins
  config.plugins.load = config.plugins.load || {};
  config.plugins.load.paths = Array.isArray(config.plugins.load.paths)
    ? config.plugins.load.paths
    : [];
  if (!config.plugins.load.paths.includes(installPath)) {
    config.plugins.load.paths.push(installPath);
  }

  // Manual setup should not rely on CLI-managed install metadata.
  if (config.plugins.installs?.['zalo-mod']) {
    delete config.plugins.installs['zalo-mod'];
    if (Object.keys(config.plugins.installs).length === 0) {
      delete config.plugins.installs;
    }
  }

  // 6d. Ensure zalouser channel is configured without overwriting existing policies.
  config.channels = config.channels || {};
  if (!config.channels.zalouser) {
    config.channels.zalouser = {
      enabled: true,
      defaultAccount: 'default',
    };
    ok('Đã thêm cấu hình channel zalouser');
  } else {
    config.channels.zalouser.enabled = true;
    config.channels.zalouser.defaultAccount = config.channels.zalouser.defaultAccount || 'default';
  }

  // 6e. Ensure bindings exist — route zalouser messages to an agent
  // Without a binding, OpenClaw won't start the channel provider.
  config.bindings = config.bindings || [];
  const hasZaloBinding = config.bindings.some(
    b => b.match?.channel === 'zalouser'
  );
  if (!hasZaloBinding) {
    // Find the first agent ID from config
    const agentId =
      config.agents?.list?.[0]?.id ||
      config.agents?.defaults?.agentId ||
      'bot';
    config.bindings.push({
      agentId,
      match: { channel: 'zalouser' },
    });
    ok(`Đã thêm binding: channel zalouser → agent "${agentId}"`);
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

  // ── Step 9: Create workspace skills & memory dirs ─────
  // Detect workspace path from config (same logic as index.js runtime)
  const workspaceDir = String(
    config?.agents?.defaults?.workspace ||
    path.join(openclawHome, 'workspace')
  );
  const autoSlug = pluginConfig.groupName
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default-group';
  const memoryGroupSlug = String(pluginConfig.memoryGroupSlug || autoSlug);

  // 9a. Create skills/zalo-group-admin/SKILL.md
  const skillDir = path.join(workspaceDir, 'skills', 'zalo-group-admin');
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    // Only write if not exists (don't overwrite user customizations)
    if (!fs.existsSync(skillMdPath)) {
      const skillContent = buildSkillMd(pluginConfig.groupName, pluginConfig.botName, memoryGroupSlug);
      fs.writeFileSync(skillMdPath, skillContent, 'utf8');
      ok(`Đã tạo: skills/zalo-group-admin/SKILL.md`);
    } else {
      ok(`skills/zalo-group-admin/SKILL.md đã tồn tại (giữ nguyên)`);
    }
  } catch (e) {
    warn(`Không tạo được SKILL.md: ${e.message}`);
  }

  // 9b. Bootstrap memory directory
  const memDir = path.join(workspaceDir, 'skills', 'memory', 'zalo-groups', memoryGroupSlug);
  try {
    fs.mkdirSync(memDir, { recursive: true });
    // Create INDEX.md if not exists
    const indexMdPath = path.join(memDir, 'INDEX.md');
    if (!fs.existsSync(indexMdPath)) {
      fs.writeFileSync(indexMdPath, [
        `# ${pluginConfig.groupName} — Memory`,
        '',
        `> Auto-generated by zalo-mod setup. Plugin sẽ tự cập nhật khi có events.`,
        '',
        '## Files',
        '- `chat-highlights.md` — Log @mention và tương tác quan trọng',
        '- `members.md` — Danh sách member đã warn',
        '- `violations.md` — Log vi phạm (spam, link, emoji flood)',
        '- `admin-notes.md` — Ghi chú admin (/note)',
        '',
      ].join('\n'), 'utf8');
      ok(`Đã tạo: skills/memory/zalo-groups/${memoryGroupSlug}/INDEX.md`);
    } else {
      ok(`Memory directory đã tồn tại (giữ nguyên)`);
    }
  } catch (e) {
    warn(`Không tạo được memory directory: ${e.message}`);
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

  // Docker-specific post-install instructions
  if (deployMode === 'docker' || deployMode === 'docker-compose') {
    const mountInfo = getDockerVolumeMountInstruction(openclawHome);
    log(`\n${C.yellow}${C.bold}⚠️  QUAN TRỌNG (Docker Compose):${C.reset}`);
    if (isDefaultDockerInstallPath(installPath, deployMode)) {
      log(`  Plugin đang được cấu hình để load từ filesystem Linux/container:`);
      log(`  ${C.bold}${installPath}${C.reset}`);
      log(`  ${C.cyan}Thêm vào Dockerfile:${C.reset}`);
      log(`  ${C.bold}COPY extensions/zalo-mod ${DEFAULT_DOCKER_INSTALL_PATH}${C.reset}`);
      log(`  ${C.bold}RUN chmod -R 755 ${DEFAULT_DOCKER_INSTALL_PATH} && mkdir -p ${DEFAULT_DOCKER_INSTALL_PATH}/node_modules && ln -s /usr/local/lib/node_modules/openclaw ${DEFAULT_DOCKER_INSTALL_PATH}/node_modules/openclaw${C.reset}`);
      log(`  ${C.dim}Nếu Dockerfile nằm trong docker/openclaw, build.context nên trỏ về project root D:/bot để COPY thấy thư mục extensions/zalo-mod.${C.reset}`);
    } else if (mountInfo) {
      log(`  Plugin cần volume mount project root vào container.`);
      log(`  ${C.cyan}Thêm dòng sau vào docker-compose.yml (services → ai-bot → volumes):${C.reset}`);
      log(`  ${C.bold}${mountInfo.volumeLine}${C.reset}`);
      log(`  ${C.dim}(Mount project root: ${mountInfo.hostPath} → ${mountInfo.containerPath})${C.reset}`);
    }
    log(`  ${C.yellow}Plugin discovery path trong config (plugins.load.paths): ${installPath}${C.reset}\n`);
    log(`  ${C.yellow}Không dùng bind mount Windows làm installPath cho plugin vì Docker thường báo mode=777.${C.reset}`);
    log(`  ${C.yellow}Nếu còn thư mục /root/project/.openclaw/extensions/zalo-mod cũ, hãy xóa hoặc đổi tên thư mục đó để OpenClaw không tự quét bản bị mode=777.${C.reset}\n`);
  }

  log(`${C.bold}Bước tiếp theo:${C.reset}`);
  if (deployMode === 'docker' || deployMode === 'docker-compose') {
    log(`  1. ${C.cyan}Đảm bảo Dockerfile COPY plugin vào ${DEFAULT_DOCKER_INSTALL_PATH} và chmod 755${C.reset}`);
    log(`  2. ${C.cyan}Rebuild & khởi động lại:${C.reset}`);
    log(`     docker compose up -d --build ai-bot`);
    log(`  3. ${C.cyan}Kiểm tra plugin đã load:${C.reset}`);
    log(`     docker compose logs ai-bot --tail 20 --no-log-prefix`);
    log(`     (Tìm dòng: [zalo-mod] loaded)`);
    log(`  4. ${C.cyan}Lấy Group ID (gõ trong group Zalo):${C.reset}`);
    log(`     /groupid`);
    log(`  5. ${C.cyan}Sửa config nếu cần:${C.reset}`);
    log(`     Mở ${configPath}`);
    log(`     Thêm Group ID vào "watchGroupIds" để bật welcome message\n`);
  } else {
    log(`  1. ${C.cyan}Đăng nhập Zalo (nếu chưa):${C.reset}`);
    log(`     openclaw channels login --channel zalouser --verbose`);
    log(`  2. ${C.cyan}Khởi động lại gateway:${C.reset}`);
    log(`     openclaw gateway run`);
    log(`  3. ${C.cyan}Lấy Group ID (gõ trong group Zalo):${C.reset}`);
    log(`     /groupid`);
    log(`  4. ${C.cyan}Sửa config nếu cần:${C.reset}`);
    log(`     Mở ${configPath}`);
    log(`     Thêm Group ID vào "watchGroupIds" để bật welcome message\n`);
  }

  log(`${C.dim}Tài liệu: https://github.com/tuanminhhole/openclaw-zalo-mod${C.reset}`);
}

main().catch((e) => {
  err(`Setup thất bại: ${e.message}`);
  process.exit(1);
});
