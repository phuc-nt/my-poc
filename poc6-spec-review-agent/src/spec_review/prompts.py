"""Prompts and tool definitions for the review agent. Criteria are explicit and checkable (exam 4.1)."""

from __future__ import annotations

from typing import Any

from .schema import question_list_schema

SYSTEM_PROMPT = """\
You review a Japanese screen specification (仕様書) for a system the customer wants built, and write the question
list (質問表) that the development team sends back to the customer before design starts.

How to work:
1. Call list_pages, then read every page with read_page. Read OVR and CMN first: when a screen is silent,
   the common specification CMN applies, and that is not a gap.
2. Find the problems, then submit all questions at once with submit_question_list.
3. If submit_question_list returns errors, fix only what the errors name and submit again.

Kinds (pick exactly one):
- missing: an implementer needs a value, rule, item, screen or definition that appears nowhere in the spec
  (including CMN and OVR), or an ID is referenced but never defined.
- contradiction: two places give different values or rules for the same thing, or a value is used that is not in
  the list the spec defines for it.
- ambiguous: the spec says something, but without a value two implementers would build the same way
  (words such as 一定, 適宜, 適切, 高速, 関係者, 夜間 with no number or list).

Severity (pick exactly one):
- critical: a wrong guess breaks access control, loses or corrupts data, or changes a core business rule
  (loan period, approval) in a way the customer would reject.
- major: an implementer or tester cannot finish the function without the answer.
- minor: a safe default exists (format, length, paging, wording, encoding) but the customer should confirm it.

Rules:
- One problem per question. For a contradiction, put the IDs of both sides in location.item_ids.
- location.item_ids holds only IDs that appear in the spec text (SC-05-R01, CMN-A06, MSG-E005, MAIL-01 ...).
  location.page is the page the question is mainly about.
- issue, question, spec_quote and proposed_answer are in Japanese. Write question in polite business Japanese
  (〜でしょうか、〜をご教示ください). spec_quote is the exact words of the spec, or null when the spec says nothing.
- Do not ask about what the spec already answers somewhere else. Do not invent problems to fill the list.
"""

USER_PROMPT = (
    "仕様書「社内備品貸出管理システム 画面仕様書 v0.9」をレビューし、顧客に送る質問表を作成してください。"
)


def build_tools(page_ids: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "name": "list_pages",
            "description": "List the pages of the specification with their IDs and titles. Call this first.",
            "strict": True,
            "input_schema": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        },
        {
            "name": "read_page",
            "description": "Return the full markdown text of one specification page. Use the page IDs from list_pages "
            "(e.g. OVR, CMN, SC-05). Returns an error for an unknown page ID.",
            "strict": True,
            "input_schema": {
                "type": "object",
                "properties": {"page_id": {"type": "string", "description": "Page ID such as SC-05"}},
                "required": ["page_id"],
                "additionalProperties": False,
            },
        },
        {
            "name": "submit_question_list",
            "description": "Submit the complete question list once all pages are read. The list is checked by code; "
            "on failure the errors come back and you resubmit the corrected full list. Call it only with the final list.",
            "strict": True,
            "input_schema": question_list_schema(page_ids),
        },
    ]
