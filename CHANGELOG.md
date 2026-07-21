## [2.17.5] - 2026-07-21

### Fixed
- **Báo cáo cuối ngày không còn rỗng**: tin nhắn group được ghi vào lịch sử chat ngay tại luồng `onInbound`. Trên OpenClaw v2026.5.x, runtime plugin không nhận `before_dispatch` — nơi duy nhất trước đây gọi ghi lịch sử — nên nhóm đang follow báo cáo "0 tin nhắn" dù có chat.
- **Số member chờ duyệt không còn nhảy về 0 sai**: `getGroupInfo` dạng batch thường bỏ `pendingApprove` (Zalo chỉ trả cho admin), nên không còn ghi đè số đã biết bằng 0.
- **Modal chi tiết group**: nút gạt "Tự động báo cáo cuối ngày" không còn tự tắt lại sau khi bật Follow; nút Follow ở card nhóm mở đúng modal lịch báo cáo (kiểm tra trạng thái modal thật thay vì dò element ẩn còn sót trong DOM).

### Changed
- **Modal chi tiết group**: gộp thao tác lưu lịch báo cáo vào nút footer "Lưu" (bỏ nút "Lưu lịch báo cáo" riêng cho gọn); nút "Xem nhật ký" đổi sang kiểu outline-primary theo design system + thêm icon.
- **Bảng Nhóm**: căn trái cột Group (tên cột, tên nhóm, ID) cho dễ đọc.

## [2.17.0] - 2026-07-19

### Security
- **ClawHub-auditable release:** publish readable source and document every local/network data flow so the installed artifact can be reviewed end to end.
- **Narrowed plugin scope:** remove the unrelated Facebook crawler and all browser-cookie handling from Zalo Mod.
- **Safer dashboard:** bind to localhost by default; exposing the dashboard on another interface now requires a strong explicit token.
- **No hidden runtime inputs:** remove environment-variable credential reads, arbitrary upgrade-script paths, shell command construction, hostname/hardware fingerprinting, and the legacy local payment fallback.
- **Signed access control:** verify trial and paid entitlement proofs against the persistent random installation ID before granting Pro/Team actions.

### Changed
- Declare ClawHub-first installation metadata and publish an exact, transparent ClawPack artifact.
- Keep Free actions available per item, reserve bulk/multi-group actions for Pro, and reserve multi-bot actions for Team.

## [2.16.0] - 2026-07-19

### Added
- **Tặng 30 ngày Pro cho lần cài đầu tiên**: kích hoạt tự động bằng entitlement do license server ký RSA và gắn với Device ID; không cần nhập key thủ công.
- **Phân tầng Free / Pro / Team rõ ràng**: Free xem toàn bộ dashboard và thao tác từng group/member; Pro mở thao tác nhiều group, hàng loạt và `all`; Team mở thêm thao tác nhiều bot cùng lúc.

### Security
- **Khóa quyền ở backend thay vì chỉ ẩn nút**: mọi batch payload và hành động nhiều bot đều được kiểm tra entitlement tại API; sửa state giao diện hoặc gọi API trực tiếp không vượt được giới hạn gói.
- **Trial chống cấp lại**: máy chủ ghi nhận Device ID, fingerprint và dấu vết mạng; ngày bắt đầu/hết hạn nằm trong proof có chữ ký, không phụ thuộc đồng hồ hay file cấu hình phía client.
- **Owner claim an toàn, gọn hơn**: `i'm owner <DEVICE_ID>` thay mã dùng một lần; xác nhận một lần từ Device ID trong Dashboard và giữ ổn định qua restart/update.

## [2.15.0] - 2026-07-17

