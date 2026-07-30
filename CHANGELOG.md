## [2.19.2] - 2026-07-30

### Added
- **Sai bot tạo và sửa lịch báo cáo bằng lời.** Owner nhờ bot đổi giờ thì bot trả lời *"phần điều khiển hiện tại chưa nhận lệnh cập nhật, sếp vào dashboard đổi giúp"* — đúng, vì `report-job-save` **không** nằm trong allowlist của agent: bot đọc được lịch mà không ghi được. Nay bot đọc (`report-jobs`), **tạo/sửa** (`report-job-save`), xem trước (`report-digest-preview`) và gửi thử (`report-job-run`) được. Skill có ví dụ cụ thể cho: đổi giờ, tạo lịch tổng hợp cho tất cả nhóm, tạo lịch cho vài nhóm chỉ định.
- **XOÁ lịch vẫn cần `agentTools.allowDestructive`.** Tạo/sửa thì thoải mái, nhưng lịch là cấu hình owner đã dựng — bot đọc sai một câu mà xoá thì phải dựng lại từ đầu.

### Fixed
- **`report-job-save` sửa được MỘT PHẦN.** Handler cũ **thay toàn bộ** job, nên dù có quyền, bot gửi `{ id, time: "17:30" }` (cách tự nhiên để đổi giờ) sẽ làm rỗng `groups` rồi ném lỗi *"Chọn ít nhất một nhóm"*. Dashboard không gặp vì nó luôn gửi object đầy đủ. Nay merge lên bản hiện có theo `id`, kể cả merge sâu `deliver` — bật `ownerDm` không làm mất `eachGroup`/`groups`.

### Notes
- 197 test xanh (thêm 4: quyền tạo/sửa, xoá phải bật công tắc, merge một phần không mất `groups`, và luật gói của lịch báo cáo).

## [2.19.1] - 2026-07-30

### Fixed
- **Xoá lịch báo cáo không có tác dụng — lịch vừa xoá hiện lại ngay.** Migration lịch cũ dùng *"danh sách lịch rỗng"* làm dấu hiệu **chưa migrate**, mà đó cũng đúng là trạng thái **sau khi owner xoá hết** — nên nó dựng lại đúng những lịch vừa bị xoá, mỗi phút một lần. Nay có cờ riêng `migratedLegacyAt` trong `report-jobs.json`, độc lập với số lượng lịch: migration chạy đúng một lần trong đời, và trạng thái "không có lịch nào" được tôn trọng. Ghi lại lịch cũng không làm mất cờ (không thì lần lưu sau lại mở đường cho migration chạy lần hai). Không có lịch cũ để chuyển thì vẫn đóng cờ, khỏi quét lại mỗi phút.
- Tên lịch sinh từ migration nay kèm nơi nhận (`Lịch cũ 22:30 · DM owner`) — cùng một giờ nhưng khác nơi nhận sẽ ra nhiều lịch, trùng tên thì owner nhìn danh sách không phân biệt được.

### Notes
- 193 test xanh (thêm 4 test hồi quy khoá đúng ca "xoá rồi mọc lại").

## [2.19.0] - 2026-07-30

### Added
- **Lịch báo cáo là thực thể riêng, có báo cáo TỔNG HỢP.** Trước đây lịch là 4 setting rời trên từng nhóm (`autoSummary`/`reportTime`/`reportDeliverThisGroup`/`reportDeliverOwnerDm`) nên không thể diễn tả "12 nhóm này gộp thành MỘT tin lúc 22:30, gửi DM owner" — mỗi nhóm bắn một tin dài, khó đọc và bị Zalo cắt giữa câu. Nay mỗi lịch chọn: tập nhóm (`*` = tất cả, resolve **lúc chạy** nên nhóm mới tự vào lịch) · giờ · kiểu (**lẻ từng nhóm** hoặc **tổng hợp**) · nơi nhận (DM owner / chính nhóm đó / một nhóm nhận chung). Tạo bao nhiêu lịch cũng được. Trang mới: **Nhật ký → Lịch báo cáo**.
- **Digest không tốn thêm token.** Bản tóm tắt từng nhóm đã được model viết và lưu ở `summaries/<gid>/<date>.json`, nên digest chỉ chọn lọc lại (mỗi nhóm tối đa 3 điểm, ưu tiên `highlights`, việc có hẹn gắn ⚠️) — thêm digest là **0 lần gọi model**.
- **Digest tự cắt theo ranh giới NHÓM.** Không chỗ nào trong code cắt tin, nên tin dài bị chính Zalo cắt giữa câu. Digest tự chia thành "phần 1/2" tại ranh giới nhóm, header lặp mỗi phần, footer chỉ ở phần cuối. Nút **Xem trước** hiện luôn số ký tự và số tin sẽ gửi.
- **Bot thao tác được ~141 action của zalo-connect** qua cửa `zalo-api` (dùng `bridge.executeAction` đã có sẵn). Sửa đúng hai ca owner báo: *"kêu bot đổi tên nhóm nó nói không làm được"* (zalo-mod chỉ bọc 43/141 action nên thật sự không có `rename-group`) và *"kêu bot cập nhật welcome nó nói không làm được"* (thiếu action đọc — `save-templates` vốn đã cho phép nhưng bot không có cách nào biết `key` nào hợp lệ).
- **`get-templates`**: đọc danh sách key hợp lệ + nội dung hiện tại của cả 6 template.

