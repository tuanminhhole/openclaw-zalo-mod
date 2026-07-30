# 🛡️ openclaw-zalo-mod — Zero-Token Zalo Group Moderation

> OpenClaw runtime plugin dành cho quản trị nhóm Zalo. Xử lý kiểm duyệt, slash commands, anti-spam với **0 token LLM**. Chỉ có tin nhắn `@mention` mới được chuyển lên AI agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)
[![Version](https://img.shields.io/badge/version-2.19.1-green.svg)](./CHANGELOG.md)

**[🇺🇸 English](./README.md)**

---

<div align="center">
  <a href="https://www.youtube.com/watch?v=hPusYX-5Pmw">
    <img src="https://img.youtube.com/vi/hPusYX-5Pmw/maxresdefault.jpg" alt="Watch the OpenClaw and Zalo video guide" width="820" />
  </a>
  <br />
  <strong>▶ Watch the OpenClaw + Zalo video guide on YouTube</strong>
</div>

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

- **Access URL:** `http://127.0.0.1:19790` (the plugin's own default) or your server IP on port `19790`.

> ⚠️ **Installed through OpenClaw Setup? The port is different.** Setup writes
> `dashboardPort = gateway port + 1` so every project gets its own dashboard — gateway `18789` →
> dashboard **`18790`**. When in doubt, read `plugins.entries["zalo-mod"].config.dashboardPort` from
> `openclaw.json`, or click **Open** on the `openclaw-zalo-mod` card in Setup (that button derives the
> right port). On a VPS you also have to forward that port over an SSH tunnel — the dashboard listens
> on loopback only.
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

### Feature tiers

Every first installation automatically receives a **30-day Pro trial**. The license server signs and binds the trial to the Device ID, so no manual key is required.

| Plan | View dashboard | Single group/member actions | Multi-group / bulk / `all` | Multi-bot actions |
| --- | --- | --- | --- | --- |
| Free | ✅ | ✅ | ❌ | ❌ |
| Pro | ✅ | ✅ | ✅ | ❌ |
| Team / Lifetime | ✅ | ✅ | ✅ | ✅ |

After the trial, every page remains readable and all single-item actions continue to work.

---

## 🏗️ Kiến trúc

```
Tin nhắn Zalo đến
    │  OpenClaw Zalo Connect owns the connection and inbound gate
    ├─ Mute               → drop before pipeline/model (0 tokens)
    ├─ Silent, no mention → drop before pipeline/model (0 tokens)
    └─ Allowed message    → Zalo Mod commands/policy/context
                              ├─ local command, anti-spam (0 tokens)
                              └─ agent reply → tag triggering sender
                                                → Zalo Connect native mention
```

OpenClaw Zalo Connect is the only Zalo channel/runtime used in production. Zalo Mod
does not log in separately, patch private `dist` files, or own a second transport.
Internal architecture and bridge notes live in the ignored `docs_dev/`
directory and are intentionally not included in public releases.

---

## 🔐 Data & security

The published package is intentionally auditable and ships readable source code.

- **Local data:** reads OpenClaw configuration plus Zalo Mod state under the local OpenClaw project; writes only plugin settings, audit records, memory/history, and a random persistent 16-character installation ID.
- **Zalo access:** uses the locally installed OpenClaw Zalo Connect bridge. Zalo Mod does not collect Zalo login cookies or create a second Zalo session.
- **License service:** sends the random installation ID and license/order state only to `https://zalo-mod-server.monkeytech.io.vn` to issue the 30-day trial, activate purchases, and refresh signed entitlements. It does not send hostname, hardware identifiers, browser cookies, chat history, or Zalo credentials.
- **AI summaries:** only when a summary feature is used, the relevant text is sent to the 9Router/OpenAI-compatible endpoint already configured by the OpenClaw owner. No hidden endpoint is used.
- **Dashboard:** listens on `127.0.0.1` by default. In Docker it listens on the container interface so a host-side `127.0.0.1:PORT:PORT` mapping can reach it; OpenClaw Setup creates that localhost-only mapping automatically. An explicitly configured non-loopback `dashboardHost` still requires a `dashboardToken` of at least 24 characters.
- **Removed scope:** this package contains no Facebook crawler and never reads, stores, or forwards Facebook/browser cookies.
- **Telemetry:** the plugin has no analytics or background telemetry.

---

## 📦 Cài đặt

### 1. Docker (khuyến nghị — dùng với openclaw-setup)

```powershell
# Install the pinned OpenClaw Zalo Connect release first, then Zalo Mod
docker exec openclaw-bot openclaw plugins install "https://github.com/tuanminhhole/openclaw-zalo-connect.git#v3.0.0"
docker exec openclaw-bot openclaw plugins install clawhub:openclaw-zalo-mod --force
docker restart openclaw-bot
```

### 2. Native (không Docker)

```bash
openclaw plugins install "https://github.com/tuanminhhole/openclaw-zalo-connect.git#v3.0.0"
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
[gateway] ... plugins: ..., zalo-connect, zalo-mod, ...
[openclaw-zalo-mod] bridge backend: zalo-connect-service connected=true
[openclaw-zalo-mod] live group policy replayed: N/N
```

Plugin phải xuất hiện trong danh sách. Nếu thiếu, kiểm tra quyền file.

### Bước 2: Nhận quyền Owner

Mở **Zalo Mod Dashboard → Cài đặt**, copy **Device ID**, rồi gửi DM riêng cho bot:

```
i'm owner <DEVICE_ID>
```

Device ID chứng minh bạn có quyền truy cập máy chủ, tránh người lạ tự nhận Owner. Chỉ cần xác nhận một lần; bot sẽ ghi `ownerId` vào config và khóa quyền sở hữu.

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

- OpenClaw `>= 2026.5.7`
- Plugin/channel `zalo-connect` is configured and authenticated
- OpenClaw Zalo Connect bridge service v2 (including live group policy)
- Node.js `>= 22`

---

## 📄 License

MIT — see [LICENSE](./LICENSE)
