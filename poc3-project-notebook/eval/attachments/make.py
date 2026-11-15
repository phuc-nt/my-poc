#!/usr/bin/env python3
"""Builds the office and Markdown files of the attachment test into eval/attachments/files/.

Every file holds facts that are written nowhere else (not in the Jira issue, not in the Confluence page), so a
right answer proves the knowledge base read the attachment. The questions and their expected answers are in
cases.json; change a fact here and there together.

    python3 -m venv .venv && .venv/bin/pip install python-docx openpyxl python-pptx reportlab xlwt pillow
    .venv/bin/python eval/attachments/make.py

The .doc files are made with macOS textutil. All content is invented.
"""

import csv
import subprocess
import tempfile
from pathlib import Path

import xlwt
from docx import Document
from openpyxl import Workbook
from openpyxl.styles import Font
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.util import Inches, Pt
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

OUT = Path(__file__).parent / "files"
OUT.mkdir(exist_ok=True)
FONTS = Path("/System/Library/Fonts/Supplemental")
pdfmetrics.registerFont(TTFont("Arial", str(FONTS / "Arial.ttf")))
pdfmetrics.registerFont(TTFont("Arial-Bold", str(FONTS / "Arial Bold.ttf")))
BODY = ParagraphStyle("body", fontName="Arial", fontSize=11, leading=16)
HEAD = ParagraphStyle("head", fontName="Arial-Bold", fontSize=15, leading=22, spaceAfter=8)


def xlsx(name, sheets):
    wb = Workbook()
    wb.remove(wb.active)
    for title, rows in sheets.items():
        ws = wb.create_sheet(title)
        for row in rows:
            ws.append(row)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for column in ws.columns:
            ws.column_dimensions[column[0].column_letter].width = max(len(str(c.value or "")) for c in column) + 2
    wb.save(OUT / name)


def xls(name, sheets):
    wb = xlwt.Workbook(encoding="utf-8")
    bold = xlwt.easyxf("font: bold on")
    for title, rows in sheets.items():
        ws = wb.add_sheet(title)
        for r, row in enumerate(rows):
            for c, value in enumerate(row):
                ws.write(r, c, value, bold) if r == 0 else ws.write(r, c, value)
    wb.save(str(OUT / name))


def docx(name, title, blocks):
    """blocks: ('h', text) | ('p', text) | ('table', rows)"""
    doc = Document()
    doc.add_heading(title, 0)
    for kind, value in blocks:
        if kind == "h":
            doc.add_heading(value, 1)
        elif kind == "p":
            doc.add_paragraph(value)
        else:
            table = doc.add_table(rows=len(value), cols=len(value[0]))
            table.style = "Table Grid"
            for r, row in enumerate(value):
                for c, text in enumerate(row):
                    table.cell(r, c).text = str(text)
    doc.save(OUT / name)


def doc(name, title, paragraphs):
    html = f"<html><head><meta charset='utf-8'><title>{title}</title></head><body><h1>{title}</h1>" + "".join(f"<p>{p}</p>" for p in paragraphs) + "</body></html>"
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as f:
        f.write(html)
    subprocess.run(["textutil", "-convert", "doc", f.name, "-output", str(OUT / name)], check=True)
    Path(f.name).unlink()


def pptx(name, slides):
    """slides: {title, bullets?, table?, notes?}"""
    deck = Presentation()
    for i, s in enumerate(slides):
        slide = deck.slides.add_slide(deck.slide_layouts[0 if i == 0 else 5 if s.get("table") else 1])
        slide.shapes.title.text = s["title"]
        if i == 0:
            slide.placeholders[1].text = s.get("subtitle", "")
        elif s.get("table"):
            rows = s["table"]
            shape = slide.shapes.add_table(len(rows), len(rows[0]), Inches(0.6), Inches(1.6), Inches(8.8), Inches(0.4) * len(rows))
            for r, row in enumerate(rows):
                for c, text in enumerate(row):
                    cell = shape.table.cell(r, c)
                    cell.text = str(text)
                    cell.text_frame.paragraphs[0].runs[0].font.size = Pt(14)
        else:
            frame = slide.placeholders[1].text_frame
            frame.text = s["bullets"][0]
            for bullet in s["bullets"][1:]:
                frame.add_paragraph().text = bullet
        if s.get("notes"):
            slide.notes_slide.notes_text_frame.text = s["notes"]
    deck.save(OUT / name)


