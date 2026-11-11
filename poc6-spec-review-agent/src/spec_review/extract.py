"""Part 4: structured output compared on a test set, one screen per request, validated by code with a retry.

The test set is the twelve screens. Each case is one request: OVR and CMN in a cached system prompt, the screen in
the user message, the answer forced into the 質問表 schema in one of three ways:

- forced `tool_choice` on Haiku 5.5 (the form the exam teaches; Sonnet 5.5 returns a 400 for it),
  with the strict grammar (`haiku-forced`) and without it (`haiku-forced-loose`);
- `tool_choice: auto` with a strict tool on Sonnet 5.5 (`sonnet-strict`): the call itself is not guaranteed;
- `output_config.format` with the same JSON Schema (`haiku-format`, `sonnet-format`).

Every answer goes through Pydantic, the ID check and the quote check. An invalid answer gets the errors back
(as an `is_error` tool result, or as a user message for the JSON form) and the model answers again, up to
`max_attempts`. The goal is a test set at 100% valid after the retry, and the measure is how often the first
answer was already valid, and why not.
"""

from __future__ import annotations

import json
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .pricing import cost_usd, usage_dict
from .schema import question_list_schema, validate_question_list
from .score import score
from .sdk_agent import CRITERIA
from .spec import Spec

HAIKU = "claude-haiku-5-5"
SONNET = "claude-sonnet-5-5"
TOOL = "submit_question_list"


@dataclass(frozen=True)
class Mode:
    name: str
    model: str
    via: str  # "tool" or "format"
    tool_choice: dict[str, Any] | None = None
    strict: bool = True


MODES = {m.name: m for m in [
    Mode("haiku-forced", HAIKU, "tool", {"type": "tool", "name": TOOL}),
    Mode("haiku-forced-loose", HAIKU, "tool", {"type": "tool", "name": TOOL}, strict=False),
    Mode("haiku-format", HAIKU, "format"),
    Mode("sonnet-strict", SONNET, "tool", {"type": "auto"}),
    Mode("sonnet-format", SONNET, "format"),
]}

CASE_PROMPT = """\
You review ONE screen page of a Japanese screen specification (仕様書) and write the questions (質問表) that the
development team sends back to the customer before design starts. The overview (OVR) and the common specification
(CMN) are below; the screen is in the user message. When the screen is silent, CMN applies, and that is not a
problem. You cannot see the other screens: report a problem that involves another page only when this screen, OVR or
CMN shows both sides. An empty list is the right answer for a screen with no problem.

{criteria}
{examples}
<page id="OVR">
{ovr}
</page>

<page id="CMN">
{cmn}
</page>
"""

# Few-shot (4.2): two worked examples and one counter-example from another, fictional specification. They show the
# two calls the scorer most often disagrees with: ambiguous against missing, and "CMN answers it" (no question).
FEW_SHOT = """
<examples>
From another specification (a meeting room booking system). Its IDs (EX-...) are not in this spec.

Example 1. Screen row: | EX-03-F04 | 利用人数 | 数値 | 必須 | 上限は会議室ごとに適切に設定する |
Question: {"location": {"page": "EX-03", "item_ids": ["EX-03-F04"], "section": null}, "kind": "ambiguous",
"severity": "major", "issue": "利用人数の上限が「適切に設定する」とだけあり、値も設定方法も定義されていない。",
"question": "会議室ごとの利用人数の上限は、どの値を、どの画面で設定するのでしょうか。ご教示ください。",
"spec_quote": "上限は会議室ごとに適切に設定する", "proposed_answer": null}
Why: the spec says something, without a value: ambiguous, not missing. A tester cannot finish without it: major.

Example 2. EX-05-R01 says 「予約の取消は利用日の前日まで」, the common rule EX-C-R04 says 「予約の取消は開始2時間前まで」.
Question: kind contradiction, item_ids ["EX-05-R01", "EX-C-R04"] (both sides), severity critical (a core business
rule the customer would reject if guessed wrong), spec_quote one of the two passages copied exactly.

Counter-example. The list screen EX-06 gives no page size, and the common rule EX-C-R05 says 「一覧は1ページ20件」.
No question: the screen is silent and the common rule answers it.
</examples>
"""

ASK_TOOL = "この画面をレビューし、質問を submit_question_list ツールでまとめて提出してください。"
ASK_JSON = "この画面をレビューし、質問表を指定のJSON形式で回答してください。"
NUDGE = "質問表がまだ提出されていません。submit_question_list ツールで提出してください（問題がなければ空の配列）。"


@dataclass
class P4Config:
    mode: str = "sonnet-format"
    effort: str = "medium"
    few_shot: bool = False
    batch: bool = False
    max_attempts: int = 3
    max_tokens: int = 16000
    screens: list[str] | None = None
    concurrency: int = 4
    budget_left_usd: float = 30.0
    batch_poll_s: float = 15.0


@dataclass
class Attempt:
    stop_reason: str | None
    problem: str | None  # None when valid
    errors: list[str]
    thinking_blocks: int
    usage: dict[str, int]
    cost_usd: float
    seconds: float
    batch: bool = False


