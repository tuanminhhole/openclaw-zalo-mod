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
| **Sticker Detection** | 0 | Transform raw sticker JSON to `[Sticker]` for agent |
| **@Mention** | ✅ uses tokens | Forward to LLM only for real questions |

## 🏗️ Architecture

```
Incoming Zalo message
    │
    ├─ /slash command     → Plugin handles locally (0 tokens)
    ├─ Spam detected      → Log + block silently (0 tokens)
    ├─ Sticker/media      → Transform to [Sticker] (0 tokens)
    ├─ "Who's warned?"    → Plugin answers from store (0 tokens)
    │
    └─ @BotName question  → Forward to LLM agent (uses tokens)
```

## 📦 Installation

### From ClawHub (recommended)

```bash
openclaw plugins install zalo-mod
```

### Manual

1. Copy the plugin to your `extensions/` directory:

```bash
# Windows
xcopy /E /I openclaw-zalo-mod %OPENCLAW_HOME%\extensions\zalo-mod

# Linux / macOS
cp -r openclaw-zalo-mod ~/.openclaw/extensions/zalo-mod
```

2. Restart the gateway:

```bash
openclaw gateway restart
```

## 🛑 Anti-Spam Detection

| Type | Detection |
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