### Security
- **Cửa `zalo-api` deny-by-default.** 141 action xếp hạng tường minh trong `src/agent/connect-actions.js`: read 54 / write 73 / destructive 14. Action **chưa được xếp hạng** thì bot không gọi được — nhờ vậy zalo-connect thêm API mới ở bản sau **không tự động lọt** ra cho bot, phải có người đọc và xếp hạng trước.
- **14 action không hoàn tác vẫn mặc định TẮT** (`disperse-group`, `change-group-owner`, `invite-to-groups`, `unfriend`…). Owner bật bằng `agentTools.allowDestructive` — cùng công tắc mà kick/block/leave đang dùng. Rủi ro ở đây không đối xứng: bot đọc sai một câu là giải tán nhóm khách, không có nút hoàn tác.
- **Luật gói soi vào lời gọi thật, không chỉ tầng ngoài.** `zalo-api` gói lời gọi vào `payload.params`, nên nếu chỉ đếm đích ở tầng ngoài thì mọi thứ tụt xuống hạng free và **bot trở thành đường lách gói** — owner Free chỉ cần nhờ bot là làm được thao tác hàng loạt của PRO. `requiredTierForAction` nay đếm `threadIds`/`groupIds`/`userIds`/… **bên trong** `params`: một đích = Free làm được, nhiều đích = PRO, nhiều profile = TEAM.

### Fixed
- **Nhãn menu sidebar gán theo `data-section`, không theo thứ tự mảng.** `setAllText` gán nhãn theo index, nên thêm một mục menu là **toàn bộ nhãn phía sau lệch một bậc** — "Nhật ký" hiện ra kèm con là "Bạn bè"/"Tin nhắn". Giờ thêm/bớt/đổi chỗ mục menu bao nhiêu cũng không sai.
- **Checkbox trong trang lịch báo cáo không còn bị rule toàn cục `input, select, textarea { width:100%; min-height:40px }` kéo thành khối rộng ~230px** (thêm class `.report-check`).
- **Audit log hiện rõ bot đã gọi action nào**: `zalo-api → rename-group` kèm mức (read/write/destructive), thay vì 20 dòng "zalo-api" giống nhau.

### Changed
- Thanh tab trong **Nhật ký nhóm** còn 3 mục: Tóm tắt · Note · Memory. Bỏ "Chat thô" và "Lịch báo cáo" (lịch có trang riêng vì một lịch trải trên nhiều nhóm).
- Tab lịch trong nhật ký nhóm thành **chỉ đọc** (hiện nhóm này thuộc lịch nào + đường sang trang sửa). Giữ hai trình sửa ghi hai mô hình khác nhau là tự tạo hai nguồn sự thật; đã xoá bộ chọn nhiều nhóm + handler cũ (~90 dòng).
- `save-report-schedule` thành **legacy**: chỉ còn ghi 4 setting per-group mà scheduler không đọc nữa (giữ cho dashboard/script cũ + làm nguồn migrate), và **bỏ khỏi allowlist agent** — để bot gọi vào thì im lặng vô tác dụng, tệ hơn báo lỗi.
- Cấu hình lịch cũ được **tự gộp thành lịch mới** khi chạy lần đầu, nhóm theo (giờ + nơi nhận) nên 24 nhóm cùng 22:30 ra **một** lịch chứ không phải 24 lịch vụn.