@dataclass
class CaseResult:
    screen: str
    valid: bool
    questions: list[dict[str, Any]] | None
    attempts: list[Attempt] = field(default_factory=list)
    outcome: str = "invalid"

    @property
    def cost_usd(self) -> float:
        return sum(a.cost_usd for a in self.attempts)


class BudgetStop(Exception):
    pass


class Meter:
    """Cost across threads, and the stop when the budget left is reached."""

    def __init__(self, left: float):
        self.left, self.spent, self.lock = left, 0.0, threading.Lock()

    def check(self) -> None:
        with self.lock:
            if self.spent >= self.left:
                raise BudgetStop(f"spent {self.spent:.4f} of {self.left:.4f}")

    def add(self, usd: float) -> None:
        with self.lock:
            self.spent += usd


def system_blocks(spec: Spec, few_shot: bool) -> list[dict[str, Any]]:
    text = CASE_PROMPT.format(criteria=CRITERIA, examples=FEW_SHOT if few_shot else "",
                              ovr=spec.pages["OVR"].text, cmn=spec.pages["CMN"].text)
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


def build_request(mode: Mode, spec: Spec, screen: str, cfg: P4Config,
                  messages: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    schema = question_list_schema(spec.page_ids, min_questions=0)
    if messages is None:
        page = spec.pages[screen]
        ask = ASK_TOOL if mode.via == "tool" else ASK_JSON
        messages = [{"role": "user", "content": [{"type": "text", "text": f'<page id="{screen}">\n{page.text}\n</page>\n\n{ask}'}]}]
    req: dict[str, Any] = {"model": mode.model, "max_tokens": cfg.max_tokens, "system": system_blocks(spec, cfg.few_shot),
                           "messages": messages, "thinking": {"type": "adaptive"}, "output_config": {"effort": cfg.effort}}
    if mode.via == "tool":
        tool: dict[str, Any] = {"name": TOOL, "description": "Submit every question about this screen at once. The list "
                                "is checked by code; on failure the errors come back and you submit the corrected full "
                                "list. An empty list means the screen has no problem.", "input_schema": schema}
        if mode.strict:
            tool["strict"] = True
        req["tools"] = [tool]
        req["tool_choice"] = mode.tool_choice
    else:
        req["output_config"]["format"] = {"type": "json_schema", "schema": schema}
    return req


def problem_kind(errors: list[str]) -> str:
    """One label per invalid answer, for the counts: the first error decides."""
    e = errors[0]
    if ".spec_quote: these words" in e:
        return "quote_not_in_spec"
    if "does not appear in the spec" in e or "unknown page" in e:
        return "unknown_id"
    if "duplicate id" in e:
        return "duplicate_id"
    return "schema"


def read_answer(mode: Mode, response: Any) -> tuple[Any, str | None, str | None]:
    """(data, problem, tool_use_id). problem is None when there is data to validate."""
    stop = response.stop_reason
    if stop == "max_tokens":
        return None, "max_tokens", None
    if stop == "refusal":
        return None, "refusal", None
    if mode.via == "tool":
        call = next((b for b in response.content if b.type == "tool_use" and b.name == TOOL), None)
        if call is None:
            return None, "no_call", None
        return call.input, None, call.id
    text = "".join(b.text for b in response.content if b.type == "text")
    try:
        return json.loads(text), None, None
    except json.JSONDecodeError as exc:
        return None, f"invalid_json: {exc}", None


def run_case(client: Any, spec: Spec, screen: str, cfg: P4Config, meter: Meter,
             first: tuple[Any, float] | None = None) -> CaseResult:
    """One screen: request, validate, retry with the errors. `first` is a response already received from a batch."""
    mode = MODES[cfg.mode]
    req = build_request(mode, spec, screen, cfg)
    messages = req["messages"]
    result = CaseResult(screen, False, None)
    for n in range(1, cfg.max_attempts + 1):
        from_batch = n == 1 and first is not None
        if from_batch:
            response, seconds = first
        else:
            meter.check()
            t0 = time.monotonic()
            with client.messages.stream(**build_request(mode, spec, screen, cfg, messages)) as s:
                response = s.get_final_message()
            seconds = time.monotonic() - t0
        usage = usage_dict(response.usage)
        usd = cost_usd(mode.model, usage) * (0.5 if from_batch else 1.0)
        meter.add(usd)
        data, problem, tool_id = read_answer(mode, response)
        errors: list[str] = []
        if problem is None:
            parsed, errors = validate_question_list(data, spec, check_quotes=True, allow_empty=True)
            problem = None if parsed is not None else problem_kind(errors)
        thinking = sum(1 for b in response.content if b.type == "thinking")
        result.attempts.append(Attempt(response.stop_reason, problem, errors, thinking, usage, round(usd, 6),
                                       round(seconds, 2), from_batch))
        if problem is None:
            result.valid, result.outcome = True, "valid"
            result.questions = parsed.model_dump(mode="json")["questions"]
            return result
        if problem in ("max_tokens", "refusal"):
            result.outcome = problem
            return result
        messages = messages + [{"role": "assistant", "content": response.content}]
        if problem == "no_call":
            messages.append({"role": "user", "content": [{"type": "text", "text": NUDGE}]})
        elif tool_id is not None:
            messages.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id, "is_error": True,
                             "content": "The question list is invalid. Fix these and submit the full corrected list:\n- "
                             + "\n- ".join(errors)}]})
        else:
            detail = errors or [problem]
            messages.append({"role": "user", "content": [{"type": "text", "text": "Your answer is invalid. Fix these and "
                             "answer again with the full corrected list:\n- " + "\n- ".join(detail)}]})
    result.outcome = "invalid_after_retries"
    return result