### Added
- **Test runner thật**: `npm test` chạy toàn bộ regression bằng `node:test` (trước chỉ có `node --check`). Toàn bộ chạy trên mock, không cần tài khoản Zalo.
- **OpenClaw Zalo Connect bridge v2** (`src/integration/`): service runtime cho status, capabilities, action và live group policy; capability thiếu sẽ degrade riêng thay vì làm plugin crash. Contract kỹ thuật được giữ local trong `docs_dev/`.
- **Auto-tag phản hồi agent exact UID**: gắn `{uid, pos, len}` ngay trong `deliverZaloClawReply`, dùng sender của chính scope `processMessage`; không phụ thuộc OpenClaw hooks, không dò tên, bỏ qua reasoning/status và chống A/B cross-tag.
- **TurnContext bất biến + FIFO queue per-conversation** (`src/context/turn-context.js`, `src/messaging/conversation-queue.js`): mỗi lượt mention đóng băng danh tính người gửi ngay khi nhận tin; các lượt cùng nhóm chạy tuần tự, nhóm khác song song; timeout 1 lượt không chặn lượt sau. Regression: A/B mention đồng thời 50 lần → **0 cross-tag**.
- **Mention đúng UID cho action chủ động** (`src/messaging/mention-builder.js`): payload `group-mention` lấy UID chính xác từ TurnContext, policy sender/quoted-author/all-addressed/off. Reply tự động của relay dùng run correlation + native name parser của Zalo Connect; tên trùng nhau được bỏ qua an toàn thay vì đoán UID.
- **Passive context zero-token** (`src/context/`): mọi tin group được phép ghi vào buffer + SQLite TRƯỚC mention gate (không gọi LLM); khi bot được tag, inject snapshot bounded (mặc định ≤20 tin/15 phút/≤5 tin người khác, cắt tại reply gần nhất của bot) vào prompt dưới nhãn `[UNTRUSTED RECENT GROUP CONTEXT]` kèm guard chống prompt-injection và budget ký tự. Fix kịch bản "nhắn `abc`, `xyz` rồi mới tag bot".
- **SQLite storage + migration framework** (`node:sqlite`, Node ≥22.5; tự fallback in-memory): bảng conversations/messages/attachments/turn_contexts, turn dở dang sau restart được đánh dấu failed (không double-send).

### Added (CRM core — Z4)
- **CRM backend** (`src/crm/`): Contacts (idempotent theo account+UID, tags, search/phân trang, import từ member Zalo), Leads pipeline (New → Contacted → Qualified → Quoted → Won/Lost, chuyển stage có history + undo, lý do lost), Tasks (hạn, quá hạn, link contact/lead), audit log mọi mutation, stats cho Overview. Chạy trên SQLite (migration v2); API handler thuần `handleCrmAction` test được không cần HTTP.
- **CRM UI trên dashboard**: 3 mục sidebar mới — Khách hàng, Pipeline (kanban kéo-thả + hoàn tác), Công việc. Song ngữ, responsive 375/768/991.

### Fixed
- **Silent không còn làm bot "mất trí nhớ"**: Zalo Connect bridge phát một bản sao inbound trước mention gate; Zalo Mod capture vào passive buffer zero-token. Khi user chỉ tag bot ở tin sau, bounded context của chính user được inject và bot trả lời vấn đề ngay phía trên. Chuẩn hoá timestamp Zalo từ giây sang millisecond để selector không loại nhầm tin vừa nhận là quá cũ.
- **Model thực sự nhận passive context trên OpenClaw 2026.5.x**: ghi nội dung enrich vào `BodyForAgent` thay vì chỉ `Body`; giữ `RawBody/CommandBody` nguyên bản cho slash command. Live trajectory xác nhận prompt chứa immediate intent và trả đúng câu trước khi tag.
- **Toggle Tự do / Silent / Mute áp tức thì, zero-token và không restart**: mở rộng Zalo Connect bridge v2 với runtime group-policy override. Zalo Mod map `muted/silent` → `mute/silent/free`, fan-out theo mọi ID của nhóm đa-bot, và Zalo Connect chặn ngay trong inbound listener trước relay/model. Policy vẫn lưu bền trong `settings.json` và tự replay sau một lần gateway restart thật; không còn ghi group policy vào `openclaw.json`.
- **Toàn bộ API đọc (Sync Account, danh sách nhóm/thành viên/bạn bè, profile bot/owner/user, pending, admin nhóm) chạy qua ZaloConnectBridge**: thêm `src/integration/zca-facade.js` — facade giữ nguyên chữ ký các call-site hiện có, nhưng route mọi method zca-js (getAllGroups, getGroupInfo, getUserInfo, getAllFriends, fetchAccountInfo, getPendingGroupMembers, getGroupMembersInfo) qua bridge và dựng lại đúng shape thô mà dashboard kỳ vọng. Hết lỗi "ZCA API unavailable". `scanGroupMembers` lấy tên cả nhóm trong 1 call (get-group-members-info theo groupId) thay vì gọi từng member.
- **Bot "câm" chiều gửi ra khi chạy với Zalo Connect** (`sendDmMsg/sendGroupMsg skipped — API unavailable`): mọi send production route qua Zalo Connect bridge service; outbound adapter public là degrade path cho text/media cơ bản. Tin xác nhận owner, moderation và dashboard composer hoạt động trở lại.

