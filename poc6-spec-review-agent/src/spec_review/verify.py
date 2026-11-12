"""Part 7 (A3, A4): an independent verifier, calibrated against the answer list, run through the Message Batches API
with a resubmission of the failed requests.

A3 (task statements 4.6, 5.5). The reviewer's questions from earlier runs form a pool; code labels each one with the
scorer (matched or accepted: a real problem; a false positive: not one; anything else: unlabelled and left out) and
adds hand-written decoys on the non-issues N01 to N05. A stratified sample (label by kind) goes to a second model
instance that sees only the pages the question cites, OVR and CMN, and the question itself: none of the reviewer's
reasoning. It answers is_real_problem, kind, severity and a confidence. Code then measures, per confidence bucket and
per kind, how often the verdict agrees with the label, and picks the lowest confidence threshold above which the
verdicts can be taken without a person. A single overall accuracy would hide a segment that is wrong more often.

A4 (task statement 4.5). The verifier runs as one batch, `custom_id` = the pool item. A request that errors, expires
or returns an unusable answer (cut off at max_tokens, invalid JSON) is sent again with a fix, and only those
requests are. `inject_fault` gives one request a tiny max_tokens to prove the path. The batch API has no latency
promise (results within 24 hours, often minutes), so it suits a nightly audit like this one, never a check a
developer waits on before a merge.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

from .pricing import cost_usd, usage_dict
from .score import score
from .sdk_agent import CRITERIA
from .spec import Spec

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / "runs"
SONNET = "claude-sonnet-5-5"

# Questions a careful reviewer should NOT ask: each targets a non-issue of eval/answers.json. Synthetic, written for
# this PoC; they give the negative class enough members to measure.
DECOYS = [
    {"location": {"page": "SC-05", "item_ids": ["SC-05-F03"], "section": None}, "kind": "missing", "severity": "minor",
     "issue": "返却予定日の入力形式が画面仕様に記載されていない。",
     "question": "返却予定日の入力形式（YYYY/MM/DDなど）をご教示ください。", "spec_quote": None, "decoy": "N01"},
    {"location": {"page": "SC-10", "item_ids": ["SC-10-F03"], "section": None}, "kind": "missing", "severity": "major",
     "issue": "カテゴリの選択肢が定義されていない。",
     "question": "カテゴリの選択肢の一覧をご提示ください。", "spec_quote": None, "decoy": "N02"},
    {"location": {"page": "SC-09", "item_ids": ["SC-09-R03"], "section": None}, "kind": "ambiguous", "severity": "major",
     "issue": "延滞日数に土日祝日を含めるかが不明確である。",
     "question": "延滞日数の計算に土日祝日を含めるかご教示ください。", "spec_quote": None, "decoy": "N03"},
    {"location": {"page": "SC-06", "item_ids": ["SC-06-R02"], "section": None}, "kind": "contradiction",
     "severity": "major", "issue": "申請番号の形式と例の桁数が一致していない。",
     "question": "申請番号の形式と記載例のどちらが正しいでしょうか。", "spec_quote": None, "decoy": "N04"},
    {"location": {"page": "SC-07", "item_ids": ["SC-07-F02"], "section": None}, "kind": "contradiction",
     "severity": "major", "issue": "コメント欄が任意とされているのに、却下時は必須とされており矛盾している。",
     "question": "コメント欄は必須でしょうか、任意でしょうか。", "spec_quote": None, "decoy": "N05"},
]

VERIFY_PROMPT = """\
You check ONE question that a reviewer wrote about a Japanese screen specification (仕様書). Decide on your own,
from the pages given, whether it is a real problem the customer must answer before design starts. It is not one when
the spec already answers it: a common rule in CMN covers a silent screen, a reference to another item defines it, or
the text states the rule explicitly. Judge the question, not its wording.

{criteria}

Answer with is_real_problem, the kind and severity you would give (none when it is not a problem), your confidence
from 0 to 1 that your is_real_problem verdict is right, and the reason in one or two sentences.

<page id="OVR">
{ovr}
</page>

