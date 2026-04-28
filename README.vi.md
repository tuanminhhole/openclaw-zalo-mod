# 🛡️ zalo-mod — Plugin Quản Lý Nhóm Zalo Không Tốn Token

> Plugin runtime OpenClaw dành cho quản trị nhóm Zalo. Xử lý moderation, slash commands, anti-spam **hoàn toàn miễn phí token LLM**. Chỉ chuyển câu hỏi `@mention` lên AI agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)

**[🇬🇧 English Version](./README.md)**

---

## ✨ Tính Năng

| Tính năng | Chi phí token | Mô tả |
|-----------|--------------|-------|
| **Slash Commands** | 0 | `/noi-quy`, `/menu`, `/huong-dan`, `/groupid`, `/ownerid`, `/report`, `/rules` |
| **Hệ thống Warn** | 0 | `/warn @name [lý do]` — theo dõi cảnh cáo từng member |
| **Chống Spam** | 0 | Tự detect tin lặp, link spam, emoji flood |
| **Ghi chú Admin** | 0 | `/note [text]` — chỉ admin dùng |
| **Đồng bộ Memory** | 0 | `/memory` — lưu digest vào `skills/memory/` |
| **Auto trả lời** | 0 | Tự trả lời "ai bị warn?" "vi phạm?" từ dữ liệu local |
| **Nhận diện Sticker** | 0 | Chuyển JSON sticker thô thành `[Sticker]` cho agent |
| **@Mention** | ✅ có token | Chỉ forward lên LLM khi hỏi thật |

## 🏗️ Kiến Trúc

```
Tin nhắn Zalo đến
    │
    ├─ /lệnh slash        → Plugin xử lý local (0 token)
    ├─ Phát hiện spam     → Log + chặn im lặng (0 token)
    ├─ Sticker/media      → Chuyển thành [Sticker] (0 token)
    ├─ "Ai bị warn?"      → Plugin trả lời từ store (0 token)
    │
    └─ @TênBot câu hỏi   → Forward lên LLM agent (tốn token)
```

## 📦 Cài Đặt

### Từ ClawHub (khuyên dùng)

```bash
openclaw plugins install zalo-mod
```

### Thủ công

1. Copy plugin vào thư mục `extensions/`:

```bash
# Windows
xcopy /E /I openclaw-zalo-mod %OPENCLAW_HOME%\extensions\zalo-mod

# Linux / macOS
cp -r openclaw-zalo-mod ~/.openclaw/extensions/zalo-mod
```

2. Khởi động lại gateway:

```bash
openclaw gateway restart
```

### Resolve đường dẫn

`zalo-mod` không bắt buộc native install phải có file `.env`. Runtime sẽ tìm OpenClaw config theo thứ tự:

1. Biến môi trường `OPENCLAW_HOME`, thường dùng trong Docker/openclaw-setup.
2. Đường dẫn cài plugin, thường là `{OPENCLAW_HOME}/extensions/zalo-mod`.

Sau khi bot nhận được tin nhắn group, gõ `/groupid` trong group đó. Plugin sẽ scan Zalo sessions đã lưu và ghi cả `watchGroupIds` lẫn `groupNames` vào `openclaw.json`.

## 🛑 Phát Hiện Spam

| Loại | Phát hiện |
|------|-----------|
| **Tin lặp** | Cùng nội dung gửi N lần trong cửa sổ thời gian |
| **Link Spam** | Tin chứa URL đáng ngờ (bit.ly, tinyurl, affiliate links) |
| **Emoji Flood** | Tin có 5+ emoji liên tiếp |

Vi phạm được log vào store và sync vào `violations.md`.

## 🤖 Auto Trả Lời Thông Minh

Khi ai đó `@mention` bot với câu hỏi quản lý nhóm, zalo-mod trả lời trực tiếp từ store — không tốn token LLM:

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