### Changed
- **Zalo Connect-only trong production**: OpenClaw Zalo Connect sở hữu session/listener/transport; Zalo Mod sở hữu dashboard/policy/context/automation. Không còn nhánh transport hay migration Zalouser trong runtime hiện tại.
- Debug log mỗi tin nhắn (`[ZALO-MOD-DEBUG]`) chỉ còn in khi `ZALO_MOD_DEBUG=1` (trước in JSON đầy log ở mọi tin).

## [2.14.4] - 2026-07-03

### Added
- **Mục "Nhật ký" riêng trên sidebar**: xem tóm tắt chat theo ngày, note, memory, chat thô và lịch báo cáo của từng nhóm ngay trong dashboard (trước chỉ có modal). Chọn nhóm + nút "Tổng hợp lại" + tab ngày (Hôm nay/Hôm qua/Chọn ngày) gom gọn trong một khung.
- **Mục "Cài đặt" riêng** chia 2 cột: **Tùy chỉnh** (ngôn ngữ, sáng/tối, giảm chuyển động) và **Thông tin** (gói bản quyền + hạn dùng nổi bật màu xanh, Device ID kèm nút copy, phiên bản plugin).

### Changed
- Bỏ khu "Nâng cao (nguy hiểm)" (3 action Locked không dùng được) khỏi Cài đặt và sidebar — UI gọn hơn.
- Bỏ label "Chọn nhóm:" thừa ở trang Nhật ký — dropdown tự giải thích.

### Fixed
- **Tối ưu mobile/tablet toàn dashboard**: menu tab Nhật ký thành hàng chip cuộn ngang trên màn nhỏ (hết gãy 2 dòng); Danh mục API về 1 cột trên mobile (hết cắt chữ tên API); tăng vùng chạm nút; soát 12 section không còn tràn ngang ở 375/768/991px.

## [2.14.3] - 2026-07-03

### Fixed
- **Số member chờ duyệt (pendingCount) luôn hiển thị 0**: code đọc nhầm field `pendingCount` (không tồn tại) từ `getGroupInfo` — count thật nằm ở `pendingApprove.uids`. Nay đọc đúng → hiển thị đúng số chờ duyệt. Thêm **tự làm mới mỗi ~3 phút** (batch `getGroupInfo` cho mọi group, không cần bấm Sync) — memberCount cũng được làm mới cùng lúc.

## [2.14.2] - 2026-07-03

### Fixed
- **Mất PRO sau khi update/restart (Docker)**: `deviceId` trước tính từ `os.hostname()` = container id, ĐỔI mỗi lần recreate container → key device-bound mất hiệu lực → tụt về FREE. Nay **persist `deviceId` vào `plugins-data/zalo-mod/device-id`** (volume mount) → ổn định qua update/restart/recreate.
- **Mất logo + favicon sau khi cài từ ClawHub/npm**: `logo.png` chưa nằm trong `files` whitelist nên không được đóng gói. Đã thêm → sidebar logo + favicon hiển thị đúng sau khi cài.

## [2.14.1] - 2026-07-03