def pdf(name, title, paragraphs, table=None):
    story = [Paragraph(title, HEAD)] + [x for p in paragraphs for x in (Paragraph(p, BODY), Spacer(1, 6))]
    if table:
        t = Table(table)
        t.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), "Arial"), ("FONTNAME", (0, 0), (-1, 0), "Arial-Bold"),
                               ("GRID", (0, 0), (-1, -1), 0.5, colors.grey), ("FONTSIZE", (0, 0), (-1, -1), 10)]))
        story.append(t)
    SimpleDocTemplate(str(OUT / name), pagesize=A4, title=title).build(story)


def picture(lines, size=(1654, 2339), font_size=44, tilt=0.0):
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    y = 160
    for i, line in enumerate(lines):
        font = ImageFont.truetype(str(FONTS / ("Arial Bold.ttf" if i == 0 else "Arial.ttf")), font_size + (12 if i == 0 else 0))
        draw.text((140, y), line, fill="black", font=font)
        y += int(font_size * 2.1)
    return image.rotate(tilt, fillcolor="white", resample=Image.BICUBIC) if tilt else image


def scan(name, lines):
    """A PDF of one page picture, like a scanner makes: no text layer."""
    picture(lines, tilt=0.6).convert("L").save(OUT / name, "PDF", resolution=150)


def png(name, lines):
    picture(lines, size=(1400, 700), font_size=40).save(OUT / name, "PNG")


def text(name, lines):
    (OUT / name).write_text("\n".join(lines) + "\n", encoding="utf-8")


def markdown(name, body):
    (OUT / name).write_text(body.strip("\n") + "\n", encoding="utf-8")