def run_batch(client: Any, spec: Spec, screens: list[str], cfg: P4Config, log: Any) -> dict[str, tuple[Any, float]]:
    """First attempts through the Message Batches API (half price). Retries run synchronously afterwards."""
    mode = MODES[cfg.mode]
    t0 = time.monotonic()
    batch = client.messages.batches.create(requests=[
        {"custom_id": s, "params": build_request(mode, spec, s, cfg)} for s in screens])
    log({"batch_id": batch.id, "status": batch.processing_status})
    while batch.processing_status != "ended":
        time.sleep(cfg.batch_poll_s)
        batch = client.messages.batches.retrieve(batch.id)
        log({"batch_status": batch.processing_status, "elapsed_s": round(time.monotonic() - t0, 1)})
    seconds = time.monotonic() - t0
    out = {}
    for entry in client.messages.batches.results(batch.id):
        if entry.result.type == "succeeded":
            out[entry.custom_id] = (entry.result.message, seconds)
        else:
            log({"batch_entry_failed": entry.custom_id, "type": entry.result.type})
    return out


def run_test_set(client: Any, spec: Spec, cfg: P4Config, log_path: Path | None = None) -> tuple[list[CaseResult], float]:
    """Every case; returns the results and the wall time. The first case runs alone so the others read its cache."""
    screens = cfg.screens or [p for p in spec.page_ids if p.startswith("SC-")]
    meter = Meter(cfg.budget_left_usd)
    lock = threading.Lock()

    def log(row: dict[str, Any]) -> None:
        if log_path:
            with lock, log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")

    def one(screen: str, first: tuple[Any, float] | None = None) -> CaseResult:
        try:
            r = run_case(client, spec, screen, cfg, meter, first)
        except BudgetStop as exc:
            r = CaseResult(screen, False, None, outcome=f"budget: {exc}")
        log({"screen": screen, "outcome": r.outcome, "attempts": [asdict(a) for a in r.attempts]})
        return r

    t0 = time.monotonic()
    if cfg.batch:
        firsts = run_batch(client, spec, screens, cfg, log)
        with ThreadPoolExecutor(cfg.concurrency) as pool:
            results = list(pool.map(lambda s: one(s, firsts.get(s)), screens))
    else:
        results = [one(screens[0])]
        with ThreadPoolExecutor(cfg.concurrency) as pool:
            results += list(pool.map(one, screens[1:]))
    return results, round(time.monotonic() - t0, 1)


def merged_questions(results: list[CaseResult]) -> list[dict[str, Any]]:
    out = []
    for r in results:
        for q in r.questions or []:
            out.append({**q, "id": f"Q{len(out) + 1:03d}", "case": r.screen})
    return out


def summarise(results: list[CaseResult], seconds: float, answers: dict[str, Any], cfg: P4Config) -> dict[str, Any]:
    first = [r.attempts[0] for r in results if r.attempts]
    problems = Counter(a.problem for r in results for a in r.attempts if a.problem)
    usage = Counter()
    for r in results:
        for a in r.attempts:
            usage.update(a.usage)
    merged = merged_questions(results)
    sc = score(merged, answers)
    return {
        "part": 4, "mode": cfg.mode, "model": MODES[cfg.mode].model, "effort": cfg.effort, "few_shot": cfg.few_shot,
        "batch": cfg.batch, "cases": len(results),
        "valid_first": sum(1 for a in first if a.problem is None),
        "valid_final": sum(1 for r in results if r.valid),
        "attempts": sum(len(r.attempts) for r in results),
        "problems": dict(problems),
        "first_attempts_with_thinking": sum(1 for a in first if a.thinking_blocks),
        "outcomes": {r.screen: r.outcome for r in results if not r.valid},
        "usage": dict(usage),
        "cost_usd": round(sum(r.cost_usd for r in results), 5),
        "seconds": seconds,
        "case_seconds_mean": round(sum(a.seconds for a in first) / max(len(first), 1), 1),
        "score": {k: sc[k] for k in ("questions", "found", "found_with_kind", "severity_agree", "missed")}
        | {"false_positives": len(sc["false_positives"]), "accepted_unplanned": len(sc["accepted_unplanned"]),
           "unplanned_for_review": len(sc["unplanned_for_review"]),
           "false_positive_ids": sorted({f["non_issue"] for f in sc["false_positives"]})},
    }
