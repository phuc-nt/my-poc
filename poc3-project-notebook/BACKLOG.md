# Backlog

Việc chưa làm của Project Notebook (PoC 3), ghi lại ngày 2026-11-14 sau khi so sánh với Atlassian Rovo. Ba việc đầu của đợt đó đã xong: phân quyền theo từng page và issue, đếm và tính chính xác (`query_jira`, `query_table`), và Research mode.

Thứ tự dưới đây chưa phải thứ tự ưu tiên.

## 1. Agent dựng sẵn cho từng việc

Một agent là một bộ gồm chỉ dẫn, các nguồn được chọn và mẫu đầu ra, lưu lại và chia sẻ qua thư viện của team.

- Ví dụ đầu tiên: onboarding cho người mới, review spec, viết release notes.
- Người tạo chọn nguồn trong phạm vi mình được đọc; người dùng agent chỉ thấy tài liệu mà chính họ được đọc.
- Chạy trên vòng lặp tool sẵn có ([src/lib/agent.mjs](src/lib/agent.mjs)).

## 2. Điểm vào ngay trong Jira và Confluence

Hỏi ngay tại page hoặc issue đang mở, không phải chuyển sang web UI.

- Hai hướng: browser extension, hoặc panel nhúng trong Jira và Confluence.
- Câu hỏi mặc định giới hạn vào page hoặc issue đang mở (web UI đã có chế độ hỏi trên một tài liệu).

## 3. Bộ nhớ theo người dùng

Ghi nhớ vai trò, dự án đang theo và cách trình bày mà từng người muốn, để các câu trả lời sau dùng lại.

- Người dùng xem, sửa và xoá được những gì đã ghi nhớ.

## 4. Glossary dựng từ knowledge base

Bảng thuật ngữ Việt–Anh–Nhật rút từ tài liệu của dự án, có dẫn nguồn.

- Dùng lại khi trả lời và khi dịch, để thuật ngữ nhất quán.
- Studio đã có đầu ra glossary theo từng notebook; việc này là một bảng chung, cập nhật theo các lần sync.

## 5. Đồ thị quan hệ issue, page và người

Lưu quan hệ giữa issue, page và người (issue nhắc tới page nào, ai viết, ai được giao), theo hướng Teamwork Graph của Rovo.

- Trả lời được các câu như "ai biết về tính năng X" hay "page nào liên quan tới issue này".

## 6. Ghi ngược vào Jira và Confluence

Tạo hoặc sửa issue, comment, page từ câu trả lời.

- Việc này đi ngược nguyên tắc chỉ đọc hiện nay của ứng dụng; làm hay không là quyết định của chủ dự án.
- Nếu làm: tài khoản kết nối cần quyền ghi, và mỗi thao tác ghi cần người dùng xác nhận.

## 7. Thêm connector

Các nguồn ngoài Confluence và Jira. Code đọc SharePoint Online của một bản dựng trước vẫn còn trong `src/lib/` nhưng không được dùng và chưa thử lại với bản hiện tại.

## Việc còn mở của ba tính năng đã làm

- Phân quyền theo page và issue: phần đọc restriction thật từ Confluence và security level thật từ Jira chưa được thử, vì site thử nghiệm của PoC không có hai tính năng này. Phần chặn đã thử bằng [scripts/restrict-test.mjs](scripts/restrict-test.mjs) với index ghi tay. Cần chạy lại script trên một site có page restriction.
- Các giới hạn đã biết nằm ở [docs/02-engineering-guide.md](docs/02-engineering-guide.md), mục 9.