### Notes
- 189 test xanh (thêm 24: 11 cho lịch báo cáo/cắt digest, 13 cho phân hạng + luật gói của `zalo-api`).
- Giới hạn gói không đổi: **Free = xem + thao tác lẻ, PRO = hàng loạt, TEAM = nhiều bot**; cài lần đầu vẫn được tặng PRO trial 30 ngày.

## [2.18.3] - 2026-07-27

### Fixed
- **Trang Phân quyền trắng trang khi chỉ có 1 bot.** Thanh chọn bot ở topbar chỉ được render khi có **nhiều hơn 1** bot, nên máy 1 bot thì bộ lọc bot mãi ở trạng thái "tất cả bot" — và trang Phân quyền (vốn cần biết đang cấu hình cho bot nào, vì mỗi bot có group riêng) chỉ hiện đúng một câu *"Chọn 1 bot cụ thể ở thanh chọn bot phía trên"* trong khi **thanh đó không tồn tại**. Nay khi chỉ có 1 bot thì trang tự suy ra bot đó ("tất cả bot" và "bot duy nhất" là một) và render bình thường. Máy nhiều bot giữ nguyên hành vi cũ: vẫn yêu cầu chọn bot cụ thể để danh sách nhóm không bị gộp chéo và hiện nhóm dùng chung hai lần.
- **Chưa có bot nào**: trạng thái rỗng nay chỉ tới nút **Sync Account** thay vì chỉ tới thanh chọn bot rỗng.
- **Mở tab Phân quyền trước khi `/api/state` trả về**: hiện "Đang tải..." rồi **tự nạp lại** khi có state, thay vì đứng im hoặc báo sai "chưa có bot nào".

### Notes
- Đã kiểm cả 2 chiều trên môi trường thật: dashboard 1 bot (native, Minh Khang) render đủ 3 card quyền, và dashboard 2 bot (Docker, William + Mkt) vẫn hiện hướng dẫn chọn bot rồi render đúng sau khi chọn — không lỗi console ở cả hai.

## [2.18.2] - 2026-07-27

### Added
- **Bot tự điều khiển Zalo Mod bằng ngôn ngữ tự nhiên — hết cảnh "đã mute rồi" mà badge vẫn tắt.** Trước đây Zalo Mod chỉ có 3 mặt tiền đổi cấu hình: slash command (zero-token, LLM không thấy), dashboard (token-gated) và timer nội bộ. Khi owner nhắn "mute nhóm A, nhóm B" bằng lời, tin đó lọt lên LLM nhưng LLM **không có tool nào** để ghi state nên trả lời nghe-hợp-lý mà không có gì thay đổi. Nay plugin đăng ký 4 agent tool: `zalo_mod_groups` (đọc trạng thái thật mọi toggle), `zalo_mod_settings` (bật/tắt mute/silent/welcome/follow/tracking/pendingAuto/autoSummary theo TÊN nhóm, không cần groupId), `zalo_mod_history` (đọc lịch sử chat + ghi chú + memory của nhóm đang follow, tự tổng hợp hoặc gọi bộ tổng hợp có sẵn), `zalo_mod_action` (chạy đúng action mà mỗi nút dashboard gọi). Owner **không cần nhớ slash command, không cần tự bấm badge**.
- **Skill `zalo-mod-control` ship kèm plugin.** Khai trong `openclaw.plugin.json` → host tự symlink vào `<OPENCLAW_HOME>/plugin-skills/` cho **mọi agent**, luôn khớp version plugin, không cần copy tay vào từng workspace. Skill dạy luật cứng "không báo đã đổi khi chưa có kết quả tool", cách map ý định tiếng Việt → tool nào, và quy tắc chống prompt-injection (chỉ hành động theo chỉ thị trực tiếp của owner).
- **Chẩn đoán `agent-tools-status`** (chỉ đọc, token-gated): kiểm tra một senderId được cấp tool nào, kèm `probe` chạy thật tool chỉ-đọc — xác minh cổng owner mà không cần gửi tin Zalo.

