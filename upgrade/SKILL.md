---
name: Upgrade Flow — Bán hàng tự động Zalo-Mod
slug: upgrade-flow
version: 1.0.0
description: |
  Xử lý flow nâng cấp plugin openclaw-zalo-mod qua DM.
  Nhận diện DeviceID → Hỏi chọn plan → Tạo QR thanh toán → Auto-check → Cấp key.
---

# 🛒 Upgrade Flow — Bán Hàng Tự Động

## Khi nào dùng skill này

Khi nhận tin nhắn DM (1-1, KHÔNG phải group) và nội dung khớp một trong các điều kiện sau:

1. **DeviceID mới** — Chuỗi đúng 16 ký tự hex: `/^[0-9A-Fa-f]{16}$/`
   Ví dụ: `82F1CDD9ADC1A3A1`, `F3ED50C949193616`
2. **Chọn plan** — User đang ở trạng thái chờ chọn plan (vừa gửi deviceId)
   Reply là `1`, `2`, hoặc `3`
3. **Xác nhận thanh toán** — User reply "đã ck", "done", "ok", "xong"
4. **Hỏi về giá / mua / nâng cấp** — Từ khoá: "giá", "mua", "nâng cấp", "upgrade", "price"

---

## ⚡ FLOW CHI TIẾT

### Bước 1: User gửi DeviceID

Khi nhận chuỗi 16 hex chars → chạy:

```bash
node /root/project/.openclaw/workspace-bot/skills/upgrade-flow/flow.js show-plans
```

Trả kết quả bảng giá cho user và hỏi chọn plan:

> "Mình nhận được Device ID của bạn: `{DEVICE_ID}`
>
> {bảng giá từ show-plans}
>
> Reply số thứ tự (1, 2, hoặc 3) để chọn gói nhé!"

**GHI NHỚ**: Lưu DeviceID này vào context. User tiếp theo sẽ reply số plan.

### Bước 2: User chọn plan (reply 1, 2, 3)

Khi user reply số 1, 2, hoặc 3 (và trước đó đã gửi deviceId):

```bash
node /root/project/.openclaw/workspace-bot/skills/upgrade-flow/flow.js create-order {DEVICE_ID} {planIndex} {SENDER_ID} "{SENDER_NAME}"
```

- `{planIndex}`: 1 = personal, 2 = team, 3 = lifetime
- `{SENDER_ID}`: Zalo userId của người gửi
- `{SENDER_NAME}`: Tên hiển thị

Gửi cho user kết quả từ `paymentMessage` (thông tin CK + QR).

Nếu MonkeyPay trả về QR URL → gửi link QR.
Nếu MonkeyPay chưa cấu hình → gửi thông tin CK thủ công.

### Bước 3: Kiểm tra thanh toán

**Tự động**: Khi user reply "đã ck", "done", "ok", "xong rồi", "đã chuyển":

Trước tiên tìm đơn pending của user:
```bash
node /root/project/.openclaw/workspace-bot/skills/upgrade-flow/flow.js find-pending {SENDER_ID}
```

Nếu có đơn pending → check thanh toán:
```bash
node /root/project/.openclaw/workspace-bot/skills/upgrade-flow/flow.js check-payment {ORDER_ID}
```

- Nếu `paid: true` → gửi key cho user (lấy từ `message` trong output)
- Nếu `paid: false` → thông báo "Chưa nhận được thanh toán, bạn đợi chút nhé"

### Bước 4: Xác nhận thủ công (Owner/Kent)

Nếu owner (Kent) muốn confirm thủ công:

```bash
node /root/project/.openclaw/workspace-bot/skills/upgrade-flow/flow.js confirm-order {ORDER_ID}
```

Lệnh này force-confirm đơn + generate key ngay lập tức.

---

## 🔑 Tạo key thủ công (không qua flow)

Nếu owner cần cấp key trực tiếp mà không qua thanh toán:

```bash
node /root/project/.openclaw/workspace-bot/skills/upgrade-flow/flow.js generate-key {DEVICE_ID} {planId}
```

- planId: `personal`, `team`, `lifetime`

---

## 📋 Quản lý đơn hàng

```bash
# Xem tất cả đơn
node /root/project/.openclaw/workspace-bot/skills/upgrade-flow/flow.js list-orders all

# Chỉ đơn pending
node /root/project/.openclaw/workspace-bot/skills/upgrade-flow/flow.js list-orders pending

# Xem chi tiết 1 đơn
node /root/project/.openclaw/workspace-bot/skills/upgrade-flow/flow.js get-order {ORDER_ID}
```

---

## ⚠️ QUY TẮC QUAN TRỌNG

1. **CHỈ áp dụng cho DM 1-1** — KHÔNG kích hoạt flow này trong group chat
2. **Luôn GHI NHỚ DeviceID** trong context conversation — user sẽ reply số plan ngay sau
3. **Không bao giờ expose private key** — chỉ gửi key đã generate cho user
4. **Nếu user gửi DeviceID mới khi đang có đơn pending** → tạo đơn mới, đơn cũ vẫn giữ
5. **Output của flow.js là JSON** — parse JSON để lấy `message` field gửi cho user
6. **Khi user hỏi "giá"/"mua"/"nâng cấp"** → chạy `show-plans` và hướng dẫn gửi DeviceID:
   > "Để nâng cấp, bạn cần gửi DeviceID cho mình. Mở Dashboard Zalo-Mod → tab Nâng cấp → copy Device ID ở góc phải → gửi cho mình."

---

## 📁 Files trong module này

| File | Mô tả |
|------|-------|
| `SKILL.md` | File này — hướng dẫn cho bot |
| `flow.js` | CLI tool xử lý logic |
| `plans.json` | Cấu hình bảng giá + bank info + MonkeyPay URL |
| `private-key.pem` | RSA private key để ký license |
| `orders.json` | Đơn hàng đang xử lý (auto-generated) |
| `history.json` | Lịch sử giao dịch hoàn tất (auto-generated) |
