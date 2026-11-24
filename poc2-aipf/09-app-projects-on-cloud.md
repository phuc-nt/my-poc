# AIPF: hai dự án thật chạy trọn trên cloud (kiến trúc và vận hành)

Trạng thái ngày 2026-11-24: **hai deployment AIPF đã lên Cloudflare; run đầu tiên (OF-1, `open-font`) đã xong**
(mục 3). Từ cuối ngày, mỗi môi trường có nhánh git và issue Jira riêng, và run chỉ kết thúc khi chủ dự án chấp
nhận bản staging (UAT). Chưa có lần deploy production nào qua luồng mới.

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
| GitHub | Code. Agent chỉ push nhánh `agent/…`; AIPF merge vào `staging` sau khi người duyệt, và đưa `staging` lên `main` chỉ khi deploy production |
| GitHub Actions (`deploy.yml` của repo) | Deploy production. Chỉ nó giữ token Cloudflare (GitHub secret của repo) |
| Container của AIPF | Một image cho mọi vai: phiên agent, builder (CI), staging |
| `.aipf/environment.yaml` trong repo | Cách cài, kiểm, dựng và chạy repo. AIPF chỉ đọc file này |

Luồng một việc: issue Jira → PM → Designer → Developer → CI → **người duyệt** (PR và các file agent để lại) →
merge vào `staging` → deploy staging → Tester → Operator → **chủ dự án UAT trên staging** (approve, fix hoặc
revert) → xong → **admin bấm "Deploy to production"** trên trang của run: AIPF đưa `staging` lên `main` rồi chạy
workflow production.

Bước của issue Jira theo run: "In Progress" lúc chạy, "Under Review" lúc chờ duyệt, "Approved" sau merge, "Done"
lúc xong. AIPF đọc tên bước từ `JIRA_STATUSES` trong `secrets.env`.

Issue theo môi trường (`ENV_ITEMS=on`): mỗi issue gốc có ba issue con `[Dev] KEY: tóm tắt`, `[Staging] KEY: …`,
`[Production] KEY: …`, gắn nhãn `aipf-env`, `aipf-env-dev` (hay `-staging`, `-production`) và `aipf-item-KEY`.
Lọc một việc: `labels = aipf-item-OF-1`; lọc một môi trường: `labels = aipf-env-staging`.

### Nhánh theo môi trường

| Nhánh | Môi trường | Ai ghi |
|---|---|---|
| `agent/KEY` | Dev | Agent Developer |
| `staging` (`STAGING_BRANCH=staging`) | Staging | AIPF merge PR đã duyệt vào đây; AIPF tạo nhánh từ `main` nếu chưa có |
| `main` | Production | Chỉ AIPF, lúc deploy production: fast-forward `main` lên commit đã UAT. Nếu `main` có commit không nằm trên `staging`, AIPF từ chối và báo |

### UAT

Sau Tester và Operator, run chờ chủ dự án tối đa 3 ngày. Trang của run có: link staging (có chữ ký, hạn 12 giờ,
qua Worker `<app>-uat`), hướng dẫn test do agent viết (kiểm cái gì, làm sao), và các file agent để lại trên
staging. Ba lựa chọn: **approve** (run xong), **fix** (lời nhận xét thành một lượt làm lại, rồi qua lại CI,
staging và UAT), **revert** (gỡ thay đổi khỏi `staging`). Hết hạn mà không chọn: run sang "needs a person".
Tắt UAT cho một deployment: `AIPF_UAT=off`.

### Ba môi trường

| | Dev | Staging | Production |
|---|---|---|---|
| Chạy ở | Container phiên agent, mỗi việc một cái | Một container cho mỗi repo | Worker thật trên Cloudflare |
| Code | Nhánh `agent/…`, đang viết, chưa duyệt | Nhánh `staging`: các PR đã duyệt, một release ở một commit | `main`: commit đã UAT trên staging |
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
  `PRODUCTION_WORKFLOW=deploy.yml`). Nó fast-forward `main` lên commit mà run được chấp nhận trên staging, rồi
  gửi commit đó cho workflow. AIPF **không giữ token Cloudflare**; reconciler theo dõi lần chạy của workflow và
  ghi kết quả vào run và issue `[Production]`.
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

### Run đầu tiên: OF-1 trên `aipf-of` (2026-11-24, 07:51 đến 08:38 UTC)

Việc: họ nháp "Cổ Văn" mô phỏng chữ tựa "Cổ Văn Học Sử". Kết quả: **xong** sau khoảng 47 phút, ở lượt (attempt)
thứ 3. PR 1 đã merge vào `main` (trước khi có nhánh `staging`); chưa deploy production.

