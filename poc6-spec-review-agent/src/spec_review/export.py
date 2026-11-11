"""Write the question list as the Excel 質問表 a bridge engineer sends to the customer."""

from __future__ import annotations

from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

from .schema import QuestionList

KIND_JA = {"missing": "記載漏れ", "contradiction": "矛盾", "ambiguous": "曖昧"}
SEVERITY_JA = {"critical": "重大", "major": "中", "minor": "軽微"}
HEADERS = ["No", "ページ", "項目ID", "種別", "重要度", "指摘内容", "質問", "仕様書の記載", "回答案", "回答"]
WIDTHS = [7, 8, 22, 10, 8, 45, 50, 35, 35, 30]


def write_xlsx(qlist: QuestionList, path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "質問表"
    ws.append(HEADERS)
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="DDEBF7")
    for q in qlist.questions:
        ws.append([
            q.id,
            q.location.page,
            ", ".join(q.location.item_ids),
            KIND_JA[q.kind.value],
            SEVERITY_JA[q.severity.value],
            q.issue,
            q.question,
            q.spec_quote or "（記載なし）",
            q.proposed_answer or "",
            "",
        ])
    for i, width in enumerate(WIDTHS):
        ws.column_dimensions[chr(ord("A") + i)].width = width
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    ws.freeze_panes = "A2"
    wb.save(path)
