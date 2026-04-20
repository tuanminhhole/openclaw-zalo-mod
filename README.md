# 🛡️ ZaloGuard — Zero-Token Zalo Group Moderation

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
openclaw plugins install clawhub:openclaw-zaloguard
```

### From npm

```bash
openclaw plugins install openclaw-zaloguard
```

### Manual

Copy the plugin to your `extensions/` directory:

```bash
cp -r openclaw-zaloguard ~/.openclaw/extensions/
```

## ⚙️ Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "zaloguard": {
        "enabled": true,
        "config": {
          "groupName": "My Awesome Group",
          "botName": "GuardBot",
          "zaloDisplayNames": ["Guard Bot", "Bot Name on Zalo"],
          "adminIds": ["1234567890", "9876543210"],
          "welcomeEnabled": true,
          "spamRepeatN": 3,
          "spamWindowSeconds": 300
        }
      }
    }
  }
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `groupName` | string | `"Nhóm"` | Display name used in templates and memory files |
| `botName` | string | `"Bot"` | Bot name shown in menus |
| `zaloDisplayNames` | string[] | `[]` | Zalo display name aliases for `@mention` detection |
| `adminIds` | string[] | `[]` | Zalo user IDs for admin commands. Empty = all users |
| `welcomeEnabled` | boolean | `true` | Enable welcome message for new members |
| `spamRepeatN` | number | `3` | Repeated messages threshold for spam detection |
| `spamWindowSeconds` | number | `300` | Time window (seconds) for spam repeat detection |
| `memoryGroupSlug` | string | auto | Override memory folder name (auto-generated from `groupName`) |

## 📋 Slash Commands

### Everyone

| Command | Description |
|---------|-------------|
| `/noi-quy` | Show group rules |
| `/menu` | Show all available commands |
| `/huong-dan` | How to use the bot |

### Admin Only

| Command | Description |
|---------|-------------|
| `/warn @name [reason]` | Warn a member (tracked in store + memory) |
| `/note [text]` | Save an admin note |
| `/report` | Show violations report |
| `/memory` | Save full data digest to memory files |
| `/rules` | Bot configuration panel |
| `/rules silent-on/off` | Toggle silent mode |
| `/rules welcome-on/off` | Toggle welcome messages |
| `/rules status` | Show current config |

## 🧠 Memory Integration

ZaloGuard automatically syncs moderation data to markdown files in `skills/memory/zalo-groups/{group-slug}/`:

```
skills/memory/zalo-groups/my-awesome-group/
├── members.md          ← Warn log (auto-sync on /warn)
├── violations.md       ← Spam violations (auto-sync)
├── chat-highlights.md  ← @mention conversations (auto-sync)
└── admin-notes.md      ← Admin notes (auto-sync on /note)
```

The `/memory` command writes a full digest, overwriting `members.md` and `violations.md` with clean data from the store.

## 🔒 Anti-Spam

Detects three types of spam automatically:

| Type | Detection |
|------|-----------|
| **Repeat Spam** | Same message sent N times within the time window |
| **Link Spam** | Messages containing suspicious URLs (bit.ly, tinyurl, affiliate links) |
| **Emoji Flood** | Messages with 5+ consecutive emojis |

Violations are logged to the store and synced to `violations.md`.

## 🤖 Smart Auto-Answer

When someone `@mentions` the bot with common group management questions, ZaloGuard answers directly from the local store — no LLM tokens used:

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