### Security
- **Ngừng ship API key thanh toán ra client**: bỏ khối `monkeypay` (chứa `apiKey`) khỏi `upgrade/plans.json`. Luồng thanh toán chính đã đi qua license server (`/v1/orders`, key giữ ở server); flow cũ chỉ là fallback → giờ tự xuống "CK thủ công" (hiển thị đúng STK từ `bankInfo`). Key merchant không còn nằm trong bản phân phối.

## [2.14.0] - 2026-07-03

### Added
- **`/note` thông minh — tự đặt lịch nhắc**: note có mốc thời gian ("nhắc 2 phút nữa", "8h sáng mai", "mỗi sáng 8h") được AI/parser phân loại → plugin tự nhắc vào nhóm đúng giờ (chính xác đến giây qua `setTimeout`, poll 60s làm lưới an toàn, khôi phục sau restart). Note thường thì chỉ lưu. Lưu ở `reminders.json`.
- **Tổng hợp `/history` rõ người**: thêm `👥 Người tham gia` (đếm số tin) + `🗣️ Ai nói gì` (keySpeakers). Tự resolve ID→tên (kể cả log cũ) nên không còn hiện dãy số.
- **Auto-duyệt member (`pendingAuto`) chạy thật**: quét ~2 phút/lần, tự duyệt yêu cầu tham gia — chỉ khi tài khoản bot là Phó/Trưởng nhóm; lọc theo `pendingBlockKeywords`. Có modal cảnh báo trước khi bật.
- **Modal cảnh báo** thay cho `alert()`/`confirm()` trình duyệt khi kick member và khi bật Tự duyệt (đỏ, có tên rõ ràng).

### Changed
- **Gộp Tracking vào Follow**: một tính năng duy nhất tên **Follow** (theo dõi nhóm = ghi lịch sử chat + memory). UI còn 1 badge Follow; `follow-on/off` là lệnh chuẩn (`tracking-on/off` giữ alias). Dữ liệu `tracking` cũ tự tương thích.
- **Thông tin bot hết trùng lặp**: nguồn chuẩn ở `config.json > bots.<profile>`; `openclaw.json` chỉ giữ `enabled` + `hooks`, không mirror `botName/zaloDisplayNames/dashboardPort` nữa.
- **Đồng bộ hồ sơ đa-agent**: avatar/sđt/ngày sinh của member giờ thử tất cả bot rồi gộp (bot nào kết bạn thì lấy được sđt/ngày sinh).

### Fixed
- **Chống bypass license**: bỏ backdoor key `DEV-*` không ký; `getLicenseStatus` verify lại chữ ký RSA (bind deviceId + hạn) mỗi lần đọc → sửa tay `license.json` hay đổi máy đều vô hiệu.
- **AI summary/report hết lỗi**: đọc API key 9router thật từ `openclaw.json` (trước hardcode `sk-no-key` → 401 "API key required").
- **Cài đặt đa-bot đồng bộ**: bật/tắt silent/welcome/follow… áp cho MỌI ID bot của cùng nhóm (fan-out `siblingGroupIds`); reload `settings.json` khi đổi (double-register không còn đọc state cũ).
- **Kick member**: sửa thứ tự tham số `removeUserFromGroup(memberId, groupId)` + payload lồng đúng (trước báo "Nhóm không có thành viên").
- **Số member cộng đồng**: hiển thị `totalMember` thật (vd 484) thay vì số liệt kê được (3). (Danh sách đầy đủ cộng đồng là giới hạn Zalo — sẽ xử lý qua PC App API ở phase sau.)

## [2.12.0] - 2026-07-01