<page id="CMN">
{cmn}
</page>
"""

VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "is_real_problem": {"type": "boolean"},
        "kind": {"type": "string", "enum": ["missing", "contradiction", "ambiguous", "none"]},
        "severity": {"type": "string", "enum": ["critical", "major", "minor", "none"]},
        "confidence": {"type": "number", "description": "0 to 1: how likely your is_real_problem verdict is right"},
        "reason": {"type": "string"},
    },
    "required": ["is_real_problem", "kind", "severity", "confidence", "reason"],
    "additionalProperties": False,
}


# --- the pool ------------------------------------------------------------------------------------------------------

def _key(q: dict[str, Any]) -> str:
    return hashlib.sha1(json.dumps([sorted(q["location"]["item_ids"]), q["kind"], q["question"]],
                                   ensure_ascii=False).encode()).hexdigest()[:10]


def label_questions(questions: list[dict[str, Any]], answers: dict[str, Any]) -> list[dict[str, Any]]:
    """Each question with its label from the scorer: real, not_real, or None (unlabelled)."""
    sc = score(questions, answers)
    matched = {qid: pid for pid, qid in sc["matches"].items()}
    accepted = {a["question"]: a["accepted"] for a in sc["accepted_unplanned"]}
    fp = {f["question"]: f["non_issue"] for f in sc["false_positives"]}
    out = []
    for q in questions:
        if q["id"] in matched:
            label, ref = "real", matched[q["id"]]
        elif q["id"] in accepted:
            label, ref = "real", accepted[q["id"]]
        elif q["id"] in fp:
            label, ref = "not_real", fp[q["id"]]
        else:
            label, ref = None, None
        out.append({**q, "label": label, "ref": ref})
    return out


def build_pool(answers: dict[str, Any], runs: Path = RUNS) -> list[dict[str, Any]]:
    """Labelled questions from earlier runs, one per (items, kind, question), plus the decoys."""
    pool: dict[str, dict[str, Any]] = {}
    sources = sorted(runs.glob("*/question_list.json")) + sorted(runs.glob("*/report.json"))
    for path in sources:
        if path.parent.name.endswith("-dry"):
            continue  # a dry run's questions are canned, not a model's
        data = json.loads(path.read_text("utf-8"))
        qs = data.get("questions") or data.get("claims") or []
        for q in label_questions(qs, answers):
            if q["label"] is None:
                continue
            item = {k: q[k] for k in ("location", "kind", "severity", "issue", "question", "spec_quote")}
            item |= {"label": q["label"], "ref": q["ref"], "source": path.parent.name}
            pool.setdefault(_key(item), item)
    for d in DECOYS:
        item = {k: d[k] for k in ("location", "kind", "severity", "issue", "question", "spec_quote")}
        pool.setdefault(_key(item), item | {"label": "not_real", "ref": d["decoy"], "source": "decoy"})
    return [{"pid": f"V{i + 1:03d}", "key": k, **v} for i, (k, v) in enumerate(sorted(pool.items()))]


def stratified_sample(pool: list[dict[str, Any]], per_stratum: int) -> list[dict[str, Any]]:
    """Up to `per_stratum` items from each (label, kind) stratum, picked by hash so the pick is stable."""
    strata: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in pool:
        strata[(item["label"], item["kind"])].append(item)
    out = []
    for key in sorted(strata):
        items = sorted(strata[key], key=lambda x: x["key"])
        # one item per planted problem first, so one problem asked ten ways does not fill the stratum
        seen, firsts, rest = set(), [], []
        for it in items:
            (rest if it["ref"] in seen else firsts).append(it)
            seen.add(it["ref"])
        out += (firsts + rest)[:per_stratum]
    return out


# --- the requests --------------------------------------------------------------------------------------------------

def cited_pages(item: dict[str, Any], spec: Spec) -> list[str]:
    pages = {item["location"]["page"]} | {i[:5] for i in item["location"]["item_ids"] if i.startswith("SC-")}
    return [p for p in spec.page_ids if p in pages and p not in ("OVR", "CMN")]


def verify_params(item: dict[str, Any], spec: Spec, model: str = SONNET, max_tokens: int = 4000,
                  effort: str = "low") -> dict[str, Any]:
    system = VERIFY_PROMPT.format(criteria=CRITERIA, ovr=spec.pages["OVR"].text, cmn=spec.pages["CMN"].text)
    pages = "\n\n".join(f'<page id="{p}">\n{spec.pages[p].text}\n</page>' for p in cited_pages(item, spec))
    claim = {k: item[k] for k in ("location", "kind", "severity", "issue", "question", "spec_quote")}
    user = f"{pages}\n\n<question>\n{json.dumps(claim, ensure_ascii=False, indent=1)}\n</question>"
    return {"model": model, "max_tokens": max_tokens,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": user}], "thinking": {"type": "adaptive"},
            "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": VERDICT_SCHEMA}}}


def read_verdict(message: Any) -> tuple[dict[str, Any] | None, str | None]:
    if message.stop_reason == "max_tokens":
        return None, "max_tokens"
    if message.stop_reason == "refusal":
        return None, "refusal"
    text = "".join(b.text for b in message.content if b.type == "text")
    try:
        v = json.loads(text)
    except ValueError:
        return None, "invalid_json"
    if not isinstance(v, dict) or set(v) != set(VERDICT_SCHEMA["required"]):
        return None, "invalid_shape"
    return v, None


# --- A4: batch with resubmission -----------------------------------------------------------------------------------

def run_batch_with_resubmit(client: Any, params: dict[str, dict[str, Any]],
                            check: Callable[[Any], str | None],
                            fix: Callable[[str, dict[str, Any], str], dict[str, Any] | None],
                            log: Callable[[dict[str, Any]], None], max_rounds: int = 3, poll_s: float = 15.0,
                            timeout_s: float = 3600) -> dict[str, Any]:
    """Submit every request; then, round by round, resubmit only the custom_ids that failed, each changed by `fix`
    (None: give up on it). Returns the good messages, every billed message's usage, and the rounds."""
    good: dict[str, Any] = {}
    billed: list[tuple[str, Any]] = []
    rounds = []
    pending = dict(params)
    for n in range(1, max_rounds + 1):
        if not pending:
            break
        t0 = time.monotonic()
        batch = client.messages.batches.create(requests=[{"custom_id": c, "params": p} for c, p in pending.items()])
        log({"round": n, "batch_id": batch.id, "requests": len(pending)})
        while batch.processing_status != "ended":
            if time.monotonic() - t0 > timeout_s:
                client.messages.batches.cancel(batch.id)
                log({"round": n, "event": "cancelled after timeout"})
            time.sleep(poll_s)
            batch = client.messages.batches.retrieve(batch.id)
            log({"round": n, "status": batch.processing_status, "elapsed_s": round(time.monotonic() - t0, 1),
                 "counts": getattr(batch, "request_counts", None)})
        failed: dict[str, str] = {}
        for entry in client.messages.batches.results(batch.id):
            r = entry.result
            if r.type == "succeeded":
                billed.append((entry.custom_id, r.message))
                problem = check(r.message)
                if problem is None:
                    good[entry.custom_id] = r.message
                else:
                    failed[entry.custom_id] = problem
            else:  # errored, expired, canceled: not billed
                err = getattr(getattr(r, "error", None), "error", None) or getattr(r, "error", None)
                failed[entry.custom_id] = f"{r.type}: {getattr(err, 'type', '') or ''}".rstrip(": ")
        missing = set(pending) - set(good) - set(failed)
        for c in missing:
            failed[c] = "no_result"
        rounds.append({"round": n, "batch_id": batch.id, "submitted": len(pending), "succeeded": len(pending) - len(failed),
                       "failed": failed, "seconds": round(time.monotonic() - t0, 1)})
        log(rounds[-1])
        nxt = {}
        for c, why in failed.items():
            p = fix(c, pending[c], why)
            if p is not None:
                nxt[c] = p
        pending = nxt
    return {"good": good, "billed": billed, "rounds": rounds,
            "gave_up": sorted(set(params) - set(good))}


