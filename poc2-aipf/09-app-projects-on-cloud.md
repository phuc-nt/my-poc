# AIPF: hai dự án thật chạy trọn trên cloud (kiến trúc và vận hành)

Trạng thái ngày 2026-11-24: **hai deployment AIPF đã lên Cloudflare; chưa có run nào chạy**, vì còn chờ chủ dự án
nhập token gói Claude và tạo console user (mục 6). Chưa có lần deploy production nào qua luồng mới.

## 1. Mục tiêu

Hai repo `on-thi-lai-xe` và `open-font` làm được mọi việc trên cloud, không cần máy cá nhân: giao việc, code,
kiểm, staging, production. Mỗi việc là một issue Jira.

## 2. Kiến trúc

Mỗi repo có **một deployment AIPF riêng** trên tài khoản Cloudflare của chủ dự án (một Worker, một console, một
staging), vì một deployment chỉ gắn với một repo. Agent là Claude Code trên gói Claude.

| Repo | Deployment (`APP`) | Thư mục thiết lập (`AIPF_ENV`) | Project Jira |
|---|---|---|---|
| `on-thi-lai-xe` | `aipf-otlx` | `environments/on-thi-lai-xe` | `on-thi-lai-xe`, mã `OTLX` |
| `open-font` | `aipf-of` | `environments/open-font` | `open-font`, mã `OF` |

| Thành phần | Vai trò |
|---|---|
| Console của AIPF (web) | Giao việc: bắt đầu một run từ mã issue Jira, hoặc viết một việc mới ngay trên form (AIPF tạo issue). Duyệt, trả lời agent, xem phiên và chi phí, bấm deploy production |
| Cloud session của Claude Code | Giao việc kiểu trò chuyện, ở claude.ai/code, nằm ngoài AIPF (mục 5) |
| Jira | Sổ việc. Project mang đúng tên repo |
| GitHub | Code. Agent chỉ push nhánh `agent/…`; merge vào `main` do AIPF làm sau khi người duyệt |
| GitHub Actions (`deploy.yml` của repo) | Deploy production. Chỉ nó giữ token Cloudflare (GitHub secret của repo) |
| Container của AIPF | Một image cho mọi vai: phiên agent, builder (CI), staging |
| `.aipf/environment.yaml` trong repo | Cách cài, kiểm, dựng và chạy repo. AIPF chỉ đọc file này |

Luồng một việc: issue Jira → PM → Designer → Developer → CI → **người duyệt** → merge → staging → Tester →
Operator → xong → **admin bấm "Deploy to production"** trên trang của run.

Bước của issue Jira theo run: "In Progress" lúc chạy, "Under Review" lúc chờ duyệt, "Approved" sau merge, "Done"
lúc xong. AIPF đọc tên bước từ `JIRA_STATUSES` trong `secrets.env`.

### Ba môi trường

| | Dev | Staging | Production |
|---|---|---|---|
| Chạy ở | Container phiên agent, mỗi việc một cái | Một container cho mỗi repo | Worker thật trên Cloudflare |
| Code | Nhánh `agent/…`, đang viết, chưa duyệt | `main` đã duyệt, một release ở một commit | Commit đã được chấp nhận trên staging |
| Ai dùng | Agent Developer | Agent Tester và chủ dự án | Người dùng thật |
| Dữ liệu | D1 local, mất khi hết phiên | D1 local, trống lại sau mỗi release | D1 thật |
| Mạng | Có internet | Không có internet | Tên miền thật |

Dev trả lời "việc này xong chưa". Staging trả lời "gộp các việc đã merge lại, app còn chạy đúng không": nó bắt
lỗi khi gộp và lỗi khi phát hành (build từ bản sạch, migration từ đầu, app tự lên và trả `GET /health`).

Staging là `wrangler dev` trong container, **một bản giả lập Worker**. Nó không kiểm được D1 thật, tên miền,
cron, rate limit và secret (`ADMIN_PASSWORD`). Lỗi thuộc nhóm đó chỉ lộ ra ở production.

### Production

- Workflow `.github/workflows/deploy.yml` của từng repo: lấy một commit của `main`, chạy migration D1, rồi
  `wrangler deploy`. Chạy bằng tay (Actions > "Deploy to production" > Run workflow) hoặc do AIPF kích hoạt.
