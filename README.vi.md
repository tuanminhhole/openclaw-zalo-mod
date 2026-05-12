# 🛡️ openclaw-zalo-mod — Quản Trị Nhóm Zalo Zero-Token

> Plugin OpenClaw dành cho quản trị nhóm Zalo. Xử lý kiểm duyệt, slash commands, anti-spam với **0 token LLM**. Chỉ tin nhắn `@mention` được chuyển lên AI agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)
[![Version](https://img.shields.io/badge/version-2.4.18-green.svg)](./CHANGELOG.md)

**[🇺🇸 English](./README.md)**

---

## ✨ Tính năng

| Tính năng          | Token | Mô tả                                                                 |
| ------------------ | ----- | --------------------------------------------------------------------- |
| **Slash Commands** | 0     | `/[botname]-noi-quy`, `/[botname]-menu`, `/[botname]-huong-dan`, v.v. |
| **Warn System**    | 0     | `/[botname]-warn @name [lý do]` — theo dõi vi phạm theo member        |
| **Anti-Spam**      | 0     | Tự phát hiện tin nhắn lặp, spam link, emoji flood                     |
| **Admin Notes**    | 0     | `/[botname]-note [text]` — ghi chú admin                              |
| **Memory Sync**    | 0     | `/[botname]-memory` — lưu digest vào `skills/memory/`                 |
| **Smart Q&A**      | 0     | Tự trả lời "ai bị warn?", "vi phạm?" từ dữ liệu local                 |
| **ZCA Admin Sync** | 0     | Tự động lấy `creatorId` + `adminIds` từ Zalo API                      |
| **Owner DM**       | 0     | Nhận lệnh quản trị qua DM riêng với bot                               |

> **Lưu ý về prefix lệnh:** Tất cả lệnh dùng prefix `/{tên-bot}-`. Ví dụ nếu bot tên `Williams` thì lệnh là `/williams-menu`, `/williams-noi-quy`, v.v.

---

## 🏗️ Kiến trúc

```
Tin nhắn Zalo đến
    │
    ├─ /{botname}-[lệnh]  → Plugin xử lý local (0 token)
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
openclaw plugins install clawhub:openclaw-zalo-mod
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
# Copy file đã sửa vào volume
Copy-Item -Path "D:\openclaw-zalo-mod\index.js" -Destination "E:\final\.openclaw\extensions\zalo-mod\index.js" -Force

# Fix quyền (Windows bind mount tạo quyền 777 — OpenClaw sẽ từ chối load)
docker exec openclaw-bot chmod 644 /root/project/.openclaw/extensions/zalo-mod/index.js

# Restart
docker restart openclaw-bot
```

---

## ⚙️ Cấu hình ban đầu

### Bước 1: Xác nhận plugin đã load

Kiểm tra log sau khi restart:

```
[gateway] http server listening (5 plugins: browser, memory-core, openclaw-n8n-facebook-poster, zalo-mod, zalouser; ...)
[plugins] [openclaw-zalo-mod] loaded — bot="Williams" owner=... groups=N
```

### Bước 2: Nhận quyền Owner

Gửi tin nhắn DM riêng cho bot:

```
i'm admin
```

Bot sẽ tự động ghi `ownerId` vào config và xác nhận.

### Bước 3: Đăng ký Group

Vào group cần quản lý, gửi lệnh (thay `botname` theo tên bot của bạn):

```
/bot-rules groupid
```

Bot sẽ quét session, lấy `creatorId` + `adminIds` từ Zalo API, rồi tự ghi vào config.

---

## 📋 Danh sách lệnh đầy đủ

> **Prefix lệnh:** `/{tên-bot}-` — ví dụ bot tên `Williams` → prefix là `/williams-`

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

| Lệnh                            | Mô tả                                      |
| ------------------------------- | ------------------------------------------ |
| `/{botname}-rules`              | Xem panel sub-lệnh                         |
| `/{botname}-rules status`       | Cấu hình group hiện tại                    |
| `/{botname}-rules groupid`      | Thêm group + lấy adminIds/creatorId từ ZCA |
| `/{botname}-rules silent-on`    | Bật silent (chỉ reply khi @tag)            |
| `/{botname}-rules silent-off`   | Tắt silent mode                            |
| `/{botname}-rules welcome-on`   | Bật chào member mới                        |
| `/{botname}-rules welcome-off`  | Tắt chào member mới                        |
| `/{botname}-rules tracking-on`  | Bật ghi lịch sử chat                       |
| `/{botname}-rules tracking-off` | Tắt ghi lịch sử chat                       |

### 🔐 Owner — qua DM riêng

| Lệnh                                         | Mô tả                           |
| -------------------------------------------- | ------------------------------- |
| `/{botname}-rules mute-list`                 | Trạng thái mute tất cả groups   |
| `/{botname}-rules mute <groupId> on/off`     | Mute/unmute group cụ thể        |
| `/{botname}-rules mute all on/off`           | Mute/unmute tất cả              |
| `/{botname}-rules silent-list`               | Trạng thái silent tất cả groups |
| `/{botname}-rules silent <groupId> on/off`   | Silent group cụ thể             |
| `/{botname}-rules silent all on/off`         | Silent tất cả                   |
| `/{botname}-rules welcome-list`              | Trạng thái welcome tất cả       |
| `/{botname}-rules welcome <groupId> on/off`  | Welcome group cụ thể            |
| `/{botname}-rules welcome all on/off`        | Welcome tất cả                  |
| `/{botname}-rules tracking-list`             | Trạng thái tracking tất cả      |
| `/{botname}-rules tracking <groupId> on/off` | Tracking group cụ thể           |
| `/{botname}-rules tracking all on/off`       | Tracking tất cả                 |
| `/{botname}-rules follow-list`               | Theo dõi memory per-group       |
| `/{botname}-rules follow <groupId> on/off`   | Follow group cụ thể             |
| `/{botname}-rules follow all on/off`         | Follow tất cả                   |
| `/{botname}-rules dm-list`                   | DM whitelist                    |
| `/{botname}-rules dm-add <tên>`              | Thêm vào DM whitelist           |
| `/{botname}-rules dm-remove <tên>`           | Xóa khỏi DM whitelist           |
| `/{botname}-rules groupid-list`              | Danh sách tất cả groups         |
| `/{botname}-rules groupid-add <groupId>`     | Thêm group từ xa                |
| `/{botname}-ownerid`                         | Xem/đặt owner ID                |

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

## 🔇 Mute vs Silent

|                | Mute             | Silent             |
| -------------- | ---------------- | ------------------ |
| Bot im lặng    | Hoàn toàn        | Chỉ không tự reply |
| Slash commands | ❌ (chỉ /unmute) | ✅                 |
| @mention       | ❌               | ✅                 |
| Welcome        | ❌               | ✅                 |

---

## 🔧 Yêu cầu

- OpenClaw `>= 2026.3.24`
- Channel `zalouser` đã được cấu hình và xác thực
- Node.js `>= 20`

---

## 📄 License

MIT — see [LICENSE](./LICENSE)
