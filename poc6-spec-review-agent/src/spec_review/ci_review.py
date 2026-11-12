"""Part 7 (A5): the review as a CI step, in two independent Claude Code sessions, and the code that checks them.

Session 1 reviews a screen with `/review-spec`, or, when the findings of an earlier run are given, with
`/re-review-spec <screen> <prior file>`, which must report only what is new (task statement 3.6). Session 2 is a
separate `claude -p` process that runs the `verify-findings` skill (`context: fork`) on the question list: it never
sees session 1's context, so it cannot simply agree with the reviewer's reasoning (task statement 4.6).

Code, not a model, decides the result: the questions are validated against the spec; a re-review question that is
the same finding as a prior one (the rule of docs/review-policy.md) is counted as a duplicate; every prior finding
must be placed in still_open or addressed; every finding must get one verdict; and the verdicts are compared with the
scorer's labels. `ci/spec-review.yml` is a template of the pipeline that would run this on a pull request.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .headless import HeadlessResult, check_review, review_schema
from .score import score
from .spec import Spec


VERIFY_PROMPT = ("Use the verify-findings skill on {file}. Do not judge the findings yourself. Then answer with the "
                 "structured output: the skill's verdicts, one per finding, unchanged, and rule_tags.")
VERIFY_TOOLS = ["Skill", "Read", "mcp__spec__read_page", "mcp__spec__search_spec"]


def same_finding(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """The policy's rule: at least one shared item ID and the same kind."""
    return a["kind"] == b["kind"] and bool(set(a["location"]["item_ids"]) & set(b["location"]["item_ids"]))


def re_review_schema(spec: Spec) -> dict[str, Any]:
    s = review_schema(spec)
    ids = {"type": "array", "items": {"type": "string"}}
    s["properties"] |= {"still_open": ids | {"description": "IDs of prior findings that are not addressed"},
                        "addressed": ids | {"description": "IDs of prior findings that the spec now answers"}}
    s["required"] = s["required"] + ["still_open", "addressed"]
    return s


def verify_schema() -> dict[str, Any]:
    verdict = {"type": "object",
               "properties": {"id": {"type": "string"}, "is_real_problem": {"type": "boolean"},
                              "confidence": {"type": "number"}, "reason": {"type": "string"}},
               "required": ["id", "is_real_problem", "confidence", "reason"], "additionalProperties": False}
    return {"type": "object",
            "properties": {"rule_tags": {"type": "array", "items": {"type": "string"},
                                         "description": "Every 'Rule tag:' value in your instructions, as written."},
                           "verdicts": {"type": "array", "items": verdict}},
            "required": ["rule_tags", "verdicts"], "additionalProperties": False}


def check_re_review(res: HeadlessResult, spec: Spec, answers: dict[str, Any], screen: str,
                    prior: list[dict[str, Any]]) -> dict[str, Any]:
    out = check_review(res, spec, answers, screen)
    a = res.answer if isinstance(res.answer, dict) else {}
    new = out["questions"]
    duplicates = [{"new": q["id"], "prior": p["id"]} for q in new for p in prior if same_finding(q, p)]
    open_, done = set(a.get("still_open") or []), set(a.get("addressed") or [])
    prior_ids = {p["id"] for p in prior}
    # The spec does not change between the two runs, so no prior finding can have been addressed.
    out["checks"] |= {"no_duplicates": not duplicates, "prior_all_placed": prior_ids == open_ | done,
                      "prior_placed_once": not (open_ & done), "nothing_addressed_on_unchanged_spec": not done}
    out["passed"], out["of"] = sum(out["checks"].values()), len(out["checks"])
    union = prior + [q | {"id": f"N{q['id']}"} for q in new]
    before, after = score(prior, answers), score(union, answers)
    out |= {"duplicates": duplicates, "still_open": sorted(open_), "addressed": sorted(done),
            "found_before": before["found"], "found_after": after["found"],
            "new_planted_found": sorted(set(after["matches"]) - set(before["matches"]))}
    return out


def labels(questions: list[dict[str, Any]], answers: dict[str, Any]) -> dict[str, str | None]:
    s = score(questions, answers)
    real = set(s["matches"].values()) | {a["question"] for a in s["accepted_unplanned"]}
    fp = {f["question"] for f in s["false_positives"]}
    return {q["id"]: "real" if q["id"] in real else "not_real" if q["id"] in fp else None for q in questions}


def check_verify(res: HeadlessResult, questions: list[dict[str, Any]], answers: dict[str, Any],
                 expected_tags: set[str]) -> dict[str, Any]:
    raw, a = res.raw or {}, res.answer if isinstance(res.answer, dict) else {}
    verdicts = a.get("verdicts") or []
    ids = [v["id"] for v in verdicts]
    want = [q["id"] for q in questions]
    lab = labels(questions, answers)
    rows = [{"id": v["id"], "label": lab.get(v["id"]), "is_real_problem": v["is_real_problem"],
             "confidence": v["confidence"], "reason": v["reason"]} for v in verdicts if v["id"] in lab]
    judged = [r for r in rows if r["label"] is not None]
    agree = [r for r in judged if r["is_real_problem"] == (r["label"] == "real")]
    checks = {"exit_0": res.returncode == 0, "structured_output": raw.get("structured_output") is not None,
              "one_verdict_per_finding": sorted(ids) == sorted(want) and len(ids) == len(set(ids)),
              "confidence_in_range": all(0 <= v["confidence"] <= 1 for v in verdicts),
              "policy_loaded": expected_tags <= set(a.get("rule_tags") or [])}
    return {"checks": checks, "passed": sum(checks.values()), "of": len(checks), "verdicts": rows,
            "labelled": len(judged), "agree_with_scorer": len(agree),
            "rejected": [r["id"] for r in rows if not r["is_real_problem"]],
            "rule_tags": sorted(a.get("rule_tags") or []),
            "subagents": (raw.get("subagent_stats") or {}).get("spawned")}


def pr_comment(screen: str, review: dict[str, Any], verify: dict[str, Any] | None, re_review: bool) -> str:
    """The text a CI job would post on the pull request."""
    lines = [f"## Spec review: {screen}", ""]
    qs = review["questions"]
    rej = set((verify or {}).get("rejected", []))
    if re_review:
        lines.append(f"Re-review: {len(qs)} new finding(s); {len(review['still_open'])} earlier finding(s) still open; "
                     f"{len(review['duplicates'])} duplicate(s) of earlier findings.")
    lines += ["", "| ID | Severity | Kind | Verifier | Question |", "|---|---|---|---|---|"]
    by_id = {v["id"]: v for v in (verify or {}).get("verdicts", [])}
    for q in qs:
        v = by_id.get(q["id"])
        mark = "not run" if v is None else f"{'kept' if v['is_real_problem'] else 'rejected'} ({v['confidence']:.2f})"
        lines.append(f"| {q['id']} | {q['severity']} | {q['kind']} | {mark} | {q['question']} |")
    if rej:
        lines += ["", f"Rejected by the verifier, for a person to read: {', '.join(sorted(rej))}."]
    return "\n".join(lines) + "\n"


def load_prior(path: Path) -> list[dict[str, Any]]:
    return json.loads(path.read_text("utf-8"))["questions"]
