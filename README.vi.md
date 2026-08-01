# 🛡️ openclaw-zalo-mod — Quản Trị Nhóm Zalo Zero-Token

> Plugin OpenClaw dành cho quản trị nhóm Zalo. Xử lý kiểm duyệt, slash commands, anti-spam với **0 token LLM**. Chỉ tin nhắn `@mention` được chuyển lên AI agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)
[![Version](https://img.shields.io/badge/version-2.26.1-green.svg)](./CHANGELOG.md)

**[🇺🇸 English](./README.md)**

---

<div align="center">
  <a href="https://www.youtube.com/watch?v=hPusYX-5Pmw">
    <img src="https://img.youtube.com/vi/hPusYX-5Pmw/maxresdefault.jpg" alt="Xem video hướng dẫn OpenClaw và Zalo" width="820" />
  </a>
  <br />
  <strong>▶ Xem video hướng dẫn OpenClaw + Zalo trên YouTube</strong>
</div>

---

## ✨ Tính năng

| **Zalo Owner Dashboard** | 0 | UI Dashboard đồ họa tuyệt đẹp (Premium Glassmorphism), quản lý group, duyệt member, soạn gửi tin nhắn trực tiếp qua ZCA API! |
| **Slash Commands** | 0 | `/[botname]-noi-quy`, `/[botname]-menu`, `/[botname]-huong-dan`, v.v. |
| **Warn System** | 0 | `/[botname]-warn @name [lý do]` — theo dõi vi phạm theo member |
| **Anti-Spam** | 0 | Tự phát hiện tin nhắn lặp, spam link, emoji flood |
| **Admin Notes** | 0 | `/[botname]-note [text]` — ghi chú admin |
| **Memory Sync** | 0 | `/[botname]-memory` — lưu digest vào `skills/memory/` |
| **Smart Q&A** | 0 | Tự trả lời "ai bị warn?", "vi phạm?" từ dữ liệu local |
| **ZCA Admin Sync** | 0 | Tự động lấy `creatorId` + `adminIds` từ Zalo API |
| **Owner DM** | 0 | Nhận lệnh quản trị qua DM riêng với bot |

> **Lưu ý về prefix lệnh:** Tất cả lệnh dùng prefix `/{tên-bot}-`. Ví dụ nếu bot tên `Williams` thì lệnh là `/williams-menu`, `/williams-noi-quy`, v.v.

---

## 🖥️ Zalo Owner Dashboard (UI)

Plugin tích hợp sẵn giao diện quản trị đồ họa **Zalo Owner Dashboard** được thiết kế theo chuẩn **Premium Glassmorphism & High-Density Studio v1.5** siêu sang trọng.

- **Cách truy cập:** `http://127.0.0.1:19790` (mặc định của plugin) hoặc IP máy chủ của bạn trên cổng `19790`.

> ⚠️ **Cài qua OpenClaw Setup thì cổng KHÁC.** Setup tự ghi `dashboardPort = cổng gateway + 1` để mỗi
> project có dashboard riêng — gateway `18789` → dashboard **`18790`**. Không chắc thì mở
> `openclaw.json` xem `plugins.entries["zalo-mod"].config.dashboardPort`, hoặc bấm **Mở web** trên
> card `openclaw-zalo-mod` trong Setup (nút đó tự suy ra cổng đúng). Trên VPS còn phải forward cổng
> đó qua SSH tunnel vì dashboard chỉ nghe trên loopback.
- **Cấu hình trong `openclaw.json`:**
  ```json
  "dashboardEnabled": true,
  "dashboardHost": "127.0.0.1",
  "dashboardPort": 19790
  ```

### Các phân hệ chính trên Dashboard:

1. **📊 Tổng quan vận hành**: Xem nhanh số lượng nhóm, member chờ duyệt, logs hoạt động theo thời gian thực.
2. **👥 Quản lý Nhóm**: Cấu hình chế độ Silent Mode, Welcome message, xem link mời nhóm, xem danh sách Admin từng nhóm.
3. **⏳ Thành viên & Duyệt**: Duyệt nhanh thành viên xin vào nhóm, theo dõi member vi phạm/cảnh cáo.
4. **✍️ Gửi tin nhắn (Composer)**: Soạn thảo tin nhắn và gửi trực tiếp đến các nhóm nhanh chóng, hỗ trợ preview hình ảnh trước khi gửi.
5. **🔌 Danh mục API**: Tra cứu toàn bộ các ZCA API khả dụng và các ví dụ thực tế.

---

### Gói tính năng

Mỗi bản cài mới được tự động dùng thử **Pro trong 30 ngày**. Trial được license server ký và gắn với Device ID, không cần nhập key.

| Gói | Xem dashboard | Thao tác từng group/member | Nhiều group / hàng loạt / `all` | Nhiều bot cùng lúc |
| --- | --- | --- | --- | --- |
| Free | ✅ | ✅ | ❌ | ❌ |
| Pro | ✅ | ✅ | ✅ | ❌ |
| Team / Lifetime | ✅ | ✅ | ✅ | ✅ |

Hết trial, dashboard và mọi dữ liệu vẫn xem được; các thao tác đơn vẫn hoạt động bình thường.

---

## 🏗️ Kiến trúc

```
Tin nhắn Zalo đến
    │  OpenClaw Zalo Connect sở hữu kết nối Zalo + inbound gate
    ├─ Mute               → chặn trước pipeline/model (0 token)
    ├─ Silent, không tag  → chặn trước pipeline/model (0 token)
    └─ Tin được phép      → Zalo Mod xử lý lệnh/policy/context
                              ├─ lệnh local, anti-spam (0 token)
                              └─ agent reply → tự tag đúng người gửi
                                                → Zalo Connect gửi mention native
```

OpenClaw Zalo Connect là channel/runtime Zalo duy nhất trong production. Zalo Mod
không đăng nhập Zalo riêng, không patch private `dist`, và không sở hữu transport thứ hai.
Kiến trúc kỹ thuật và bridge contract nằm trong thư mục nội bộ `docs_dev/`,
được Git bỏ qua và không phát hành công khai.

---

## 🔐 Dữ liệu & bảo mật

Gói phát hành dùng mã nguồn rõ để người dùng và ClawHub có thể kiểm tra đầy đủ.

- **Dữ liệu local:** chỉ đọc cấu hình OpenClaw và dữ liệu Zalo Mod trong project; chỉ ghi thiết lập plugin, audit, memory/lịch sử và một mã cài đặt ngẫu nhiên 16 ký tự được lưu bền vững.
- **Kết nối Zalo:** dùng bridge của OpenClaw Zalo Connect đã cài trên cùng máy. Zalo Mod không thu thập cookie đăng nhập Zalo và không tạo phiên Zalo thứ hai.
- **Máy chủ bản quyền:** chỉ gửi mã cài đặt ngẫu nhiên cùng trạng thái license/order tới `https://zalo-mod-server.monkeytech.io.vn` để cấp 30 ngày Pro, kích hoạt đơn hàng và làm mới entitlement có chữ ký. Không gửi hostname, thông tin phần cứng, cookie trình duyệt, lịch sử chat hay thông tin đăng nhập Zalo.
- **Tóm tắt AI:** chỉ khi người dùng bật/chạy tính năng tóm tắt, phần text liên quan mới được gửi tới endpoint tương thích OpenAI/9Router mà chính Owner đã cấu hình trong OpenClaw; plugin không dùng endpoint bí mật khác.
- **Dashboard:** mặc định chỉ nghe tại `127.0.0.1`. Trong Docker, plugin nghe trên interface nội bộ của container để ánh xạ `127.0.0.1:PORT:PORT` phía máy chủ truy cập được; OpenClaw Setup tự tạo ánh xạ chỉ-localhost này. Nếu tự cấu hình `dashboardHost` ngoài localhost, plugin vẫn yêu cầu `dashboardToken` dài tối thiểu 24 ký tự.
- **Đã bỏ khỏi phạm vi:** gói không chứa Facebook Crawler và không đọc, lưu hay chuyển tiếp cookie Facebook/cookie trình duyệt.
- **Telemetry:** plugin không có analytics hoặc telemetry nền.

---

## 📦 Cài đặt

### 1. Docker (khuyến nghị — dùng với openclaw-setup)

```powershell
# Cài bản OpenClaw Zalo Connect đã ghim trước, sau đó cài Zalo Mod
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
[gateway] ... plugins: ..., zalo-connect, zalo-mod, ...
[openclaw-zalo-mod] bridge backend: zalo-connect-service connected=true
[openclaw-zalo-mod] live group policy replayed: N/N
[plugins] [openclaw-zalo-mod] loaded — bot="Williams" owner=... groups=N
```

### Bước 2: Nhận quyền Owner

Mở **Zalo Mod Dashboard → Cài đặt**, copy **Device ID**, rồi gửi DM riêng cho bot:

```
i'm owner <DEVICE_ID>
```

Device ID chứng minh bạn có quyền truy cập máy chủ, tránh người lạ tự nhận Owner. Chỉ cần xác nhận một lần; bot sẽ ghi `ownerId` vào config và khóa quyền sở hữu.

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

## 🔇 Mute vs Silent

|                | Mute             | Silent             |
| -------------- | ---------------- | ------------------ |
| Bot im lặng    | Hoàn toàn        | Chỉ không tự reply |
| Slash commands | ❌ (chỉ /unmute) | ✅                 |
| @mention       | ❌               | ✅                 |
| Welcome        | ❌               | ✅                 |

---

## 🔧 Yêu cầu

- OpenClaw `>= 2026.5.7`
- Plugin/channel `zalo-connect` đã được cấu hình và xác thực
- OpenClaw Zalo Connect bridge service v2 (có live group policy)
- Node.js `>= 22`

---

## 📄 License

MIT — see [LICENSE](./LICENSE)