def default_fix(max_tokens: int) -> Callable[[str, dict[str, Any], str], dict[str, Any] | None]:
    def fix(_cid: str, p: dict[str, Any], why: str) -> dict[str, Any] | None:
        if why.startswith("refusal"):
            return None  # the same request would be refused again
        if why == "max_tokens" or why.startswith("errored"):
            return {**p, "max_tokens": max(p["max_tokens"] * 2, max_tokens)}
        return dict(p)  # expired, canceled, invalid output: the same request again
    return fix


# --- calibration ---------------------------------------------------------------------------------------------------

BUCKETS = [(0.0, 0.6), (0.6, 0.8), (0.8, 0.9), (0.9, 1.01)]
THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]


def calibrate(rows: list[dict[str, Any]], target: float = 0.95, min_segment: int = 3) -> dict[str, Any]:
    """rows: {label, kind, verdict}. A verdict is right when is_real_problem matches the label."""
    for r in rows:
        r["right"] = r["verdict"]["is_real_problem"] == (r["label"] == "real")
        r["conf"] = float(r["verdict"]["confidence"])

    def acc(rs: list[dict[str, Any]]) -> float | None:
        return round(sum(r["right"] for r in rs) / len(rs), 3) if rs else None

    buckets = [{"range": f"{lo:.1f}-{min(hi, 1.0):.1f}", "n": len(b), "accuracy": acc(b)}
               for lo, hi in BUCKETS for b in [[r for r in rows if lo <= r["conf"] < hi]]]
    segments = {}
    for key, fn in (("kind", lambda r: r["kind"]), ("label", lambda r: r["label"])):
        groups: dict[str, list] = defaultdict(list)
        for r in rows:
            groups[fn(r)].append(r)
        segments[key] = {g: {"n": len(rs), "accuracy": acc(rs)} for g, rs in sorted(groups.items())}
    table = []
    chosen = None
    for t in THRESHOLDS:
        auto = [r for r in rows if r["conf"] >= t]
        seg = defaultdict(list)
        for r in auto:
            seg[r["kind"]].append(r)
        worst = min((acc(v) for v in seg.values() if len(v) >= min_segment), default=None)
        row = {"threshold": t, "automated": len(auto), "share": round(len(auto) / len(rows), 3) if rows else 0,
               "accuracy": acc(auto), "worst_kind_accuracy": worst}
        table.append(row)
        if chosen is None and auto and row["accuracy"] >= target and (worst is None or worst >= target):
            chosen = row
    confusion = Counter((r["label"], "real" if r["verdict"]["is_real_problem"] else "not_real") for r in rows)
    kind_agree = [r for r in rows if r["label"] == "real"]
    return {"n": len(rows), "accuracy": acc(rows), "buckets": buckets, "segments": segments,
            "thresholds": table, "chosen": chosen, "target": target,
            "confusion": {f"{a}->{b}": n for (a, b), n in sorted(confusion.items())},
            "kind_agreement_on_real": acc([{"right": r["verdict"]["kind"] == r["kind"]} for r in kind_agree]),
            "mean_confidence_right": round(sum(r["conf"] for r in rows if r["right"]) / max(1, sum(r["right"] for r in rows)), 3),
            "mean_confidence_wrong": round(sum(r["conf"] for r in rows if not r["right"]) /
                                           max(1, sum(not r["right"] for r in rows)), 3),
            "wrong": [{k: r[k] for k in ("pid", "label", "ref", "kind", "conf")} | {"reason": r["verdict"]["reason"]}
                      for r in rows if not r["right"]]}