### Added
- **Tổng hợp lịch sử chat theo ngày bằng AI**: lệnh `/<prefix>history [ngày]` + nút "Tổng hợp lại" trong UI. AI (smart-route) đọc chat trong ngày → tóm tắt overview, điểm nổi bật, chủ đề lặp lại, ai gửi link gì, ai note/memory gì, ai hẹn lịch gì. Link/note/memory được tách chính xác bằng code, AI lo phần còn lại.
- **Tab "Nhật ký nhóm"** trong chi tiết group: xem tóm tắt theo ngày, note, memory, chat thô, và cấu hình lịch báo cáo.
- **Lịch báo cáo tự động cuối ngày** (giờ VN): bật theo từng nhóm (`autoSummary`), chọn giờ + nơi gửi (đăng vào nhóm / DM owner).
- **Mục Phân quyền** riêng trên sidebar: quyền DM (all/friends/list/owner/none), quyền Group (all/list/none), quyền lệnh `/note`·`/memory` (owner/admin/list/all) — chọn trực quan từ danh sách member (có avatar + vai trò) và nhóm, dropdown hiện đại, song ngữ.
- **`/note`** lưu note có cấu trúc vào `notes.json`; **`/memory`** lưu tri thức nhóm (agent đọc được, có dedup).
- **Chat history JSON** theo ngày VN (`chat-history/<gid>/<ngày>.jsonl`, append-only) làm nguồn cho tóm tắt.

### Fixed
- **Đồng bộ nhóm nhiều bot**: gộp profile các bot vào 1 nhóm (CSV) thay vì ghi đè; badge hiện đủ bot. Sửa lỗi `mergeProfileStr` chèn nhầm "default" vào nhóm chỉ có bot khác (khiến 1 bot dính nhóm nó không ở).
- **Định danh per-account của Zalo**: cùng 1 nhóm có ID khác nhau theo từng bot → gộp hiển thị theo tên để 1 dòng hiện đủ badge cả 2 bot; lọc ghost group bằng `getGroupInfo`.
- **Bot phản hồi đúng danh tính**: tin nhắn group resolve bot theo `ctx.accountId` (bot nhận tin) thay vì profile ghi nhận của nhóm; tự lấy tên hiển thị riêng cho từng bot khi sync.
- **Welcome bền vững qua restart**: baseline thành viên lấy từ `group-members.json` trên đĩa (không còn nuốt member vào lúc bot offline, không chào lại sau restart).
- **Tối ưu ghi `group-members.json`**: chỉ ghi khi có thay đổi thật (hết hiện tượng file nhảy/nhấp nháy + tốn I/O).
- Sửa `runDashboardZcaAction` dùng nguyên chuỗi profile CSV làm tham số gọi API Zalo (gây "No active Zalo API instance").

## [2.11.2] - 2026-06-29

### Fixed
- **Badge tính năng per-group cập nhật ngay (Silent/Welcome/Tracking/Follow/Mute/Auto approve)**: Bấm bật/tắt badge của một group giờ vẽ lại trạng thái on/off ngay lập tức. Trước đây không re-render nên badge giữ nguyên màu cũ → dễ bấm nhầm lần 2 và vô tình đảo ngược (vd tắt Silent xong tưởng chưa tắt, bấm lại thành bật → bot vẫn im lặng).
- **Nút "Select all" ở trang Nhóm hiển thị trạng thái active**: Khi đã chọn tất cả group đang hiển thị, nút sáng lên (primary) và đổi chữ thành "Clear all"; bấm lần nữa để bỏ chọn hết.

## [2.11.1] - 2026-06-13

### Fixed
- **Sửa lỗi đa ngôn ngữ giao diện (i18n)**: Dịch thuật toàn bộ giao diện và placeholder/modal trong tab Facebook Crawler và tab Rules & Cmds (Quản lý Lệnh & Rules).
- **Sửa lỗi crash khi load trang (Temporal Dead Zone)**: Sửa lỗi tham chiếu sớm đối với biến `fbState` bằng cách đổi khai báo từ `let` sang `var`.
- **Sửa lỗi liệt tab Facebook Crawler**: Bổ sung hàm global `window.switchUtilTab` bị thiếu để chuyển đổi mượt mà giữa các tab phụ (Filter Conditions, Cron Scheduler, Report Targets, v.v.).
- **Khôi phục cảnh báo Cookie**: Hiện lại khung hiển thị cảnh báo bảo mật khuyên dùng tài khoản phụ và tuyên bố miễn trừ trách nhiệm trong tab Facebook Cookies.

