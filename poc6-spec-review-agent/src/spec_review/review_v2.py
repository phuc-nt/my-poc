"""Part 7 (A2 and A6): the part 4 test set with a richer schema, a retry policy that knows when to stop, a manifest
that survives a crash, and a synthesis report that keeps its sources.

A2, the schema (task statements 4.3, 4.4):
- `kind` gains `other`, with a required `kind_detail`, so a problem that fits no category is not forced into one;
- `detected_pattern` names what made the reviewer flag the item, so false positives can be counted per pattern;
- a contradiction carries `sides`: each item ID with the value copied from that item's row. Code computes whether the
  values really differ (`conflict_verified`) and compares it with the model's own `conflict_detected`.

A2, the retry policy: an error the model can fix (schema, a quote or value not copied exactly) goes back with the
errors, as in part 4. An error no retry can fix, because the information is not in the request (a side defined on a
page this case does not see), is never sent back: that question is dropped and recorded. A retry that returns the
same errors as the one before stops the case (`no_progress`).

A6, crash recovery and provenance (task statements 5.3, 5.4, 5.6): `manifest.json` records each case's status after
every case, and each finished case is written to `cases/<screen>.json`. A run stopped part way (`stop_after`, the
stand-in for a crash) resumes from the manifest and requests only the cases not done. The report says which screens
it covers and which it does not and why, gives every claim its sources (case, item rows, quote, spec hash), and keeps
two claims that disagree side by side with a note instead of choosing one.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .extract import MODES, Attempt, BudgetStop, CaseResult, Meter, P4Config, build_request, read_answer
from .mcp_server import spec_hash
from .pricing import cost_usd, usage_dict
from .schema import Location, Severity, _plain, question_list_schema, quote_in_spec
from .score import score
from .spec import DEFINED_PATTERN, Spec

PATTERNS = ["vague_wording", "value_mismatch", "undefined_reference", "undefined_state", "role_mismatch",
            "missing_rule", "missing_item", "other"]


class KindV2(str, Enum):
    missing = "missing"
    contradiction = "contradiction"
    ambiguous = "ambiguous"
    other = "other"


class Side(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_id: str
    value: str = Field(min_length=1, max_length=200)


class QuestionV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^Q\d{3}$")
    location: Location
    kind: KindV2
    kind_detail: str | None = Field(max_length=200)
    detected_pattern: str
    severity: Severity
    issue: str = Field(min_length=5, max_length=400)
    question: str = Field(min_length=5, max_length=400)
    spec_quote: str | None = Field(max_length=300)
    sides: list[Side] = Field(max_length=4)
    conflict_detected: bool
    proposed_answer: str | None = Field(max_length=300)

    @model_validator(mode="after")
    def _shape(self) -> "QuestionV2":
        if self.detected_pattern not in PATTERNS:
            raise ValueError(f"detected_pattern must be one of {PATTERNS}")
        if self.kind == KindV2.other and not (self.kind_detail or "").strip():
            raise ValueError("kind 'other' needs kind_detail: say what kind of problem it is")
        if not any("぀" <= ch <= "ヿ" or "一" <= ch <= "鿿" for ch in self.question):
            raise ValueError("question must be written in Japanese")
        return self


class QuestionListV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    questions: list[QuestionV2] = Field(max_length=60)


def schema_v2(page_ids: list[str]) -> dict[str, Any]:
    base = question_list_schema(page_ids, min_questions=0)
    item = base["properties"]["questions"]["items"]
    nullable = {"anyOf": [{"type": "string"}, {"type": "null"}]}
    props = dict(item["properties"])
    props["kind"] = {"type": "string", "enum": [k.value for k in KindV2],
                     "description": "other only when none of missing, contradiction, ambiguous fits"}
    props["kind_detail"] = {**nullable, "description": "Required for kind other: what kind of problem it is. Else null."}
    props["detected_pattern"] = {"type": "string", "enum": PATTERNS,
                                 "description": "What in the spec made you flag this item."}
    props["sides"] = {"type": "array", "description": "For a contradiction: each side's item ID and the conflicting "
                      "value copied exactly from that item's row (at least two). Empty for other kinds.",
                      "items": {"type": "object", "properties": {"item_id": {"type": "string"},
                                                                  "value": {"type": "string"}},
                                "required": ["item_id", "value"], "additionalProperties": False}}
    props["conflict_detected"] = {"type": "boolean", "description": "true only when the side values really differ"}
    order = ["id", "location", "kind", "kind_detail", "detected_pattern", "severity", "issue", "question",
             "spec_quote", "sides", "conflict_detected", "proposed_answer"]
    item = {**item, "properties": {k: props[k] for k in order}, "required": order}
    return {**base, "properties": {"questions": {**base["properties"]["questions"], "items": item}}}


V2_ASK = """
各質問には次の項目も付けてください。
- detected_pattern: その項目を問題と判断した根拠のパターン。
- kind が missing / contradiction / ambiguous のどれにも当てはまらない場合だけ other とし、kind_detail に種類を書く。
- 矛盾（contradiction）の場合は sides に各側の item_id と、その項目の行から正確に写した値を2つ以上入れる。sides に使える
  のはこの画面・OVR・CMN で定義された項目だけです。conflict_detected は、写した値が実際に食い違うときだけ true。