- AIPF kích hoạt khi một admin bấm "Deploy to production" trên trang của một run đã xong (thiết lập
  `PRODUCTION_WORKFLOW=deploy.yml`). Nó gửi commit mà run được chấp nhận trên staging. AIPF **không giữ token
  Cloudflare** và không theo dõi workflow: kết quả xem ở GitHub Actions.
- GitHub secret của repo: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, và `D1_DATABASE_ID` ở `on-thi-lai-xe`.
  Chủ dự án đã đặt ngày 2026-11-24.

## 3. Đã làm và đã đo

| Quyết định | Kết quả |
|---|---|
| 1. Production | Workflow `deploy.yml` ở hai repo, secret đã đặt, nút trên console đã có. Chưa chạy lần nào |
| 2. Remote Control | Cloud session của Anthropic (mục 5); chủ dự án cần cài Claude GitHub App |
| 3. Hai deployment | Đã lên: `aipf-otlx`, `aipf-of` |
| 4. Commit và push | Đã làm ở hai repo ứng dụng và repo sản phẩm |
| 5. `AGENTS.md` của `on-thi-lai-xe` | Đã vào git |
| 6. Công cụ chụp ảnh của `open-font` | Chạy được trên AIPF: repo khai gói Debian của Chromium trong `system.packages`, image cài lúc dựng; Playwright và Chromium do `.aipf/setup.sh` cài |
| 7. Bước Jira | AIPF đọc tên bước từ thiết lập |
| 8. Bộ `cloud/` (Docker sandbox) | Đã bỏ khỏi hai repo |

Đo ở máy ngày 2026-11-24 (image amd64, giả lập trên arm64; staging supervisor thật của AIPF, không có mạng):

| | `on-thi-lai-xe` | `open-font` |
|---|---|---|
| Bước cài đặt lúc dựng image | 25 giây | 127 giây (có Chromium) |
| Deploy lên staging | 27 giây | khoảng 79 giây |
| App trên staging | `/api/health` 200, đăng ký và đăng nhập ghi được D1 | trang chính, file font và `/tai/<họ>.zip` trả 200 |
| Cỡ image | 2,06 GB | khoảng 3,55 GB |

Công cụ của `open-font` trong container: `xem` 4,8 giây, `specimen --png` 4,6 giây, `mxh` 6,4 giây,
`gallery --kiem` 34 giây, `site` 66 giây.

Cỡ image so với đĩa của container trên Cloudflare: class nhỏ nhất AIPF dùng là `standard-1` (đĩa 8 GB), nên cả
hai image đều vừa.

Giới hạn còn lại:

- Ảnh `ref/` của `open-font` chỉ ở máy: `compare`, `fit`, `measure` không chạy trên cloud.
- `GET /health` của `on-thi-lai-xe` do trang SPA trả, nên chỉ cho biết máy chủ đã lên.
- `aipf.sh up` và `deploy` dựng image bằng Docker ở máy: lần dựng và mỗi lần đổi image vẫn cần một máy.
  Đổi `system.packages` hay bước cài đặt của repo thì phải `aipf.sh deploy` lại.
- Token GitHub của hai deployment là token của `gh` trên máy (quyền rộng, mọi repo). Nên thay bằng một
  fine-grained token cho từng repo (mục 6).
- Tin nhắn Slack của hai deployment vào cùng kênh với POC.

## 4. Vận hành

Các lệnh dưới đây là của `providers/cloudflare/aipf.sh` trong repo sản phẩm. Chọn deployment bằng
`AIPF_ENV=on-thi-lai-xe` hoặc `AIPF_ENV=open-font`.

| Việc | Cách làm |
|---|---|
| Giao việc | Console > "Start a run": nhập mã issue có sẵn, hoặc chọn "A new work item" rồi viết tóm tắt và mô tả. Hoặc gắn nhãn `aipf` cho issue trong Jira |
| Theo dõi | Console, hoặc `aipf.sh status`, `sessions`, `logs` |
| Agent hỏi | Trả lời trên console, hoặc `aipf.sh answer` |
| Duyệt code | Console, sau khi CI qua. Duyệt rồi AIPF mới merge |
| Xem staging | Địa chỉ staging của deployment, sau khi merge |
| Lên production | Trang của run đã xong > "Deploy to production" (admin). Hoặc chạy workflow bằng tay trên GitHub |
| Dừng khẩn | `aipf.sh pause`, chạy lại bằng `resume`; làm lại một việc bằng `reset` |
| Đổi image | `aipf.sh deploy` (cần Docker ở máy) |
| Chi phí | `aipf.sh cost` mỗi tuần, cho từng deployment. Số đo cũ của POC: 11 run trong 3 ngày khoảng $0,22 tiền Cloudflare theo giá niêm yết; tài khoản trả $5 mỗi tháng cho Workers Paid |
| Gỡ một deployment | `aipf.sh down` |