def csvfile(name, rows):
    with open(OUT / name, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(rows)


# ---------- Jira issue A: release plan of my-translator 3.2

xlsx("Ke-hoach-release-3.2.xlsx", {
    "Lich": [
        ["Mốc", "Ngày", "Phụ trách", "Ghi chú"],
        ["Chốt phạm vi", "2027-02-22", "Đoàn Thị Sương", "Sau buổi kickoff đợt Hải Âu"],
        ["Code freeze", "2027-03-09", "Lê Quang Thạch", "Nhánh release/3.2"],
        ["UAT bắt đầu", "2027-03-15", "Vũ Ngọc Diệp", "Khách hàng cử 6 người thử"],
        ["Go-live", "2027-03-29", "Trịnh Hữu Khoa", "Triển khai lúc 21:00"],
    ],
    "Rui-ro": [
        ["Mã", "Rủi ro", "Mức", "Phương án dự phòng"],
        ["R-03", "Thiếu người kiểm thử tiếng Khmer", "Trung bình", "Thuê 2 cộng tác viên qua đối tác Sok Dara"],
        ["R-07", "Nhà cung cấp OCR Kiyomi hết hạn hợp đồng giữa đợt", "Cao", "Chuyển sang engine dự phòng Tessera-VN"],
    ],
})

pptx("Kickoff-release-3.2.pptx", [
    {"title": "Kickoff release my-translator 3.2", "subtitle": "Đợt Hải Âu"},
    {"title": "Mục tiêu", "bullets": [
        "Giảm thời gian dịch trung bình một trang A4 từ 4,2 giây xuống 2,8 giây",
        "Tỷ lệ phiên dịch bị ngắt dưới 0,4%"],
     "notes": "Ngân sách đợt Hải Âu được ban điều hành duyệt là 1,35 tỷ đồng."},
    {"title": "Phạm vi", "bullets": ["Thêm cặp ngôn ngữ Việt–Khmer", "Chế độ dịch ngoại tuyến cho bản mobile", "Không làm: dịch giọng nói thời gian thực"]},
    {"title": "Môi trường", "table": [
        ["Môi trường", "Địa chỉ nội bộ", "Người quản lý"],
        ["Staging", "staging-haiau.mytranslator.example", "Lê Quang Thạch"],
        ["UAT", "uat-haiau.mytranslator.example", "Vũ Ngọc Diệp"]]},
])

markdown("Ghi-chu-phat-hanh-3.2.md", """
# Ghi chú phát hành my-translator 3.2

Bản dựng phát hành là 3.2.0-rc4, đóng gói ngày 2027-03-24.

## Thay đổi chính

- Bộ nhớ dịch (translation memory) nâng giới hạn lên 250.000 cặp câu cho mỗi dự án.
- Thêm phím tắt Ctrl+Shift+K để mở bảng thuật ngữ.

## Yêu cầu hệ thống

| Thành phần | Phiên bản tối thiểu | Ghi chú |
|---|---|---|
| Android | 11 | Bản mobile ngoại tuyến |
| iOS | 16.4 | Bản mobile ngoại tuyến |
| Máy chủ dịch | Ubuntu 24.04 | RAM tối thiểu 12 GB |

## Lệnh nâng cấp

```bash
mt-admin upgrade --to 3.2.0 --channel haiau-stable --keep-glossary
```

Sau khi nâng cấp, chạy `mt-admin doctor --check tm-index` để kiểm tra chỉ mục bộ nhớ dịch.
""")

# ---------- Jira issue B: a wrong medical term in 3.1.4

docx("Bao-cao-phan-tich-loi.docx", "Báo cáo phân tích lỗi dịch thuật ngữ y khoa, bản 3.1.4", [
    ("h", "Nguyên nhân gốc"),
    ("p", "Bảng thuật ngữ MED-GLOSS bị ghi đè bởi job đồng bộ đêm chạy lúc 02:15, vì job dùng bản xuất cũ của tháng 11."),
    ("p", "Tổng số văn bản bị ảnh hưởng là 1.284 văn bản của 37 khách hàng."),
    ("h", "Thuật ngữ bị dịch sai"),
    ("table", [["Thuật ngữ", "Bản dịch sai", "Bản dịch đúng"],
               ["tachycardia", "nhịp tim chậm", "nhịp tim nhanh"],
               ["hypoglycemia", "tăng đường huyết", "hạ đường huyết"]]),
    ("h", "Khắc phục"),
    ("p", "Khoá ghi bảng MED-GLOSS ngoài khung 13:00-14:00 và thêm bước so sánh checksum trước khi đồng bộ."),
])

text("Log-tai-hien.txt", [
    "2027-01-18 02:14:58 INFO  glossary-sync start source=export-2026-11",
    "2027-01-18 02:15:07 WARN  glossary-sync overwrite table=MED-GLOSS rows=3120 actor=svc-nightly-07",
    "2027-01-18 02:15:09 INFO  glossary-sync done duration_ms=11042",
    "2027-01-18 08:31:44 ERROR translate term=tachycardia expected='nhịp tim nhanh' got='nhịp tim chậm' request=req-58b1c",
])

csvfile("Ket-qua-do-luong.csv", [
    ["ngay", "so_van_ban_loi", "ty_le_loi_phan_tram"],
    ["2027-01-18", 412, 3.7],
    ["2027-01-19", 655, 5.9],
    ["2027-01-20", 217, 1.9],
])

png("Anh-chup-man-hinh-loi.png", [
    "my-translator 3.1.4 — Không thể hoàn tất bản dịch",
    "Mã lỗi: ERR-GLS-4471",
    "Bảng thuật ngữ y khoa không khớp checksum.",
    "Liên hệ quản trị viên và gửi kèm mã lỗi này.",
])

# ---------- Jira issue C: acceptance of the 2027 maintenance contract

pdf("Bien-ban-nghiem-thu.pdf", "Biên bản nghiệm thu dịch vụ bảo trì my-translator", [
    "Số biên bản: BBNT-2027-0142. Ngày lập: 12/01/2027.",
    "Đại diện bên A: ông Phan Đình Lộc, Giám đốc vận hành. Đại diện bên B: bà Tạ Minh Hằng.",
    "Giá trị nghiệm thu đợt này là 486.500.000 đồng, đã gồm thuế giá trị gia tăng.",
    "Hai bên thống nhất dịch vụ quý 4 năm 2026 đạt yêu cầu, với 2 sự cố mức 2 đã xử lý trong hạn.",
])

scan("Phu-luc-hop-dong-scan.pdf", [
    "PHỤ LỤC 03 — CAM KẾT MỨC DỊCH VỤ",
    "Hợp đồng bảo trì my-translator năm 2027",
    "",
    "1. Thời gian phản hồi sự cố mức 1: 45 phút.",
    "2. Thời gian khắc phục sự cố mức 1: 6 giờ.",
    "3. Phạt chậm trễ: 0,15% giá trị hợp đồng mỗi giờ.",
    "4. Báo cáo dịch vụ gửi trước ngày 5 hàng tháng.",
])

xls("Bang-gia-bao-tri.xls", {"Bang-gia": [
    ["Gói", "Giá mỗi tháng (đồng)", "Số giờ hỗ trợ", "Thời gian phản hồi"],
    ["Gói Bạc", 18400000, 20, "4 giờ"],
    ["Gói Vàng", 27900000, 45, "2 giờ"],
    ["Gói Kim Cương", 41300000, 90, "30 phút"],
]})

doc("Cong-van-de-nghi.doc", "Công văn số 87/CV-MT", [
    "Kính gửi: Ban Giám đốc Công ty Mộc Lan.",
    "Công văn số 87/CV-MT đề nghị gia hạn dịch vụ bảo trì my-translator thêm 18 tháng, đến hết ngày 30/09/2028.",
    "Đơn giá giữ nguyên theo Gói Vàng. Người liên hệ: bà Tạ Minh Hằng, số máy lẻ 4417.",
])

# ---------- Confluence page D: design file of my-db-mate 2.0

docx("Thiet-ke-co-so-du-lieu.docx", "my-db-mate 2.0 — Thiết kế cơ sở dữ liệu", [
    ("h", "Lưu giữ dữ liệu"),
    ("p", "Bảng audit_trail được phân vùng theo tháng và giữ 26 tháng, sau đó chuyển sang kho lưu trữ lạnh."),
    ("h", "Các bảng chính"),
    ("table", [["Bảng", "Khoá chính", "Số dòng dự kiến"],
               ["query_history", "qh_id (ULID)", "480 triệu"],
               ["saved_query", "sq_id (UUID v7)", "2 triệu"],
               ["audit_trail", "at_id (bigint)", "1,9 tỷ"]]),
])

xlsx("Ma-tran-phan-quyen.xlsx", {
    "Vai-tro": [
        ["Vai trò", "Xem schema", "Chạy truy vấn", "Xuất dữ liệu", "Giới hạn dòng mỗi truy vấn"],
        ["Viewer", "Có", "Không", "Không", 0],
        ["Analyst-L1", "Có", "Có", "Không", 10000],
        ["Analyst-L2", "Có", "Có", "Không", 75000],
        ["Auditor", "Có", "Không", "Có", 5000],
    ],
    "Ngoai-le": [
        ["Nhóm", "Ngoại lệ", "Hiệu lực"],
        ["Kho vận Biên Hoà", "Được xuất dữ liệu đến 23:00 thứ Sáu hàng tuần", "Đến 30/06/2027"],
    ],
})

pptx("Kien-truc-tong-quan.pptx", [
    {"title": "my-db-mate 2.0 — Kiến trúc tổng quan", "subtitle": "Bản trình bày cho hội đồng kiến trúc"},
    {"title": "Thành phần", "bullets": [
        "Cổng truy vấn Heron-Gateway chạy 3 bản sao ở 2 vùng sẵn sàng",
        "Bộ lập lịch Kestrel-Scheduler xử lý truy vấn dài hơn 90 giây"],
     "notes": "Quyết định ADR-031: bỏ Redis, dùng bộ đệm trong tiến trình vì độ trễ mạng nội bộ."},
    {"title": "Lộ trình", "bullets": ["Tháng 4/2027: bản beta nội bộ", "Tháng 6/2027: mở cho 5 khách hàng đầu tiên"]},
])

pdf("Bao-cao-hieu-nang.pdf", "my-db-mate 2.0 — Báo cáo kiểm thử hiệu năng", [
    "Thử ngày 2027-02-11 trên cụm perf-c7, dữ liệu mẫu 480 triệu dòng.",
    "Ở tải 1.200 truy vấn mỗi giây, p95 thời gian phản hồi là 184 ms và p99 là 410 ms.",
], table=[["Tải (truy vấn/giây)", "p50 (ms)", "p95 (ms)", "p99 (ms)"], ["600", "41", "97", "220"], ["1.200", "66", "184", "410"], ["1.800", "118", "356", "902"]])

markdown("Huong-dan-van-hanh.md", """
# my-db-mate 2.0 — Hướng dẫn vận hành

## Trực sự cố

Kênh trực sự cố là #dbmate-oncall-2. Kỹ sư trực phải phản hồi cảnh báo mức P1 trong 12 phút.

## Ngưỡng cảnh báo

| Chỉ số | Ngưỡng cảnh báo | Mức |
|---|---|---|
| Hàng đợi truy vấn | 450 truy vấn chờ | P2 |
| Dung lượng đĩa WAL | 82% | P1 |
| Kết nối đang mở | 1.900 | P2 |

## Khởi động lại cổng truy vấn

1. Rút nút khỏi cân bằng tải.
2. Chạy lệnh:

```bash
dbmctl gateway restart --drain-timeout 45s --zone syd-b
```

3. Kiểm tra `/healthz/deep` trả về mã 204 rồi mới đưa nút trở lại.
""")

png("So-do-trien-khai.png", [
    "my-db-mate 2.0 — Sơ đồ triển khai",
    "Vùng chính: Sydney  →  Vùng dự phòng: Melbourne",
    "Độ trễ sao chép giữa hai vùng: 340 ms",
    "Chuyển vùng tự động sau 3 lần kiểm tra thất bại",
])

# ---------- Confluence page E: old formats and scans

doc("Quy-trinh-sao-luu.doc", "my-db-mate — Quy trình sao lưu", [
    "Sao lưu đầy đủ chạy lúc 01:40 Chủ nhật hàng tuần và giữ 9 bản gần nhất.",
    "Sao lưu gia tăng chạy mỗi 20 phút; mục tiêu RPO là 20 phút và RTO là 3 giờ.",
    "Bản sao lưu được kiểm tra khôi phục vào thứ Tư đầu tiên của mỗi tháng.",
])

xls("Danh-muc-may-chu.xls", {"May-chu": [
    ["Tên máy", "Vai trò", "RAM", "Vùng"],
    ["dbm-prd-ha-01", "primary ghi", "512 GB", "Sydney"],
    ["dbm-prd-ha-04", "replica đọc", "384 GB", "Melbourne"],
    ["dbm-prd-bk-02", "máy sao lưu", "128 GB", "Sydney"],
]})

scan("Bien-ban-ban-giao-scan.pdf", [
    "BIÊN BẢN BÀN GIAO SỐ BG-55/2027",
    "",
    "Ngày 04/03/2027, đội Hạ tầng bàn giao 12 máy chủ",
    "của hệ thống my-db-mate cho đội Vận hành.",
    "Người nhận: ông Mạc Văn Tùng.",
    "Thời hạn bảo hành phần cứng: đến 31/12/2029.",
])

csvfile("Lich-bao-tri.csv", [
    ["ngay", "he_thong", "cua_so", "nguoi_truc"],
    ["2027-04-17", "my-db-mate", "22:30-01:00", "Mạc Văn Tùng"],
    ["2027-05-22", "my-db-mate", "23:00-00:30", "Lê Quang Thạch"],
])

# ---------- Confluence blog post F: sprint review

pptx("Tong-ket-sprint-42.pptx", [
    {"title": "Tổng kết sprint 42", "subtitle": "Nhóm my-db-mate"},
    {"title": "Kết quả", "bullets": ["Velocity sprint 42 đạt 67 điểm, mục tiêu sprint 43 là 72 điểm", "Hoàn thành 11 trên 13 hạng mục"]},
    {"title": "Hạng mục trễ", "bullets": ["Xuất báo cáo PDF song ngữ Việt–Nhật", "Trình soạn truy vấn hỗ trợ phím tắt kiểu Vim"],
     "notes": "Demo cho khách hàng dời sang ngày 08/04/2027."},
])

markdown("Retro-sprint-42.md", """
# Retro sprint 42 — nhóm my-db-mate

## Điều làm tốt

- Thời gian review trung bình một pull request giảm còn 5,5 giờ.

## Cần cải thiện

- Bộ test tích hợp chạy mất 38 phút; mục tiêu sprint 43 là dưới 25 phút.

## Hành động

- [ ] Phan Minh Triết tách bộ test tích hợp thành 4 nhóm chạy song song, hạn 2027-04-02.
- [x] Chuyển họp daily sang 9:15.
""")

print("\n".join(f"{p.stat().st_size:>8}  {p.name}" for p in sorted(OUT.iterdir())))