"""


def build_request_v2(mode_name: str, spec: Spec, screen: str, cfg: P4Config,
                     messages: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    mode = MODES[mode_name]
    req = build_request(mode, spec, screen, cfg, messages)
    if messages is None:
        req["messages"][0]["content"][0]["text"] += "\n" + V2_ASK
    schema = schema_v2(spec.page_ids)
    if mode.via == "tool":
        req["tools"][0]["input_schema"] = schema
    else:
        req["output_config"]["format"]["schema"] = schema
    return req


def item_row(spec: Spec, item_id: str) -> tuple[str, str] | None:
    """(page, line) where the item is defined: the table row or heading that opens with its ID."""
    for page in spec.pages.values():
        for line in page.text.splitlines():
            m = DEFINED_PATTERN.match(line)
            if m and m.group(1) == item_id:
                return page.page_id, line.strip()
    return None


@dataclass
class Problem:
    qid: str
    message: str
    fixable: bool = True


def conflict_verified(q: dict[str, Any], spec: Spec) -> bool:
    """Code's own answer to "do the sides conflict": every value is in its item's row, and the values differ."""
    sides = q.get("sides") or []
    if len({s["item_id"] for s in sides}) < 2:
        return False
    for s in sides:
        row = item_row(spec, s["item_id"])
        if row is None or _plain(s["value"]) not in _plain(row[1]):
            return False
    return len({_plain(s["value"]) for s in sides}) >= 2


def validate_v2(data: Any, spec: Spec, screen: str) -> tuple[list[dict[str, Any]] | None, list[Problem]]:
    try:
        parsed = QuestionListV2.model_validate(data)
    except ValidationError as exc:
        return None, [Problem("-", f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}") for e in exc.errors()[:20]]
    visible = {screen, "OVR", "CMN"}
    problems: list[Problem] = []
    seen: set[str] = set()
    out = []
    for q in parsed.questions:
        d = q.model_dump(mode="json")
        p = len(problems)
        if q.id in seen:
            problems.append(Problem(q.id, f"{q.id}: duplicate id"))
        seen.add(q.id)
        if q.location.page not in spec.pages:
            problems.append(Problem(q.id, f"{q.id}.location.page: unknown page {q.location.page!r}"))
        for item_id in q.location.item_ids:
            if item_id not in spec.all_ids:
                problems.append(Problem(q.id, f"{q.id}.location.item_ids: {item_id!r} does not appear in the spec"))
        if q.spec_quote and not quote_in_spec(q.spec_quote, spec):
            problems.append(Problem(q.id, f"{q.id}.spec_quote: these words do not occur in the spec; copy them "
                                    "exactly or use null"))
        if q.kind == KindV2.contradiction:
            for s in q.sides:
                row = item_row(spec, s.item_id)
                if row is None:
                    problems.append(Problem(q.id, f"{q.id}.sides: {s.item_id!r} is not defined in the spec"))
                elif row[0] not in visible:
                    # The row is on a page this case does not see. No retry can fix that: the value is not in the
                    # request. The question is dropped, not sent back.
                    problems.append(Problem(q.id, f"{q.id}.sides: {s.item_id} is defined on {row[0]}, which this "
                                            "request does not contain", fixable=False))
                elif _plain(s.value) not in _plain(row[1]):
                    problems.append(Problem(q.id, f"{q.id}.sides: the value {s.value!r} is not in the row of "
                                            f"{s.item_id}; copy it exactly"))
            if len({s.item_id for s in q.sides}) < 2:
                problems.append(Problem(q.id, f"{q.id}.sides: a contradiction needs two sides with different items"))
        d["conflict_verified"] = conflict_verified(d, spec) if q.kind == KindV2.contradiction else False
        if len(problems) == p:
            if q.kind == KindV2.contradiction and not d["conflict_verified"]:
                problems.append(Problem(q.id, f"{q.id}: the side values do not differ, so this is not a contradiction; "
                                        "change the kind or the sides"))
            elif q.conflict_detected != d["conflict_verified"]:
                problems.append(Problem(q.id, f"{q.id}.conflict_detected is {str(q.conflict_detected).lower()} but "
                                        f"the copied sides say {str(d['conflict_verified']).lower()}"))
        out.append(d)
    return out, problems


@dataclass
class CaseV2(CaseResult):
    dropped: list[dict[str, Any]] = field(default_factory=list)
    stated_vs_computed: list[dict[str, Any]] = field(default_factory=list)  # first-attempt disagreements


def run_case_v2(client: Any, spec: Spec, screen: str, cfg: P4Config, meter: Meter) -> CaseV2:
    mode = MODES[cfg.mode]
    messages = build_request_v2(cfg.mode, spec, screen, cfg)["messages"]
    result = CaseV2(screen, False, None)
    last: list[str] | None = None
    for n in range(1, cfg.max_attempts + 1):
        meter.check()
        t0 = time.monotonic()
        with client.messages.stream(**build_request_v2(cfg.mode, spec, screen, cfg, messages)) as s:
            response = s.get_final_message()
        seconds = time.monotonic() - t0
        usage = usage_dict(response.usage)
        usd = cost_usd(mode.model, usage)
        meter.add(usd)
        data, problem, tool_id = read_answer(mode, response)
        questions, problems = (validate_v2(data, spec, screen) if problem is None else (None, []))
        if n == 1 and questions:
            result.stated_vs_computed = [{"id": q["id"], "stated": q["conflict_detected"],
                                          "computed": q["conflict_verified"]} for q in questions
                                         if q["kind"] == "contradiction" or q["conflict_detected"]
                                         if q["conflict_detected"] != q["conflict_verified"]]
        unfixable = {p.qid for p in problems if not p.fixable}
        for p in problems:
            if not p.fixable and not any(d["qid"] == p.qid and d["attempt"] == n for d in result.dropped):
                result.dropped.append({"qid": p.qid, "attempt": n, "reason": p.message})
        fixable = [p.message for p in problems if p.fixable and p.qid not in unfixable]
        label = problem or ("schema" if questions is None else ("fixable" if fixable else None))
        thinking = sum(1 for b in response.content if b.type == "thinking")
        result.attempts.append(Attempt(response.stop_reason, label, fixable or [p.message for p in problems],
                                       thinking, usage, round(usd, 6), round(seconds, 2)))
        if label is None:
            kept = [q for q in questions if q["id"] not in unfixable]
            result.valid, result.questions = True, kept
            result.outcome = "valid_with_dropped" if unfixable else "valid"
            return result
        if problem in ("max_tokens", "refusal"):
            result.outcome = problem
            return result
        errors = fixable or [p.message for p in problems] or [problem]
        if errors == last:
            result.outcome = "no_progress"  # the same errors twice: another retry would cost and change nothing
            return result
        last = errors
        note = ""
        if unfixable:
            note = ("\nRemoved, do not submit again: " + ", ".join(sorted(unfixable)) +
                    " (a side is defined on a page this request does not contain).")
        text = "The question list is invalid. Fix these and submit the full corrected list:\n- " + "\n- ".join(errors) + note
        messages = messages + [{"role": "assistant", "content": response.content}]
        if tool_id is not None:
            messages.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id,
                                                          "is_error": True, "content": text}]})
        else:
            messages.append({"role": "user", "content": [{"type": "text", "text": text}]})
    result.outcome = "invalid_after_retries"
    return result


# --- A6: manifest, resume, synthesis -------------------------------------------------------------------------------

def _write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    os.replace(tmp, path)  # atomic: a crash leaves the old file or the new one, never half of one


def new_manifest(spec: Spec, cfg: P4Config, screens: list[str]) -> dict[str, Any]:
    return {"spec_hash": spec_hash(spec), "config": {"mode": cfg.mode, "effort": cfg.effort, "few_shot": cfg.few_shot,
                                                      "max_attempts": cfg.max_attempts},
            "created": datetime.now().isoformat(timespec="seconds"),
            "cases": {s: {"status": "pending"} for s in screens}, "events": []}


def resume_problem(manifest: dict[str, Any], spec: Spec) -> str | None:
    if manifest["spec_hash"] != spec_hash(spec):
        return "the spec changed since the run started; its finished cases would mix two versions"
    return None


def run_v2(client: Any, spec: Spec, cfg: P4Config, run_dir: Path, stop_after: int | None = None) -> dict[str, Any]:
    """Run every case not yet done in `run_dir`'s manifest (a new run when there is none)."""
    mpath = run_dir / "manifest.json"
    (run_dir / "cases").mkdir(exist_ok=True)
    screens = cfg.screens or [p for p in spec.page_ids if p.startswith("SC-")]
    manifest = json.loads(mpath.read_text("utf-8")) if mpath.exists() else new_manifest(spec, cfg, screens)
    todo = [s for s, c in manifest["cases"].items() if c["status"] != "done"]
    manifest["events"].append({"at": datetime.now().isoformat(timespec="seconds"),
                               "event": "resume" if mpath.exists() else "start", "todo": todo})
    _write_json(mpath, manifest)
    meter, lock = Meter(cfg.budget_left_usd), threading.Lock()
    started = 0
    spent = 0.0

    def one(screen: str) -> None:
        nonlocal started, spent
        with lock:
            if stop_after is not None and started >= stop_after:
                return  # the stand-in for a crash: the case is never started and stays pending
            started += 1
        try:
            r = run_case_v2(client, spec, screen, cfg, meter)
        except BudgetStop as exc:
            r = CaseV2(screen, False, None, outcome=f"budget: {exc}")
        _write_json(run_dir / "cases" / f"{screen}.json", asdict(r))
        with lock:
            spent += r.cost_usd
            manifest["cases"][screen] = {"status": "done" if r.valid else "failed", "outcome": r.outcome,
                                         "attempts": len(r.attempts), "cost_usd": round(r.cost_usd, 6),
                                         "file": f"cases/{screen}.json"}
            _write_json(mpath, manifest)

    if todo:
        one(todo[0])  # alone first, so the others read its cache
        with ThreadPoolExecutor(cfg.concurrency) as pool:
            list(pool.map(one, todo[1:]))
    manifest["events"].append({"at": datetime.now().isoformat(timespec="seconds"), "event": "stop",
                               "cost_usd": round(spent, 6),
                               "pending": [s for s, c in manifest["cases"].items() if c["status"] == "pending"]})
    _write_json(mpath, manifest)
    return {"manifest": manifest, "cost_usd": round(spent, 6), "requested": min(len(todo), stop_after or len(todo))}


