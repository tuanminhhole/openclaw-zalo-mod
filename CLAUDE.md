# CLAUDE.md - openclaw-zalo-mod

Bối cảnh gốc: đọc `~/SecondBrain/CONTEXT.md`. Bộ chuẩn dự án: `~/Project/chuan/README.md` (cấu trúc, bí mật, tên biến ở `BI-MAT.md`).

- Repo làm gì: plugin OpenClaw kiểm duyệt nhóm Zalo (chống spam, cảnh báo, CRM, dashboard).
- Triển khai: plugin cài vào OpenClaw của khách, không có thư mục riêng trên vps_mkt (CAU-TRUC.md: chưa kiểm). Nhánh mặc định `master`.
- Trạng thái: hệ sinh thái OpenClaw đang ở chế độ bảo trì (Kent chốt rời OpenClaw sang MonkeyAgent từ 14/08/2026), chỉ vá lỗi cho khách hiện hữu.
- Nhánh: làm trên `lane/dev2`; chỉ Leader gộp vào nhánh mặc định và phát hành. Không deploy khi Kent chưa đồng ý, không `git push --force`.
- Bí mật: biến trong `.env` (gitignore), mẫu ở `.env.example`; tệp khoá trong `secrets/`. Không đưa bí mật vào git, commit, TASKS.
- Văn bản: chỉ dùng dấu `-`, không dùng dấu gạch dài. Tiếng Việt cho tài liệu, tiếng Anh cho code và commit.