## [2.11.0] - 2026-06-13

### Added
- **Trình chỉnh sửa templates slash command (Rules & Cmds Editor)**: Thêm giao diện quản lý và chỉnh sửa trực quan các mẫu lệnh slash command như nội quy, hướng dẫn, menu trực tiếp từ dashboard.

## [2.10.0] - 2026-06-05


### Added
- **Chế độ Multi-Bot (Multi-Bot Support)**: Hỗ trợ cấu hình và quản lý độc lập nhiều tài khoản Zalo cùng lúc thông qua thuộc tính `bots` trong `config.json`. Tự động ánh xạ profile và tải ảnh đại diện tương ứng từ Zalo API.
- **Cải tiến UI/UX hiện đại & Tối ưu trên Mobile/Tablet**:
  - Thêm thanh lọc bot phụ (`#mobileBotFilterBar`) hiển thị dạng trượt ngang trên mobile/tablet.
  - Sử dụng các Bot Pills trực quan chứa avatar hoặc ký tự viết tắt của bot với gradient màu sắc.
  - Tự động thay đổi padding thông qua lớp `.has-sub-topbar` trên `body` để tránh đè lấp giao diện khi cuộn trang hoặc resize.
- **Cải tiến logic xử lý lệnh Slash**:
  - Cô lập tiền tố lệnh (`prefix isolation`): Khi nhiều bot cùng ở chung nhóm, nếu lệnh slash không khớp với tiền tố riêng (`cmdPrefix`) của bot, plugin sẽ tự động chặn hoàn toàn (`{ handled: true }`) thay vì gửi lên LLM, tránh tình trạng phản hồi trùng lặp hoặc sai bot.
  - Hỗ trợ trích xuất và xử lý lệnh linh hoạt hơn từ bất kỳ vị trí nào trong nội dung tin nhắn.
- **Cập nhật File Cấu hình (Config Separation)**:
  - Tách cấu hình tối giản trong `openclaw.json` (chỉ chứa 4 khóa được cấp phép) và cấu hình chi tiết (chứa cài đặt nâng cao và danh sách `bots`) trong `config.json` để tránh bị gateway quét xóa.

## [2.9.5] - 2026-06-05


### Fixed
- **Fix Zalo Send API resolution**: Added support for container path mapping (`_openclawHome/.openclaw`) inside `index.js` to locate `@openclaw/zalouser`'s `test-api.js` correctly.
- **Fix synchronous fs calls type error**: Replaced `fs.existsSync` and `fs.readFileSync` with `existsSync` and `readFileSync` (from `node:fs`) to fix crash when loading credentials.
- **Permissions**: Proactively set permissions to `755` using pure node `chmod` to satisfy gateway world-writable plugin block constraints.
- **UI & CSS Refinements**: Fixed horizontal overflow, sticky mobile header, centered bottom navigation bar, and hidden slider knob on the language switcher flags.

## [2.9.3] - 2026-06-03

### Changed
- Compatibility adjustments and minor maintenance updates.

## [2.9.2] - 2026-06-01

### Fixed

- **Critical: Fix dual-login destroying cipher keys.** Removed `checkZaloAuthenticated` fallback from `getSafeZaloApi()`. This function called `ensureApi()` → `zalo.login()` which created new cipher keys, breaking the existing bot session and disconnecting the bot. Now only reuses shared API from `globalThis.__zcaApiByProfile`.
- Removed dead code: `loadZaloSession()`, `_zaloCookies`, `_zaloImei` (directly reading credentials was redundant and risky).

### Changed