def load_cases(run_dir: Path) -> dict[str, dict[str, Any]]:
    return {p.stem: json.loads(p.read_text("utf-8")) for p in sorted((run_dir / "cases").glob("*.json"))}


def synthesise(run_dir: Path, spec: Spec, answers: dict[str, Any]) -> dict[str, Any]:
    manifest = json.loads((run_dir / "manifest.json").read_text("utf-8"))
    cases = load_cases(run_dir)
    claims = []
    for screen, c in cases.items():
        if manifest["cases"][screen]["status"] != "done":
            continue
        for q in c["questions"] or []:
            sources = []
            for item in q["location"]["item_ids"]:
                row = item_row(spec, item)
                sources.append({"item_id": item, "page": row[0] if row else None, "row": row[1] if row else None})
            quote_pages = [p.page_id for p in spec.pages.values()
                           if q["spec_quote"] and _plain(q["spec_quote"]) in _plain(p.text)]
            claims.append({**q, "id": f"Q{len(claims) + 1:03d}", "case_qid": q["id"], "case": screen,
                           "sources": sources, "quote_found_on": quote_pages, "spec_hash": manifest["spec_hash"]})
    missing = [{"screen": s, "status": c["status"], "outcome": c.get("outcome", "not run")}
               for s, c in manifest["cases"].items() if c["status"] != "done"]
    # Two cases that cite the same item and disagree on kind or severity: both stay, with a note.
    by_item: dict[str, list[dict[str, Any]]] = {}
    for cl in claims:
        for item in cl["location"]["item_ids"]:
            by_item.setdefault(item, []).append(cl)
    conflicts = []
    for item, cls in sorted(by_item.items()):
        if len({c["case"] for c in cls}) < 2:
            continue
        kinds, sevs = {c["kind"] for c in cls}, {c["severity"] for c in cls}
        if len(kinds) > 1 or len(sevs) > 1:
            conflicts.append({"item_id": item, "claims": [{"id": c["id"], "case": c["case"], "kind": c["kind"],
                                                           "severity": c["severity"]} for c in cls],
                              "note": "cases disagree on " + " and ".join(
                                  x for x, s in (("kind", kinds), ("severity", sevs)) if len(s) > 1)
                              + "; both kept for a person to decide"})
    sc = score(claims, answers)
    planted_screens = {s for p in answers["problems"] for a in p["anchors"] for s in [a[:5]] if s.startswith("SC-")}
    not_covered = sorted(planted_screens & {m["screen"] for m in missing})
    by_q = {c["id"]: c for c in claims}
    fp_q = {f["question"] for f in sc["false_positives"]}
    acc_q = {a["question"] for a in sc["accepted_unplanned"]}
    matched_q = set(sc["matches"].values())
    patterns: dict[str, Counter] = {}
    for c in claims:
        t = patterns.setdefault(c["detected_pattern"], Counter())
        t["questions"] += 1
        t["matched"] += c["id"] in matched_q
        t["accepted"] += c["id"] in acc_q
        t["false_positive"] += c["id"] in fp_q
        t["unplanned"] += c["id"] in set(sc["unplanned_for_review"])
    report = {
        "spec_hash": manifest["spec_hash"],
        "coverage": {"screens": len(manifest["cases"]), "reviewed": len(manifest["cases"]) - len(missing),
                     "missing": missing, "screens_with_planted_problems_not_reviewed": not_covered,
                     "note": ("complete" if not missing else
                              f"partial: {len(missing)} screen(s) not reviewed; findings about them are absent, "
                              "not negative")},
        "claims": claims, "conflicts": conflicts,
        "score": {k: sc[k] for k in ("questions", "found", "recall", "found_with_kind", "severity_agree", "missed")}
        | {"false_positives": len(sc["false_positives"]), "accepted_unplanned": len(sc["accepted_unplanned"]),
           "unplanned_for_review": len(sc["unplanned_for_review"])},
        "patterns": {k: dict(v) for k, v in sorted(patterns.items())},
        "kind_other": [{"id": c["id"], "kind_detail": c["kind_detail"]} for c in claims if c["kind"] == "other"],
        "dropped": {s: c["dropped"] for s, c in cases.items() if c.get("dropped")},
        "stated_vs_computed": {s: c["stated_vs_computed"] for s, c in cases.items() if c.get("stated_vs_computed")},
        "outcomes": {s: c["outcome"] for s, c in cases.items()},
    }
    _write_json(run_dir / "report.json", report)
    (run_dir / "report.md").write_text(report_markdown(report, by_q), encoding="utf-8")
    return report


