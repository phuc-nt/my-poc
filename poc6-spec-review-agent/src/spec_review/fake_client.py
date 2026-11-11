"""A scripted stand-in for anthropic.Anthropic, for offline dry runs and tests. No network, no cost.

The script exercises the paths the real run must handle: parallel tool calls, an unknown page (is_error),
an invalid submission sent back with its errors, a valid one, then end_turn.
"""

from __future__ import annotations

from types import SimpleNamespace as NS
from typing import Any


def _tool(i: int, name: str, inp: dict[str, Any]) -> NS:
    return NS(type="tool_use", id=f"toolu_fake_{i:02d}", name=name, input=inp)


def _q(n: int, page: str, ids: list[str], kind: str, sev: str, issue: str, question: str, quote: str | None) -> dict[str, Any]:
    return {"id": f"Q{n:03d}", "location": {"page": page, "item_ids": ids, "section": None}, "kind": kind,
            "severity": sev, "issue": issue, "question": question, "spec_quote": quote, "proposed_answer": None}


VALID = [
    _q(1, "SC-01", ["CMN-R01", "SC-01-R04"], "contradiction", "major",
       "セッションの有効時間が共通仕様（30分）とログイン画面（60分）で異なる。",
       "無操作時のセッション破棄までの時間は30分と60分のどちらが正しいでしょうか。", "60分間操作がない場合"),
    _q(2, "SC-05", ["SC-05-R01", "SC-08-R02"], "contradiction", "critical",
       "貸出期間の上限が貸出申請（14日）と窓口（1か月）で異なる。",
       "貸出期間の上限は14日と1か月のどちらでしょうか。窓口での延長に承認は必要でしょうか。", "貸出期間は最大14日とする"),
    _q(3, "SC-09", ["MAIL-02", "SC-09-R02"], "missing", "major",
       "督促メール MAIL-02 が共通仕様のメール一覧に定義されていない。",
       "督促メール（MAIL-02）の宛先、件名、本文の項目をご教示ください。", None),
    _q(4, "SC-09", ["SC-09-R03"], "ambiguous", "minor",
       "超過日数の数え方が不明確。",
       "超過日数に土日・祝日を含めるかご確認ください。", "土日・祝日も日数に含める"),
]
INVALID = [dict(VALID[0], location={"page": "SC-01", "item_ids": ["SC-01-R09"], "section": None}),
           dict(VALID[1], question="Which is right, 14 days or one month?")]


class _Stream:
    def __init__(self, message: NS):
        self._message = message

    def __enter__(self) -> "_Stream":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def get_final_message(self) -> NS:
        return self._message


class _Messages:
    def __init__(self, script: list[NS]):
        self.script = list(script)
        self.requests: list[dict[str, Any]] = []

    def stream(self, **request: Any) -> _Stream:
        self.requests.append(dict(request, messages=list(request["messages"])))  # snapshot: the loop keeps appending
        return _Stream(self.script.pop(0))


class FakeClient:
    def __init__(self, page_ids: list[str], script: list[NS] | None = None):
        self.messages = _Messages(script or default_script(page_ids))
        self.beta = NS(messages=self.messages)


def _msg(stop: str, content: list[NS], inp: int = 3000, out: int = 400, cread: int = 0) -> NS:
    usage = NS(input_tokens=inp, output_tokens=out, cache_creation_input_tokens=0, cache_read_input_tokens=cread)
    return NS(stop_reason=stop, content=content, usage=usage, stop_details=None)


def default_script(page_ids: list[str]) -> list[NS]:
    reads = [_tool(10 + i, "read_page", {"page_id": p}) for i, p in enumerate(page_ids)]
    reads.append(_tool(9, "read_page", {"page_id": "SC-13"}))
    return [
        _msg("tool_use", [_tool(1, "list_pages", {})]),
        _msg("tool_use", reads),
        _msg("tool_use", [_tool(2, "submit_question_list", {"questions": INVALID})], cread=20000, out=3000),
        _msg("tool_use", [_tool(3, "submit_question_list", {"questions": VALID})], cread=24000, out=3000),
        _msg("end_turn", [NS(type="text", text="質問表を提出しました。")], cread=26000, out=20),
    ]