### Fixed
- **Toggle từ slash command không còn lệch với badge dashboard.** Slash và dashboard trước đây có 2 implementation ghi riêng: `/mute` ghi settings cho ĐÚNG MỘT groupId nhưng lại đồng bộ runtime cho toàn bộ groupId cùng nhóm, còn dashboard ghi cho mọi id. Hệ quả trên máy nhiều bot: owner gõ `/rules mute <gid> on` với gid của bot A thì badge cùng nhóm đó dưới bot B **vẫn tắt**. Nay slash, dashboard và agent tool dùng chung một hàm ghi duy nhất (`applyToggleSetting`) — fan-out sibling + lưu + đồng bộ runtime policy y hệt nhau.
- **11 chỗ hiển thị chuỗi thô `${cmdPrefix}` cho người dùng** (dùng nháy đơn thay vì backtick), ví dụ `⚠️ Cú pháp: ${cmdPrefix}rules mute all on/off`. Thêm 3 chỗ tương tự ở panel DM whitelist / danh sách group / danh sách admin.
- **Skill trong workspace không còn đóng băng và không còn bỏ sót bot.** Bootstrap trước đây chỉ ghi vào workspace của agent **đầu tiên** (máy nhiều bot thì bot thứ 2 trở đi không có skill) và chỉ ghi khi file **chưa tồn tại** (nên sau v1.2.0 update plugin không cập nhật được skill). Nay ghi cho mọi agent trong `agents.list`, có dấu version để cập nhật, giữ nguyên file người dùng đã sửa tay, và tự bỏ qua khi host đã publish skill native.

### Changed
- **Bảng lệnh gom về một nguồn duy nhất** (`src/agent/commands.js`). Trước đây danh sách slash command bị copy-paste ở 4 chỗ trong `index.js` (menu markdown, SKILL.md, panel owner DM, panel admin group) nên chắc chắn lệch mỗi lần thêm lệnh. Panel owner và panel admin nay render từ catalogue này.

### Notes
- **Tool chỉ owner dùng được.** Chặn 2 lớp: với người không phải owner thì tool **không xuất hiện** trong prompt, và `execute` kiểm tra lại lần nữa với danh sách owner đọc live. `requesterSenderId` lấy từ inbound context do host cấp, **không bao giờ** nhận từ tham số của model. Lượt không có người gửi (cron/CLI/heartbeat) cũng không được cấp tool.
- **Action tiền/license/quyền truy cập bị chặn cứng** với agent (`create-payment`, `activate-license`, `check-payment-status`, `cancel-payment`, `refresh-license`, `save-permissions`). Nhóm không hoàn tác được (`remove-user`, `block-member`, `leave-group`, gửi lời mời kết bạn…) mặc định **tắt**, bật bằng `agentTools.allowDestructive: true` trong config plugin.
- **Licensing giữ nguyên như dashboard**: `zalo_mod_settings` một nhóm → đi đường `toggle-setting` (gói FREE dùng được, y như bấm badge); nhiều nhóm → `bulk-toggle-setting` (cần PRO/TEAM). Khi bị giới hạn gói, tool trả lỗi kèm gợi ý làm từng nhóm một — bot **nói thật** thay vì báo thành công.
- Đã kiểm chứng trên 2 môi trường host OpenClaw 2026.7.1-2: **native macOS** (bot "Minh Khang", 11 nhóm) và **Docker trên VPS** (bot "William", 25 nhóm) — plugin load sạch, 4 tool đăng ký, skill được host symlink, cổng owner đúng (owner → 4 tool; member/không sender → 0 tool), và một lần toggle ghi đúng cả 2 groupId cùng nhóm (`applied=2`).

## [2.18.1] - 2026-07-27

### Changed
- **Phát hành lại lên ClawHub sau khi gỡ gói `openclaw-zalo-mod` khỏi npm.** Nguyên nhân ClawHub kẹt ingest (2.17.9 và 2.18.0 báo "Version not found", `latest` đứng ở 2.17.8) đã được xác định là **xung đột với bản npm cũ 2.14.4** (`package-manifest-version-drift`): pipeline artifact của gói này đối chiếu integrity/shasum với npm nên bản npm lệch số chặn việc promote. Sau khi unpublish toàn bộ gói trên npm, ClawHub tự promote `latest` lên 2.17.9; bản 2.18.1 này bump để đẩy nốt phần metadata (icon/author/license/homepage/compat) lên `latest`.

### Notes
- **Không đổi hành vi runtime** — `index.js` giữ nguyên byte-for-byte so với 2.17.9/2.18.0. Bản vá owner-claim (2.17.9) và toàn bộ tính năng name-triggers/Silent (2.17.8) đều đã có sẵn. Đây là bump "plumbing" để ClawHub `latest` khớp mã nguồn mới nhất.
- Gói cũ trên **npm đã được gỡ** (plugin phát hành qua ClawHub, `publishToNpm: false`) nên cảnh báo `package-manifest-version-drift` không còn nguồn phát sinh.

