"""Part 1: a hand-written agent loop on the Messages API.

The loop owns every decision the Agent SDK would hide: what each stop_reason means, when to stop, how many
steps, how tool errors go back, when to retry an invalid output. Each step is logged with tokens and cost.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .pricing import cost_usd, usage_dict
from .prompts import SYSTEM_PROMPT, USER_PROMPT, build_tools
from .schema import QuestionList, validate_question_list
from .spec import Spec

NUDGE = "質問表がまだ提出されていません。submit_question_list ツールで質問表を提出してください。"


@dataclass
class RunConfig:
    model: str = "claude-sonnet-5-5"
    effort: str = "medium"
    max_steps: int = 25
    max_submits: int = 3
    max_tokens: int = 32000
    fallbacks: bool = False
    budget_left_usd: float = 30.0


@dataclass
class RunResult:
    outcome: str
    steps: int
    submits: int
    usage: dict[str, int]
    cost_usd: float
    seconds: float
    question_list: QuestionList | None
    detail: str | None = None


def run(client: Any, spec: Spec, cfg: RunConfig, log: Path | None = None) -> RunResult:
    tools = build_tools(spec.page_ids)
    messages: list[dict[str, Any]] = [{"role": "user", "content": [{"type": "text", "text": USER_PROMPT}]}]
    total = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
    cost = 0.0
    accepted: QuestionList | None = None
    submits = 0
    nudged = False
    started = time.monotonic()
    outcome, detail = "step_limit", None
    step = 0

    for step in range(1, cfg.max_steps + 1):
        _move_cache_mark(messages)
        request = {
            "model": cfg.model,
            "max_tokens": cfg.max_tokens,
            "system": SYSTEM_PROMPT,
            "tools": tools,
            "messages": messages,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": cfg.effort},
        }
        t0 = time.monotonic()
        response = _call(client, request, cfg.fallbacks)
        usage = usage_dict(response.usage)
        step_cost = cost_usd(cfg.model, usage)
        cost += step_cost
        for k in total:
            total[k] += usage[k]
        called = [b.name for b in response.content if b.type == "tool_use"]
        _log(log, {"step": step, "stop_reason": response.stop_reason, "tools": called, **usage,
                   "cost_usd": round(step_cost, 5), "seconds": round(time.monotonic() - t0, 2)})

        stop = response.stop_reason
        if stop == "tool_use":
            messages.append({"role": "assistant", "content": response.content})
            results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                if block.name == "submit_question_list":
                    submits += 1
                    parsed, errors = validate_question_list(block.input, spec)
                    if parsed:
                        accepted = parsed
                        results.append(_result(block.id, f"Accepted: {len(parsed.questions)} questions. Reply with one short line to finish."))
                    else:
                        left = cfg.max_submits - submits
                        _log(log, {"step": step, "invalid_submit": submits, "errors": errors})
                        results.append(_result(block.id, "The question list is invalid. Fix these and resubmit the full list "
                                               f"({left} attempts left):\n- " + "\n- ".join(errors), error=True))
                else:
                    results.append(_run_tool(block, spec))
            messages.append({"role": "user", "content": results})
            if accepted is None and submits >= cfg.max_submits:
                outcome = "invalid_output"
                break
        elif stop == "pause_turn":
            messages.append({"role": "assistant", "content": response.content})
        elif stop in ("end_turn", "stop_sequence"):
            if accepted is not None:
                outcome = "done"
                break
            if nudged:  # auto tool_choice does not guarantee a call: nudge once, then give up
                outcome = "no_submission"
                break
            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": [{"type": "text", "text": NUDGE}]})
            nudged = True
        elif stop == "max_tokens":
            outcome, detail = "max_tokens", f"max_tokens={cfg.max_tokens} reached at step {step}"
            break
        elif stop == "refusal":
            sd = getattr(response, "stop_details", None)
            outcome = "refusal"
            detail = f"{getattr(sd, 'category', None)}: {getattr(sd, 'explanation', None)}" if sd else None
            break
        elif stop == "model_context_window_exceeded":
            outcome = "context_window_exceeded"
            break
        else:
            outcome, detail = "unexpected_stop", str(stop)
            break

        if cost >= cfg.budget_left_usd:
            outcome, detail = "budget", f"run cost {cost:.4f} reached the budget left {cfg.budget_left_usd:.4f}"
            break

    if outcome == "step_limit" and accepted is not None:
        outcome = "done_without_end_turn"
    result = RunResult(outcome, step, submits, total, round(cost, 5), round(time.monotonic() - started, 1), accepted, detail)
    if log:
        _write_transcript(log.parent / "transcript.json", messages)
    return result


def _call(client: Any, request: dict[str, Any], fallbacks: bool) -> Any:
    # Streaming: a non-streaming call with a large max_tokens can time out; the final message is the same object.
    if fallbacks:
        stream = client.beta.messages.stream(**request, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    else:
        stream = client.messages.stream(**request)
    with stream as s:
        return s.get_final_message()


def _run_tool(block: Any, spec: Spec) -> dict[str, Any]:
    if block.name == "list_pages":
        pages = [{"page_id": p.page_id, "title": p.title} for p in spec.pages.values()]
        return _result(block.id, json.dumps(pages, ensure_ascii=False))
    if block.name == "read_page":
        page_id = block.input.get("page_id", "")
        page = spec.pages.get(page_id)
        if page is None:
            return _result(block.id, f"Unknown page_id {page_id!r}. Valid page IDs: {', '.join(spec.page_ids)}", error=True)
        return _result(block.id, page.text)
    return _result(block.id, f"Unknown tool {block.name!r}", error=True)


def _result(tool_use_id: str, content: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}
    if error:
        out["is_error"] = True
    return out


def _move_cache_mark(messages: list[dict[str, Any]]) -> None:
    """Keep one cache breakpoint on the last block of the newest user turn, so each step reads the prefix from cache."""
    for m in messages:
        if m["role"] == "user":
            for b in m["content"]:
                b.pop("cache_control", None)
    messages[-1]["content"][-1]["cache_control"] = {"type": "ephemeral"}


def _log(log: Path | None, row: dict[str, Any]) -> None:
    if log:
        with log.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _write_transcript(path: Path, messages: list[dict[str, Any]]) -> None:
    def plain(b: Any) -> Any:
        if isinstance(b, dict):
            return {k: v for k, v in b.items() if k != "cache_control"}
        if hasattr(b, "model_dump"):
            return b.model_dump(mode="json", exclude_none=True)
        return vars(b) if hasattr(b, "__dict__") else str(b)

    rows = [{"role": m["role"], "content": [plain(b) for b in m["content"]]} for m in messages]
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=1, default=str), encoding="utf-8")


def result_summary(r: RunResult) -> dict[str, Any]:
    d = asdict(r)
    d["question_list"] = len(r.question_list.questions) if r.question_list else None
    return d