**Khi hỏng:**

- Deploy staging hỏng: staging tự chạy lại release trước; xem `aipf.sh logs`.
- Run đứng ở "needs a person": issue có nhãn `aipf-needs-person`; đọc phiên cuối trên console rồi `answer` hoặc `reset`.
- Agent báo lỗi đăng nhập: token gói Claude hết hạn, chạy lại `aipf.sh token`.
- Nút "Deploy to production" báo GitHub từ chối: token GitHub của deployment thiếu quyền "Actions: read and write".
- Workflow production hỏng: xem log ở GitHub Actions; AIPF không biết kết quả.

## 5. Cloud session của Claude Code (giao việc kiểu trò chuyện)

Đây là "Claude Code on the web" ở claude.ai/code: phiên chạy trên máy ảo của Anthropic và vẫn chạy khi đóng máy.
Nó khác tính năng Remote Control (`claude remote-control`), vốn chạy Claude trên máy của mình và chỉ dùng trình
duyệt hay điện thoại làm cửa sổ.

Cài một lần:

1. Vào claude.ai/code, đăng nhập và cho phép GitHub.
2. Cài Claude GitHub App cho tài khoản GitHub, chọn hai repo `on-thi-lai-xe` và `open-font`.
3. Dùng environment "Default" (mạng Limited) hoặc tạo environment riêng. Bước cài đặt của repo đặt trong setup
   script của environment (ví dụ `bash .aipf/setup.sh` cho `open-font`, `npm ci` cho `on-thi-lai-xe`).

Điều cần biết:

- Image có sẵn Node.js 22, Python với `uv`, Docker, Chrome for Testing, PostgreSQL 16.
- Phiên push một nhánh rồi mở pull request. Proxy của GitHub không giới hạn nhánh nào được push, nên nên bật
  branch protection cho `main` trên GitHub.
- Không đặt secret trong biến môi trường của environment: ai dùng environment cũng đọc được.
- Phiên không có token Cloudflare. Production vẫn đi qua workflow `deploy.yml`, do người chạy.
- Phiên dùng chung hạn mức của gói Claude với AIPF.
- Việc làm ở đây **không tự vào Jira**. Muốn theo quy định "mỗi việc một issue": bật connector Atlassian của
  claude.ai cho phiên (chưa kiểm là dùng được trong cloud session), hoặc tạo issue trước rồi ghi mã issue vào lời
  giao việc và tên nhánh.
- Phiên không qua CI, staging và bước duyệt của AIPF. Việc cần các bước đó thì giao qua console.

## 6. Chờ chủ dự án

1. **Token gói Claude và console user cho hai deployment.** Chạy `claude setup-token`, rồi
   `bash environments/poc/finish-app-deployments.sh` trong repo sản phẩm (script hỏi token và email, không lưu
   lại). Mật khẩu tạm và mã TOTP nằm ở `environments/<tên>/console-user.txt`.
2. **Lần deploy production đầu tiên** của mỗi repo: chủ dự án tự bấm. Với `open-font`, workflow deploy `main`
   trên GitHub, không phải thư mục làm việc ở máy.
3. **Cài Claude GitHub App** cho hai repo (mục 5).
4. **Token GitHub riêng cho từng deployment:** fine-grained token cho một repo (contents, pull requests, commit
   statuses, webhooks, Actions: read and write), ghi vào `GITHUB_TOKEN` của `secrets.env`, rồi `aipf.sh deploy`.
5. **Token Cloudflare của production:** đặt ngày hết hạn và bỏ các quyền không cần (chỉ cần Workers Scripts,
   Workers Routes và D1).
6. **Thu hồi Anthropic API key cũ** trong Anthropic Console.
