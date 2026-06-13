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
