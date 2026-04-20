# 🛡️ ZaloGuard — Plugin Quản Lý Nhóm Zalo Không Tốn Token

> Plugin runtime OpenClaw dành cho quản trị nhóm Zalo. Xử lý moderation, slash commands, anti-spam **hoàn toàn miễn phí token LLM**. Chỉ chuyển câu hỏi `@mention` lên AI agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)

**[🇬🇧 English Version](./README.md)**

---

## ✨ Tính Năng

| Tính năng | Chi phí token | Mô tả |
|-----------|--------------|-------|
| **Slash Commands** | 0 | `/noi-quy`, `/menu`, `/huong-dan`, `/report`, `/rules` |
| **Hệ thống Warn** | 0 | `/warn @name [lý do]` — theo dõi cảnh cáo từng member |
| **Chống Spam** | 0 | Tự detect tin lặp, link spam, emoji flood |
| **Ghi chú Admin** | 0 | `/note [text]` — chỉ admin dùng |
| **Đồng bộ Memory** | 0 | `/memory` — lưu digest vào `skills/memory/` |
| **Auto trả lời** | 0 | Tự trả lời "ai bị warn?" "vi phạm?" từ dữ liệu local |
| **@Mention** | ✅ có token | Chỉ forward lên LLM khi hỏi thật |

## 🏗️ Kiến Trúc

```
Tin nhắn Zalo đến
    │
    ├─ /lệnh slash        → Plugin xử lý local (0 token)
    ├─ Phát hiện spam     → Log + chặn im lặng (0 token)
    ├─ "Ai bị warn?"      → Plugin trả lời từ store (0 token)
    │
    └─ @TênBot câu hỏi   → Forward lên LLM agent (tốn token)
```

## 📦 Cài Đặt

### Từ ClawHub

```bash
openclaw plugins install clawhub:openclaw-zaloguard
```

### Từ npm

```bash
openclaw plugins install openclaw-zaloguard
```

### Thủ công

Copy plugin vào thư mục `extensions/`:

```bash
cp -r openclaw-zaloguard ~/.openclaw/extensions/
```

## ⚙️ Cấu Hình

Thêm vào `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "zaloguard": {
        "enabled": true,
        "config": {
          "groupName": "Tên Nhóm Của Bạn",
          "botName": "TênBot",
          "zaloDisplayNames": ["Tên Hiển Thị Zalo"],
          "adminIds": ["1234567890"],
          "welcomeEnabled": true,
          "spamRepeatN": 3,
          "spamWindowSeconds": 300
        }
      }
    }
  }
}
```

### Tùy Chọn Config

| Tùy chọn | Kiểu | Mặc định | Mô tả |
|----------|------|----------|-------|
| `groupName` | string | `"Nhóm"` | Tên group hiển thị trong templates và file memory |
| `botName` | string | `"Bot"` | Tên bot hiện trong menu |
| `zaloDisplayNames` | string[] | `[]` | Tên hiển thị Zalo của bot để detect @mention |
| `adminIds` | string[] | `[]` | Zalo user IDs cho lệnh admin. Rỗng = tất cả |
| `welcomeEnabled` | boolean | `true` | Bật chào mừng member mới |
| `spamRepeatN` | number | `3` | Ngưỡng tin lặp để coi là spam |
| `spamWindowSeconds` | number | `300` | Cửa sổ thời gian (giây) detect spam lặp |
| `memoryGroupSlug` | string | tự động | Override tên thư mục memory (tự sinh từ `groupName`) |

## 📋 Slash Commands

### Mọi Người Dùng Được

| Lệnh | Mô tả |
|-------|-------|
| `/noi-quy` | Xem nội quy nhóm |
| `/menu` | Xem tất cả lệnh |
| `/huong-dan` | Hướng dẫn dùng bot |

### Chỉ Admin

| Lệnh | Mô tả |
|-------|-------|
| `/warn @name [lý do]` | Cảnh cáo member (lưu vào store + memory) |
| `/note [text]` | Ghi chú admin |
| `/report` | Xem báo cáo vi phạm |
| `/memory` | Lưu digest đầy đủ vào file memory |
| `/rules` | Bảng cấu hình bot |
| `/rules silent-on/off` | Bật/tắt chế độ im lặng |
| `/rules welcome-on/off` | Bật/tắt chào member mới |
| `/rules status` | Xem cấu hình hiện tại |

## 🧠 Tích Hợp Memory

ZaloGuard tự đồng bộ dữ liệu moderation vào file markdown trong `skills/memory/zalo-groups/{group-slug}/`:

```
skills/memory/zalo-groups/ten-nhom-cua-ban/
├── members.md          ← Log warn (tự sync khi /warn)
├── violations.md       ← Vi phạm spam (tự sync)
├── chat-highlights.md  ← Cuộc hội thoại @mention (tự sync)
└── admin-notes.md      ← Ghi chú admin (tự sync khi /note)
```

Lệnh `/memory` ghi digest đầy đủ, overwrite `members.md` và `violations.md` với dữ liệu sạch từ store.

## 🔒 Chống Spam

Tự detect 3 loại spam:

| Loại | Cách detect |
|------|------------|
| **Tin lặp** | Cùng nội dung gửi N lần trong cửa sổ thời gian |
| **Link Spam** | Tin chứa URL đáng ngờ (bit.ly, tinyurl, affiliate links) |
| **Emoji Flood** | Tin có 5+ emoji liên tiếp |

Vi phạm được log vào store và sync vào `violations.md`.

## 🤖 Auto Trả Lời Thông Minh

Khi ai đó `@mention` bot với câu hỏi quản lý nhóm, ZaloGuard trả lời trực tiếp từ store — không tốn token LLM:

| Pattern câu hỏi | Nguồn dữ liệu |
|-----------------|---------------|
| "Ai bị warn?" / "Danh sách warn" | `store.getWarned()` |
| "Vi phạm?" / "Violations?" | `store.getViolations()` |
| "Admin là ai?" | Config response |

Tất cả câu hỏi `@mention` khác được forward lên LLM agent.

## 🔧 Yêu Cầu

- OpenClaw `>= 2026.3.24`
- Channel `zalouser` đã cấu hình và xác thực
- Node.js `>= 20`

## 📄 Giấy Phép

MIT — xem [LICENSE](./LICENSE)
