# 🛡️ openclaw-zalo-mod — Zero-Token Zalo Group Moderation

> OpenClaw runtime plugin dành cho quản trị nhóm Zalo. Xử lý kiểm duyệt, slash commands, anti-spam với **0 token LLM**. Chỉ có tin nhắn `@mention` mới được chuyển lên AI agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)
[![Version](https://img.shields.io/badge/version-2.6.0-green.svg)](./CHANGELOG.md)

**[🇺🇸 English](./README.md)**

---

## ✨ Tính năng

| Tính năng                | Token | Mô tả                                                                                                                                          |
| ------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zalo Owner Dashboard** | 0     | Stunning graphical UI Dashboard (Premium Glassmorphism), manage groups, approve pending members, and compose direct messages via real ZCA API! |
| **Slash Commands**       | 0     | `/noi-quy`, `/menu`, `/huong-dan`, `/groupid`, `/ownerid`, `/report`, `/rules`                                                                 |
| **Warn System**          | 0     | `/warn @name [reason]` — member violation tracker                                                                                              |
| **Anti-Spam**            | 0     | Detect repeated messages, suspicious links, emoji floods                                                                                       |
| **Admin Notes**          | 0     | `/note [text]` — quick admin annotations                                                                                                       |
| **Memory Sync**          | 0     | `/memory` — saves context digest in `skills/memory/`                                                                                           |
| **Smart Q&A**            | 0     | Native retrieval: "who is warned?", "spam log?" via local data                                                                                 |
| **ZCA Admin Sync**       | 0     | Synchronizes `creatorId` & `adminIds` from Zalo API                                                                                            |
| **Owner DM**             | 0     | Administrative command control panel over private DM                                                                                           |

---

## 🖥️ Zalo Owner Dashboard (UI)

The plugin features a built-in administrative graphical user interface **Zalo Owner Dashboard** crafted under **Premium Glassmorphism & High-Density Studio v1.5** design guidelines.

- **Access URL:** `http://127.0.0.1:19790` (default) or your server IP on port `19790`.
- **Configuration inside `openclaw.json`:**
  ```json
  "dashboardEnabled": true,
  "dashboardHost": "127.0.0.1",
  "dashboardPort": 19790
  ```

### Key Modules:

1. **📊 Operations Overview**: Live monitoring of group statistics, pending member requests, and operational audit logs.
2. **👥 Group Management**: Configure Silent Mode, Welcome messages, view invite links, and track group administrators.
3. **⏳ Member Approvals**: Quickly accept pending group membership requests and watch flagged members.
4. **✍️ Message Composer**: Write and dispatch raw text or image announcements directly to chosen groups with immediate preview.
5. **🔌 API Directory**: Inspect fully documented ZCA JavaScript APIs with real integration examples.

---

## 🏗️ Kiến trúc

```
Tin nhắn Zalo đến
    │
    ├─ /slash command     → Plugin xử lý local (0 token)
    ├─ Spam phát hiện     → Log + block im lặng (0 token)
    ├─ Sticker/media      → Chuyển thành [Sticker] (0 token)
    ├─ "Ai bị warn?"      → Plugin trả lời từ store (0 token)
    │
    └─ @BotName câu hỏi  → Chuyển lên LLM agent (dùng token)
```

---

## 📦 Cài đặt

### 1. Docker (khuyến nghị — dùng với openclaw-setup)

```powershell
# Chạy bên trong container
docker exec openclaw-bot openclaw plugins install clawhub:openclaw-zalo-mod --force
docker restart openclaw-bot
```

### 2. Native (không Docker)

```bash
openclaw plugins install openclaw-zalo-mod
openclaw gateway restart
```

### 3. Cài thủ công từ source

```powershell
# Copy source vào thư mục extensions
xcopy /E /I openclaw-zalo-mod "%OPENCLAW_HOME%\extensions\zalo-mod"

# Hoặc trên Linux
cp -r openclaw-zalo-mod ~/.openclaw/extensions/zalo-mod

# Restart gateway
openclaw gateway restart
```

### 4. Patch nhanh khi phát triển (Docker)

```powershell
# Copy file đã sửa vào container
Copy-Item -Path "D:\openclaw-zalo-mod\index.js" -Destination "E:\final\.openclaw\extensions\zalo-mod\index.js" -Force

# Fix quyền (Windows bind mount tạo quyền 777)
docker exec openclaw-bot chmod 644 /root/project/.openclaw/extensions/zalo-mod/index.js

# Restart
docker restart openclaw-bot
```

> ⚠️ **Lưu ý quyền file:** Windows bind mounts tạo file với quyền `0777`. OpenClaw sẽ từ chối load plugin có quyền world-writable. Luôn chạy `chmod 644` sau khi copy.

---

## ⚙️ Cấu hình ban đầu

### Bước 1: Xác nhận bot đã load plugin

Kiểm tra log sau khi restart:

```
[gateway] http server listening (5 plugins: browser, memory-core, openclaw-n8n-facebook-poster, zalo-mod, zalouser; ...)
```

Plugin phải xuất hiện trong danh sách. Nếu thiếu, kiểm tra quyền file.

### Bước 2: Nhận quyền Owner

Gửi tin nhắn DM riêng cho bot:

```
i'm admin
```

Bot sẽ tự động ghi `ownerId` vào config và xác nhận.

### Bước 3: Đăng ký Group

Vào group cần quản lý, gửi lệnh:

```
/bot-rules groupid
```

Bot sẽ quét session, lấy `creatorId` + `adminIds` từ Zalo API, rồi tự ghi vào config.

---

## 📋 Danh sách lệnh đầy đủ

### 👤 Mọi người (trong group)

| Lệnh                   | Mô tả                 |
| ---------------------- | --------------------- |
| `/{botname}-noi-quy`   | Xem nội quy nhóm      |
| `/{botname}-menu`      | Danh sách lệnh        |
| `/{botname}-huong-dan` | Hướng dẫn sử dụng bot |
| `/{botname}-report`    | Báo cáo vi phạm       |

### 🔧 Admin (trong group)

| Lệnh                            | Mô tả             |
| ------------------------------- | ----------------- |
| `/{botname}-mute`               | Tắt bot hoàn toàn |
| `/{botname}-unmute`             | Bật lại bot       |
| `/{botname}-warn @name [lý do]` | Cảnh cáo member   |
| `/{botname}-note [text]`        | Ghi chú admin     |
| `/{botname}-memory [note]`      | Lưu memory digest |

### 👑 Owner — trong group

| Lệnh                         | Mô tả                                      |
| ---------------------------- | ------------------------------------------ |
| `/bot-rules`                 | Xem panel sub-lệnh                         |
| `/bot-rules status`          | Cấu hình group hiện tại                    |
| `/bot-rules groupid`         | Thêm group + lấy adminIds/creatorId từ ZCA |
| `/bot-rules silent-on/off`   | Bật/tắt silent mode                        |
| `/bot-rules welcome-on/off`  | Bật/tắt chào member mới                    |
| `/bot-rules tracking-on/off` | Bật/tắt ghi lịch sử                        |

### 🔐 Owner — qua DM riêng

| Lệnh                                   | Mô tả                    |
| -------------------------------------- | ------------------------ |
| `/bot-rules mute <groupId> on/off`     | Mute/unmute group cụ thể |
| `/bot-rules mute all on/off`           | Mute/unmute tất cả       |
| `/bot-rules silent <groupId> on/off`   | Silent group cụ thể      |
| `/bot-rules welcome <groupId> on/off`  | Welcome group cụ thể     |
| `/bot-rules tracking <groupId> on/off` | Tracking group cụ thể    |
| `/bot-rules dm-add <userId>`           | Thêm vào DM whitelist    |
| `/bot-rules groupid-list`              | Danh sách tất cả groups  |
| `/bot-ownerid`                         | Xem owner ID hiện tại    |

---

## 🛑 Anti-Spam

| Loại            | Phát hiện                                      |
| --------------- | ---------------------------------------------- |
| **Repeat Spam** | Cùng tin nhắn gửi N lần trong khoảng thời gian |
| **Link Spam**   | URL rút gọn hoặc link affiliate đáng ngờ       |
| **Emoji Flood** | 5+ emoji liên tiếp                             |

Cấu hình trong `openclaw.json`:

```json
"spamRepeatN": 3,
"spamWindowSeconds": 300
```

---

## 🔧 Yêu cầu

- OpenClaw `>= 2026.3.24`
- Channel `zalouser` đã được cấu hình và xác thực
- Node.js `>= 20`

---

## 🔄 Release Workflow (Automated Obfuscation & Publishing)

To protect commercial PRO features, the Javascript source code distributed via ClawHub is automatically obfuscated using an enterprise-grade build workflow:

```powershell
# 1. Develop/modify code inside D:\openclaw-zalo-mod\index.js
# 2. Update CHANGELOG.md with new changes
# 3. Synchronize package and config versions (e.g. 2.5.4)
node bump-version.js
# 4. Stage & Commit cleanly (docs/ folder and sensitive configs are ignored automatically)
git add .
git commit -m "chore: release vX.X.X"
git push
# 5. Run the Premium Build & Publish script to obfuscate and publish to ClawHub
node build-and-publish.js
```

---

## 📄 License

MIT — see [LICENSE](./LICENSE)