## [2.18.0] - 2026-07-27

### Changed
- **Khai báo metadata plugin đầy đủ theo chuẩn ClawHub.** `openclaw.plugin.json` nay khai luôn `icon`, `author`, `license`, `homepage` và `compat` (`pluginApi` / `minGatewayVersion`) — trước đây compat chỉ nằm trong `package.json` và các field còn lại bị thiếu, nên trang plugin trên ClawHub hiển thị thiếu thông tin. Plugin Inspector: PASS, 0 breakage.

### Notes
- Bản **2.17.9 không phát hành được lên ClawHub**: registry ghi nhận số version (nên chặn publish lại) nhưng không phục vụ được artifact và không cập nhật `latest` — đã báo ClawHub. **Bản vá owner-claim của 2.17.9 nằm trong 2.18.0 này**, nên hãy cập nhật thẳng lên 2.18.0.
- Cảnh báo `package-manifest-version-drift` còn lại là do gói `openclaw-zalo-mod` trên **npm** vẫn ở 2.14.4 (plugin phát hành qua ClawHub, `publishToNpm: false`). Chỉ hết khi publish npm cùng số.

## [2.17.9] - 2026-07-27

### Fixed
- **Máy cài mới: bot không nhận `im owner` (không có tin xác nhận chủ) và bỏ qua slash command.** Trên một cài đặt còn trắng — chưa có tên bot trong config — hàm dựng cấu hình bot chạm vào một biến chưa khai báo, ném `ReferenceError` và làm **sập toàn bộ hook `before_dispatch`** (log chỉ hiện đúng một dòng `before_dispatch handler from zalo-mod failed: _detectedBotNames is not defined`). Vì lệnh claim chủ được phân tích bên trong hook đó, bot nhận tin nhưng không bao giờ trả lời `im owner <Device ID>`, nên không thể nhận chủ. Nay tên bot lùi về `Bot` khi chưa dò được (tên dò từ IDENTITY.md hoặc Zalo API vẫn được lưu và đọc như trước), kèm test chặn tái phát. Lỗi có từ 2.15.0 và chỉ xuất hiện ở máy cài mới.

## [2.17.8] - 2026-07-26

### Added
- **Chế độ Im lặng — sửa "tên gọi" bot ngay trên dashboard**: bật badge Silent ở một nhóm mở modal diễn giải chế độ + hiển thị tên Zalo bot tự nhận, kèm ô nhập các "tên gọi" phụ (alias). Bot đang Im lặng sẽ trả lời khi được @nhắc HOẶC khi tin nhắn gọi đúng một trong các tên đó (khớp không dấu, không phân biệt hoa/thường). Tên gọi lưu **theo tài khoản (bot)** và áp cho bot ở mọi nhóm; đẩy vào runtime OpenClaw Zalo Connect (RAM-only, không ghi `openclaw.json`, không restart) và tự replay sau khi khởi động lại. Cần OpenClaw Zalo Connect hỗ trợ bridge v4; bản cũ hơn thì vẫn lưu và tự áp khi kết nối lại.

### Fixed
- **Bật/tắt Silent (và các toggle tính năng) không còn lan sang bot khác cùng nhóm**: khi chọn một bot cụ thể trong dropdown rồi gạt toggle, cập nhật hiển thị tức thời chỉ áp cho đúng bot đó. Trước đây, do bản ghi cài đặt của "bot đại diện" dùng chung tham chiếu với settings của nhóm, gạt toggle cho bot A làm badge của bot B (cùng nhóm) đổi theo khi chuyển dropdown.

## [2.17.6] - 2026-07-21

### Fixed
- **Đổi giờ lịch báo cáo trong ngày giờ chạy đúng**: guard chống lặp nay khoá theo **(ngày + giờ đã hẹn)** thay vì chỉ theo ngày. Trước đây nếu nhóm đã báo cáo lúc 18:50 rồi owner đổi sang 20:08 cùng ngày thì lịch mới bị guard chặn, không bắn. State format cũ (chỉ có ngày) được coi như chưa chạy cho khung giờ hiện tại nên tự chữa ngay trong ngày chuyển đổi.

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