- **Config separated from openclaw.json.** All plugin config now lives in `plugins-data/zalo-mod/config.json`. Only 4 keys remain in openclaw.json configSchema: `botName`, `zaloDisplayNames`, `ownerId`, `dashboardPort`. Auto-migration on first load.
- **groupNames no longer written to openclaw.json.** `group-names.json` in plugin-data is the sole source of truth (migration was already in place, this removes the write-back).
- `_patchOpenclawConfig()` now filters keys: only allowed keys go to openclaw.json, overflow goes to config.json.
- `allowedDmUsers` changes now save to `config.json` directly via `savePluginConfig()`.
- **Fix config migration losing botName/ownerId/zaloDisplayNames.** Previous version's `additionalProperties: false` in configSchema caused OpenClaw SDK to strip existing config before plugin could migrate them. Changed to `additionalProperties: true`. Migration now reads directly from openclaw.json file (bypassing SDK schema stripping) and auto-recovers empty config.json.


## [2.7.8] - 2026-05-27

### Fixed

- Fix silent mode bypass for Free users: license gate was returning early before reaching the silent mode check, causing bot to respond to all messages even when silent badge was enabled on dashboard.
- Free users now correctly go through @mention detection and silent mode check. Only slash commands are gated behind Pro.

## [2.7.7] - 2026-05-27

### Fixed

- Auto-patch `@openclaw/zalouser` dist file on load to expose `globalThis.__zcaApiByProfile` — enables shared ZCA API Map between `zalouser` channel and `zalo-mod` plugin without requiring a new `zalouser` release.
- Dynamically detects `zalo-js-*.js` filename (hash varies per release) so the patch works across all `zalouser` versions.
- Idempotent: skips patching if `globalThis.__zcaApiByProfile` is already present.

## [2.7.5] - 2026-05-26

### Fixed

- Removed invasive runtime self-patching of `@openclaw/zalouser/dist/zalo-js-*.js` from `zalo-mod`.
- Stopped mutating another plugin's installed package on disk, reducing risk of registry/load-state drift and UI login inconsistencies.
- Kept `zalo-mod` non-invasive: it now only reuses a shared ZCA API map if `zalouser` exposes one itself, otherwise it falls back safely.

## [2.6.0] - 2026-05-25

### Added

- **Hệ thống Zalo Owner Dashboard (Giao diện đồ họa Quản trị):**
  - Thêm mới hoàn toàn trang **Tổng quan vận hành (Operations Overview)**: Theo dõi trạng thái, số lượng group, thành viên chờ duyệt, friend request, và logs hoạt động theo thời gian thực.
  - Thêm mới tab **Quản lý Nhóm (Groups)**: Cho phép xem danh sách nhóm, trạng thái tính năng (Silent, Welcome, Muted, Spam watch), xem link mời nhóm, xem danh sách Admin, và cấu hình nhanh.
  - Thêm mới tab **Thành viên & Duyệt (Members)**: Cho phép duyệt nhanh thành viên đang chờ duyệt (Pending approval), xem danh sách thành viên vi phạm/cảnh cáo.
  - Thêm mới tab **Gửi tin nhắn (Composer)**: Soạn và gửi tin nhắn, ảnh trực tiếp đến các group thông qua ZCA API thật. Giao diện soạn thảo hiện đại, trực quan, hỗ trợ preview.
  - Thêm mới tab **Danh mục API (API Directory)**: Liệt kê đầy đủ các API ZCA khả dụng cùng hướng dẫn chi tiết.
  - Thêm mới tab **Nâng cấp (Upgrade)**: Kích hoạt bản quyền qua Device ID của thiết bị để mở khóa các tính năng quản lý nâng cao.
  - Tích hợp **Dark Mode / Light Mode** cùng chuyển đổi đa ngôn ngữ (Tiếng Việt / Tiếng Anh) tức thì qua 1 cú click.

## [2.5.2] - 2026-05-12

### Fixed

- Fixed `fs` module imports and usage (`existsSync`, `readFileSync`, `writeFileSync`, `mkdirSync`) avoiding `fs/promises` mismatch during config loading.
- Redesigned `getSafeZaloApi()` to directly use `zca-js` with `zalouser` credentials, completely removing the failing dependency on `@openclaw/zalouser/test-api.js` in Docker.
- Prevented WebSocket conflicts by explicitly stopping the `zca-js` listener in the `withZaloApiShim` wrapper.

