"""Offline tests for part 7 (A5): the imported review policy, the re-review command and the forked verify skill, the
CI template, and the code that checks a re-review and a verification. Nothing starts Claude Code."""

import json
import re
from pathlib import Path

from spec_review import ci_review as ci
from spec_review import headless as h
from spec_review.score import ANSWERS
from spec_review.spec import load_spec

ROOT = Path(__file__).resolve().parents[1]
SPEC = load_spec()
ANS = json.loads(ANSWERS.read_text("utf-8"))


def frontmatter(path: Path) -> dict:
    """The flat `key: value` frontmatter of a command or skill file."""
    head = path.read_text("utf-8").split("---\n")[1]
    out = {}
    for line in head.splitlines():
        k, v = line.split(":", 1)
        v = v.strip()
        out[k] = {"true": True, "false": False}.get(v, v)
    return out


def q(qid, items, kind="contradiction", page="SC-05"):
    return {"id": qid, "location": {"page": page, "item_ids": items, "section": None}, "kind": kind,
            "severity": "major", "issue": "問題がある。", "question": "ご教示ください。", "spec_quote": None,
            "proposed_answer": None}


def test_policy_import_command_and_skill():
    policy = (ROOT / "docs" / "review-policy.md").read_text("utf-8")
    assert "Rule tag: P6-IMPORT" in policy and "P6-IMPORT" in h.EXPECTED_TAGS
    cmd = frontmatter(ROOT / ".claude" / "commands" / "re-review-spec.md")
    body = (ROOT / ".claude" / "commands" / "re-review-spec.md").read_text("utf-8")
    assert cmd["argument-hint"] == "<screen ID> <prior findings file>" and "$0" in body and "$1" in body
    assert "$ARGUMENTS" not in body  # positional only: the file path must not end up in the page_id
    skill = frontmatter(ROOT / ".claude" / "skills" / "verify-findings" / "SKILL.md")
    assert skill["context"] == "fork" and skill["agent"] == "general-purpose" and skill["background"] is False
    assert "disable-model-invocation" not in skill and skill["argument-hint"] == "<findings file>"
    assert "mcp__spec__search_spec" in skill["allowed-tools"] and "Skill" in ci.VERIFY_TOOLS
    assert "verify-findings skill on runs/x.json" in ci.VERIFY_PROMPT.format(file="runs/x.json")
    assert "proposed_answer" in (ROOT / ".claude" / "skills" / "verify-findings" / "SKILL.md").read_text("utf-8")


def test_ci_template_is_inactive():
    text = (ROOT / "ci" / "spec-review.yml").read_text("utf-8")
    assert not (ROOT.parent / ".github" / "workflows" / "spec-review.yml").exists()
    assert "\t" not in text and "uv run spec-review ci $args" in text and "--prior prior/$s.json" in text
    assert re.search(r"^permissions:\n  contents: read\n  pull-requests: write$", text, re.M)
    assert "secrets.ANTHROPIC_API_KEY" in text and "24 hours" in text


def test_same_finding_and_schemas():
    assert ci.same_finding(q("Q001", ["SC-05-R01", "SC-08-R02"]), q("Q009", ["SC-05-R01"]))
    assert not ci.same_finding(q("Q001", ["SC-05-R01"]), q("Q009", ["SC-05-R01"], kind="missing"))
    s = ci.re_review_schema(SPEC)
    assert set(s["required"]) == set(s["properties"]) == {"rule_tags", "questions", "still_open", "addressed"}
    v = ci.verify_schema()["properties"]["verdicts"]["items"]
    assert v["additionalProperties"] is False and set(v["required"]) == set(v["properties"])


def result(answer, sid="s1"):
    raw = {"type": "result", "is_error": False, "session_id": sid, "structured_output": answer, "total_cost_usd": 0.01}
    return h.HeadlessResult(returncode=0, raw=raw, answer=answer)


def test_check_re_review_counts_duplicates_and_placement():
    prior = [q("Q001", ["SC-05-R01", "SC-08-R02"]), q("Q002", ["SC-05-F03"], kind="missing")]
    tags = sorted(h.EXPECTED_TAGS)
    good = {"rule_tags": tags, "questions": [q("Q001", ["SC-05-R02"], kind="ambiguous")],
            "still_open": ["Q001", "Q002"], "addressed": []}
    c = ci.check_re_review(result(good), SPEC, ANS, "SC-05", prior)
    assert c["passed"] == c["of"], c["checks"]
    assert c["duplicates"] == [] and c["found_after"] >= c["found_before"]

    dup = good | {"questions": [q("Q001", ["SC-08-R02", "SC-05-R01"])], "still_open": ["Q001"], "addressed": ["Q002"]}
    c = ci.check_re_review(result(dup), SPEC, ANS, "SC-05", prior)
    failing = {k for k, ok in c["checks"].items() if not ok}
    assert failing == {"no_duplicates", "nothing_addressed_on_unchanged_spec"}
    assert c["duplicates"] == [{"new": "Q001", "prior": "Q001"}]


def test_check_verify_and_comment():
    qs = [q("Q001", ["SC-05-R01", "SC-08-R02"]), q("Q002", ["SC-05-F03"], kind="missing")]
    lab = ci.labels(qs, ANS)
    assert lab["Q002"] == "not_real" and lab["Q001"] == "real"
    ans = {"rule_tags": ["P6-PROJECT", "P6-IMPORT"],
           "verdicts": [{"id": "Q001", "is_real_problem": True, "confidence": 0.9, "reason": "SC-08-R02 と矛盾。"},
                        {"id": "Q002", "is_real_problem": False, "confidence": 0.8, "reason": "CMN-F01 で定義済み。"}]}
    c = ci.check_verify(result(ans, "s2"), qs, ANS, {"P6-PROJECT", "P6-IMPORT"})
    assert c["passed"] == c["of"] and c["agree_with_scorer"] == 2 and c["rejected"] == ["Q002"]
    missing = ans | {"verdicts": ans["verdicts"][:1]}
    assert not ci.check_verify(result(missing), qs, ANS, set())["checks"]["one_verdict_per_finding"]
    text = ci.pr_comment("SC-05", {"questions": qs}, c, False)
    assert "| Q002 | major | missing | rejected (0.80) |" in text and "for a person to read: Q002" in text
    assert re.search(r"\| Q001 .* kept \(0\.90\)", text)