def run_verify(client: Any, spec: Spec, answers: dict[str, Any], run_dir: Path, per_stratum: int = 6,
               model: str = SONNET, inject_fault: bool = False, poll_s: float = 15.0,
               runs: Path = RUNS) -> dict[str, Any]:
    pool = build_pool(answers, runs)
    sample = stratified_sample(pool, per_stratum)
    (run_dir / "pool.json").write_text(json.dumps(pool, ensure_ascii=False, indent=1), encoding="utf-8")
    params = {it["pid"]: verify_params(it, spec, model) for it in sample}
    if inject_fault and params:
        first = sorted(params)[0]
        params[first] = {**params[first], "max_tokens": 16}  # cannot hold an answer: must come back as a failure
    log_path = run_dir / "batch.jsonl"

    def log(row: dict[str, Any]) -> None:
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")

    out = run_batch_with_resubmit(client, params, lambda m: read_verdict(m)[1], default_fix(4000), log,
                                  poll_s=poll_s)
    usd = sum(cost_usd(model, usage_dict(m.usage)) for _, m in out["billed"]) * 0.5  # batch: half price
    by_pid = {it["pid"]: it for it in sample}
    rows = []
    for pid, msg in sorted(out["good"].items()):
        v, _ = read_verdict(msg)
        rows.append({**by_pid[pid], "verdict": v})
    (run_dir / "verdicts.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    strata = Counter(f"{it['label']}/{it['kind']}" for it in sample)
    return {"pool": len(pool), "pool_labels": dict(Counter(p["label"] for p in pool)), "sample": len(sample),
            "strata": dict(sorted(strata.items())), "rounds": out["rounds"], "gave_up": out["gave_up"],
            "billed_messages": len(out["billed"]), "cost_usd": round(usd, 6), "calibration": calibrate(rows)}

