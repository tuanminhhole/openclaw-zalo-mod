# 🛡️ zalo-mod — Zero-Token Zalo Group Moderation

> OpenClaw runtime plugin for Zalo group administration. Handles moderation, slash commands, and anti-spam with **zero LLM token cost**. Only `@mention` queries are forwarded to the AI agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)

**[🇻🇳 Đọc bằng tiếng Việt](./README.vi.md)**

# 🛡️ zalo-mod — Zero-Token Zalo Group Moderation

> OpenClaw runtime plugin for Zalo group administration. Handles moderation, slash commands, and anti-spam with **zero LLM token cost**. Only `@mention` queries are forwarded to the AI agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)

**[🇻🇳 Đọc bằng tiếng Việt](./README.vi.md)**

---

## ✨ Features

| Feature | Token Cost | Description |
|---------|-----------|-------------|
| **Slash Commands** | 0 | `/noi-quy`, `/menu`, `/huong-dan`, `/report`, `/rules` |
| **Warn System** | 0 | `/warn @name [reason]` — track warnings per member |
| **Anti-Spam** | 0 | Auto-detect repeated messages, link spam, emoji flood |
| **Admin Notes** | 0 | `/note [text]` — admin-only notes |
| **Memory Sync** | 0 | `/memory` — save full digest to `skills/memory/` |
| **Smart Q&A** | 0 | Auto-answer "who's warned?" "violations?" from local data |
| **@Mention** | ✅ uses tokens | Forward to LLM only for real questions |

## 🏗️ Architecture

```
Incoming Zalo message
    │
    ├─ /slash command     → Plugin handles locally (0 tokens)
    ├─ Spam detected      → Log + block silently (0 tokens)
    ├─ "Who's warned?"    → Plugin answers from store (0 tokens)
    │
    └─ @BotName question  → Forward to LLM agent (uses tokens)
```

## 📦 Installation

### From ClawHub

```bash
openclaw plugins install clawhub:openclaw-zalo-mod
```

### From npm

```bash
openclaw plugins install openclaw-zalo-mod
```

### Manual

1. Copy the plugin to your `extensions/` directory:

```bash
# Windows
xcopy /E /I openclaw-zalo-mod %OPENCLAW_HOME%\extensions\zalo-mod

# Linux / macOS
cp -r openclaw-zalo-mod ~/.openclaw/extensions/zalo-mod
```

2. Run the auto-setup script (⭐ **recommended**):

```bash
cd ~/.openclaw/extensions/zalo-mod
node setup.js
```

The script will:
- ✅ Auto-detect your `.openclaw` directory
- ✅ Ask for group name, bot name, Zalo display names, admin IDs
- ✅ Auto-detect Docker vs Native for correct install path
- ✅ Backup `openclaw.json` before modifying
- ✅ Patch `openclaw.json` with the correct plugin config
- ✅ Create the `data/` directory for plugin storage

> 💡 **Tip:** If the script can't find `.openclaw`, specify the path:
> ```bash
> node setup.js --openclaw-home "D:\bot\.openclaw"
> ```

> 💡 **Non-interactive mode** (uses default config):
> ```bash
> node setup.js --non-interactive
> ```

> 🐳 **Docker Compose:** on Windows bind mounts, Docker often reports plugin files as `mode=777`, and OpenClaw refuses to load world-writable plugin paths. The stable setup is to COPY the plugin into the image/container filesystem and `chmod 755`.
> ```yaml
> services:
>   ai-bot:
>     build:
>       context: D:/bot
>       dockerfile: docker/openclaw/Dockerfile
>     volumes:
>       - D:/bot/.openclaw:/root/project/.openclaw
> ```
> Add to `Dockerfile`:
> ```dockerfile
> COPY extensions/zalo-mod /opt/openclaw/extensions/zalo-mod
> RUN chmod -R 755 /opt/openclaw/extensions/zalo-mod \
>   && mkdir -p /opt/openclaw/extensions/zalo-mod/node_modules \
>   && ln -s /usr/local/lib/node_modules/openclaw /opt/openclaw/extensions/zalo-mod/node_modules/openclaw
> ```
> Run setup:
> ```bash
> node setup.js --openclaw-home "D:\bot\.openclaw" --install-path "/opt/openclaw/extensions/zalo-mod"
> ```
> This writes `plugins.load.paths: ["/opt/openclaw/extensions/zalo-mod"]`. That is the documented discovery mechanism for a local plugin path; do not rely on hand-written `plugins.installs`.
> If you previously copied the plugin to `.openclaw/extensions/zalo-mod`, delete or rename that old directory; its existence is enough for OpenClaw to scan it and log the warning.

3. Restart the gateway:
|------|-----------|
| **Repeat Spam** | Same message sent N times within the time window |
| **Link Spam** | Messages containing suspicious URLs (bit.ly, tinyurl, affiliate links) |
| **Emoji Flood** | Messages with 5+ consecutive emojis |

Violations are logged to the store and synced to `violations.md`.

## 🤖 Smart Auto-Answer

When someone `@mentions` the bot with common group management questions, zalo-mod answers directly from the local store — no LLM tokens used:

| Question Pattern | Source |
|-----------------|--------|
| "Who's warned?" / "Ai bị warn?" | `store.getWarned()` |
| "Violations?" / "Vi phạm?" | `store.getViolations()` |
| "Who's admin?" / "Admin là ai?" | Config response |

All other `@mention` questions are forwarded to the LLM agent.

## 🔧 Requirements

- OpenClaw `>= 2026.3.24`
- `zalouser` channel configured and authenticated
- Node.js `>= 20`

## 📄 License

MIT — see [LICENSE](./LICENSE)
