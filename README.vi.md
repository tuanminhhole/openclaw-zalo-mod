# 🛡️ zalo-mod — Plugin Quản Lý Nhóm Zalo Không Tốn Token

> Plugin runtime OpenClaw dành cho quản trị nhóm Zalo. Xử lý moderation, slash commands, anti-spam **hoàn toàn miễn phí token LLM**. Chỉ chuyển câu hỏi `@mention` lên AI agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)

**[🇬🇧 English Version](./README.md)**

# 🛡️ zalo-mod — Plugin Quản Lý Nhóm Zalo Không Tốn Token

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
openclaw plugins install clawhub:openclaw-zalo-mod
```

### Từ npm

```bash
openclaw plugins install openclaw-zalo-mod
```

### Thủ công

1. Copy plugin vào thư mục `extensions/`:

```bash
# Windows
xcopy /E /I openclaw-zalo-mod %OPENCLAW_HOME%\extensions\zalo-mod

# Linux / macOS
cp -r openclaw-zalo-mod ~/.openclaw/extensions/zalo-mod
```

2. Chạy script setup tự động (⭐ **khuyên dùng**):

```bash
cd ~/.openclaw/extensions/zalo-mod
node setup.js
```

Script sẽ:
- ✅ Tự detect thư mục `.openclaw`
- ✅ Hỏi tên nhóm, tên bot, Zalo display names, admin IDs
- ✅ Tự detect Docker hay Native để đặt đúng đường dẫn
- ✅ Backup `openclaw.json` trước khi sửa
- ✅ Tự thêm config plugin vào `openclaw.json`
- ✅ Tạo thư mục `data/` cho plugin

> 💡 **Tip:** Nếu script không tìm thấy `.openclaw`, hãy chỉ đường dẫn:
> ```bash
> node setup.js --openclaw-home "D:\bot\.openclaw"
> ```

> 💡 **Non-interactive mode** (dùng config mặc định):
> ```bash
> node setup.js --non-interactive
> ```

> 🐳 **Docker Compose:** với Windows bind mount, Docker thường báo file plugin là `mode=777`, OpenClaw sẽ không load plugin. Cách ổn định nhất là COPY plugin vào image/container filesystem rồi `chmod 755`.
> ```yaml
> services:
>   ai-bot:
>     build:
>       context: D:/bot
>       dockerfile: docker/openclaw/Dockerfile
>     volumes:
>       - D:/bot/.openclaw:/root/project/.openclaw
> ```
> Thêm vào `Dockerfile`:
> ```dockerfile
> COPY extensions/zalo-mod /opt/openclaw/extensions/zalo-mod
> RUN chmod -R 755 /opt/openclaw/extensions/zalo-mod \
>   && mkdir -p /opt/openclaw/extensions/zalo-mod/node_modules \
>   && ln -s /usr/local/lib/node_modules/openclaw /opt/openclaw/extensions/zalo-mod/node_modules/openclaw
> ```
> Chạy setup:
> ```bash
> node setup.js --openclaw-home "D:\bot\.openclaw" --install-path "/opt/openclaw/extensions/zalo-mod"
> ```
> Khi đó setup sẽ ghi `plugins.load.paths: ["/opt/openclaw/extensions/zalo-mod"]`. Đây là cơ chế discovery chính thức cho local plugin path; không nên tự ghi tay `plugins.installs`.
> Nếu đã từng copy plugin vào `.openclaw/extensions/zalo-mod`, hãy xóa hoặc đổi tên thư mục cũ đó; chỉ cần thư mục tồn tại là OpenClaw vẫn tự quét và log warning.

3. Khởi động lại gateway:
|------|------------|
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
