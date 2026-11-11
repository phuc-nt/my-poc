"""Score a question list against eval/answers.json, deterministically. No model is asked."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ANSWERS = Path(__file__).resolve().parents[2] / "eval" / "answers.json"


def score(questions: list[dict[str, Any]], answers: dict[str, Any]) -> dict[str, Any]:
    """Match questions to planted problems one to one (the prompt asks for one problem per question).

    A pair is a candidate when the question cites an anchor of the problem. Pairs are taken greedily, best first:
    more shared anchors, then the right kind, then question order. Deterministic, no model involved.
    """
    problems = answers["problems"]
    pairs = []
    for p in problems:
        anchors = set(p["anchors"])
        for order, q in enumerate(questions):
            shared = len(anchors & set(q["location"]["item_ids"]))
            if shared:
                pairs.append((-shared, q["kind"] not in p["kinds"], order, p["id"], q["id"]))
    pairs.sort()
    match: dict[str, dict[str, Any]] = {}
    used: set[str] = set()
    by_id = {q["id"]: q for q in questions}
    for _, _, _, pid, qid in pairs:
        if pid not in match and qid not in used:
            match[pid] = by_id[qid]
            used.add(qid)

    found_kind = [p["id"] for p in problems if p["id"] in match and match[p["id"]]["kind"] in p["kinds"]]
    severity_agree = [p["id"] for p in problems if p["id"] in match and match[p["id"]]["severity"] == p["severity"]]

    unmatched = [q for q in questions if q["id"] not in used]
    accepted = [
        {"accepted": x["id"], "question": q["id"]}
        for x in answers.get("accepted_unplanned", [])
        for q in unmatched
        if set(x["anchors"]) & set(q["location"]["item_ids"])
    ]
    accepted_ids = {x["question"] for x in accepted}
    unmatched = [q for q in unmatched if q["id"] not in accepted_ids]
    false_positives = []
    for n in answers["non_issues"]:
        for q in unmatched:
            if set(n["anchors"]) & set(q["location"]["item_ids"]):
                false_positives.append({"non_issue": n["id"], "question": q["id"]})

    fp_ids = {f["question"] for f in false_positives}
    total = len(problems)
    return {
        "planted": total,
        "questions": len(questions),
        "found": len(match),
        "recall": round(len(match) / total, 3),
        "found_with_kind": len(found_kind),
        "severity_agree": len(severity_agree),
        "matches": {pid: match[pid]["id"] for pid in sorted(match)},
        "missed": [p["id"] for p in problems if p["id"] not in match],
        "accepted_unplanned": accepted,
        "false_positives": false_positives,
        "unplanned_for_review": [q["id"] for q in unmatched if q["id"] not in fp_ids],
    }


def score_file(path: Path, answers_path: Path = ANSWERS) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    answers = json.loads(answers_path.read_text(encoding="utf-8"))
    return score(data["questions"], answers)