| Phiên | Model | Thời gian agent | Kết quả | Chi phí ước tính |
|---|---|---|---|---|
| pm #1 | Sonnet 5.5 | 20 s | xong | $0,16 |
| pm #2 | Sonnet 5.5 | 3 s | lỗi 403, 0 tool call | $0 |
| designer #1 | Opus 5.5 | 90 s | `ready` | $0,52 |
| developer #1 | Sonnet 5.5 | 630 s, 81 turn | hết max turns, không có PR | $2,20 |
| developer #2 | Sonnet 5.5 | 2 s | lỗi 403 | $0 |
| developer #3 | Sonnet 5.5 | 334 s, 56 turn | mở PR | $1,32 |
| reviewer #3 | Sonnet 5.5 | 2 s | lỗi 403, bước review bị bỏ qua | $0 |
| tester #3 | Sonnet 5.5 | 33 s | `pass`, chỉ kiểm tiêu chí AC5 | $0,21 |
| operator #3 | Sonnet 5.5 | 5 s | lỗi 403 | $0 |

- Model: khoảng $4,42 theo giá niêm yết, không tính tiền thật (gói Claude trả cố định). Developer chiếm $3,53.
- Cloudflare của `aipf-of` từ 2026-11-01 đến 2026-11-24: $0,142 theo giá niêm yết, nằm trong hạn mức của gói
  Workers Paid ($5 mỗi tháng cho cả tài khoản). Container chiếm $0,12 (15,1 vCPU-phút).
- **Lỗi 403 "Request not allowed"** ở 4 trên 9 phiên, ngay lúc gọi model, không do agent. Nguyên nhân có khả năng
  nhất: container được đặt ở một vùng mà API của Anthropic không nhận. Đã sửa: phiên agent chỉ chạy ở Bắc Mỹ
  (`constraints.regions` `WNAM`, `ENAM`), có từ lần deploy cuối ngày 2026-11-24. **Chưa kiểm bằng một run.**
- Điểm yếu thấy được: developer #1 hết max turns; reviewer bị bỏ qua vì lỗi 403, nên code vào `main` không qua
  review của agent (vẫn qua người duyệt); tester chỉ kiểm một tiêu chí.

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
| Xem các file agent để lại | Trang của run, cạnh PR (ví dụ ảnh preview font của `open-font`) |
| UAT | Trang của run > link staging và hướng dẫn test; chọn approve, fix hoặc revert. Link hết hạn sau 12 giờ thì lấy link mới trên trang |
| Lên production | Trang của run đã xong > "Deploy to production" (admin). Hoặc chạy workflow bằng tay trên GitHub |
| Dừng khẩn | `aipf.sh pause`, chạy lại bằng `resume`; làm lại một việc bằng `reset` |
| Đổi image | `aipf.sh deploy` (cần Docker ở máy) |
| Chi phí | `aipf.sh cost` mỗi tuần, cho từng deployment. OF-1: $0,14 tiền Cloudflare theo giá niêm yết. Số đo cũ của POC: 11 run trong 3 ngày khoảng $0,22; tài khoản trả $5 mỗi tháng cho Workers Paid |
| Gỡ một deployment | `aipf.sh down` |

**Khi hỏng:**

- Deploy staging hỏng: staging tự chạy lại release trước; xem `aipf.sh logs`.
- Run đứng ở "needs a person": issue có nhãn `aipf-needs-person`; đọc phiên cuối trên console rồi `answer` hoặc `reset`.
- Agent báo lỗi đăng nhập: token gói Claude hết hạn, chạy lại `aipf.sh token`.
- Nút "Deploy to production" báo GitHub từ chối: token GitHub của deployment thiếu quyền "Actions: read and write".
- Nút "Deploy to production" báo `main` không fast-forward được: `main` có commit không nằm trên `staging` (ai đó
  push thẳng vào `main`). Merge `main` vào `staging` qua một PR rồi bấm lại.
- Workflow production hỏng: run và issue `[Production]` ghi là hỏng; xem log ở GitHub Actions.
- Phiên agent lỗi 403 "Request not allowed", 0 tool call: xem mục 3 (vùng của container).

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
   statuses, webhooks, Actions: read and write; contents phải có write để tạo nhánh `staging` và đưa nó lên `main`), ghi vào `GITHUB_TOKEN` của `secrets.env`, rồi `aipf.sh deploy`.
5. **Token Cloudflare của production:** đặt ngày hết hạn và bỏ các quyền không cần (chỉ cần Workers Scripts,
   Workers Routes và D1).
6. **Thu hồi Anthropic API key cũ** trong Anthropic Console.