def report_markdown(r: dict[str, Any], by_q: dict[str, dict[str, Any]]) -> str:
    cov = r["coverage"]
    lines = [f"# Spec review report (spec {r['spec_hash']})", "",
             f"Coverage: {cov['reviewed']} of {cov['screens']} screens. {cov['note']}."]
    for m in cov["missing"]:
        lines.append(f"- Not reviewed: {m['screen']} ({m['status']}, {m['outcome']})")
    lines += ["", "## Claims", ""]
    for c in r["claims"]:
        src = "; ".join(f"{s['item_id']} on {s['page']}" for s in c["sources"])
        lines.append(f"- {c['id']} [{c['kind']}/{c['severity']}, {c['detected_pattern']}] {c['issue']} "
                     f"(case {c['case']} {c['case_qid']}; sources: {src}; quote on: "
                     f"{', '.join(c['quote_found_on']) or 'none'})")
    if r["conflicts"]:
        lines += ["", "## Conflicting claims (kept both)", ""]
        for x in r["conflicts"]:
            lines.append(f"- {x['item_id']}: " + ", ".join(f"{c['id']} from {c['case']} says {c['kind']}/{c['severity']}"
                                                          for c in x["claims"]) + f". {x['note']}.")
    return "\n".join(lines) + "\n"