## [2.5.0] - 2026-05-07

### Removed

- Removed all Zalo reaction logic (`reactToCurrentMessage`, `autoReactBeforeHandling`, and related hooks) to improve event-loop performance and prevent watchdog crashes on resource-constrained VPS instances.
- Removed `## ZALO REACTION` documentation from `SKILL.md` auto-generation.

## [2.4.20] - 2026-05-07

### Added

- Auto-append ZALO REACTION instructions to TOOLS.md when generating workspace bot configs, enabling proper use of the `message` tool for native emoji reactions.

## [2.4.19] - 2026-05-06

### Fixed

- Slash command với prefix không đúng (của bot khác) nay được chặn hoàn toàn { handled: true }, không để lọt lên LLM.
- Sửa lỗi Williams không phản hồi do file bị quyền 777 sau khi copy từ Windows.

## [2.4.18] - 2026-05-06

### Fixed

- Template builders (uildNoiQuy, uildWelcome) now use dynamic otName and cmdPrefix instead of hardcoded values.

## [2.4.17] - 2026-05-06

### Fixed

- Fix `fs.existsSync` error in ZCA initialization by using `require('fs').existsSync`.
- Prevent Zalo websocket conflict by explicitly stopping listener after REST API initialization.

## [2.4.16] - 2026-05-06

### Fixed

- Fix 'ZCA unavailable' error by dynamically resolving zca-js module path relative to \_openclawHome instead of using a hardcoded Linux container path.

## [2.4.15] - 2026-05-06

### Fixed

- Persist `ownerId` and other auto-detected config updates to `openclaw.json` instead of only mutating the in-memory copy.

## [2.4.14] - 2026-05-06

### Changed

- Keep private architecture notes out of Git and ClawHub packages while retaining the runtime hook activation fix.

## [2.4.13] - 2026-05-06

### Fixed

- Force `zalo-mod` into the OpenClaw gateway startup plugin plan with `activation.onStartup` and `activation.onCapabilities: ["hook"]`, so `before_dispatch` is registered before Zalo messages reach the model.
- Fix permission self-healing to keep directories at `755` and files at `644`; the previous chmod pass could make `node_modules/` and `data/` non-traversable after plugin load.

### Docs

- Updated `docs/ARCHITECTURE.md` to match the verified OpenClaw v2026.5.4 behavior: successful startup now shows `4 plugins: browser, memory-core, zalo-mod, zalouser`.

## [2.4.11] - 2026-05-06

### Fixed

- OpenClaw v2026.5.x compatibility: removed deprecated `kind: "runtime"` from `definePluginEntry` and `openclaw.plugin.json`.
- Auto-fix world-writable permissions caused by Windows bind mounts with pure Node `fs.chmodSync`.
- Improved `_openclawHome` path resolution for both `extensions/` and legacy `npm/node_modules/` install paths.
- Added fallback hooks with `before_model_resolve` and `before_agent_reply` for the `im admin` command.

### Changed

- Plugin must be installed with `openclaw plugins install` inside Docker so the `openclaw` peer dependency symlink points at the container runtime.

## [2.4.10] - 2026-05-05

### Fixed

- Added `.clawhubignore` so ClawHub packaging skips development-only files.

## [2.4.9] - 2026-05-05

### Fixed

- Kept runtime ID `zalo-mod` for ClawHub compatibility while package name remains `openclaw-zalo-mod`.
- Setup script migrates wrong config entry `openclaw-zalo-mod` to runtime entry `zalo-mod`.

## [2.4.8] - 2026-05-05

### Fixed

- Changed `package.json.name` back to `openclaw-zalo-mod` so ClawHub publishes under the correct package ID.

## [2.4.7] - 2026-05-05

### Fixed

- Synchronized plugin ID across runtime, setup script, and docs.

## [2.4.6] - 2026-05-05

### Added

- Added `bump-version.js` to synchronize versions.
- Added `.agent/workflows/update.md`.
- Added `i'm admin` owner claim support.

### Removed

- Removed `PUBLISHING.md`.
