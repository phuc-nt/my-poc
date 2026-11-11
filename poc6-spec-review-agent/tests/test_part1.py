import json

import anthropic
import pytest

from spec_review.fake_client import VALID, FakeClient
from spec_review.loop import RunConfig, run
from spec_review.prompts import build_tools
from spec_review.schema import question_list_schema, validate_question_list
from spec_review.score import ANSWERS, score
from spec_review.spec import load_spec

SPEC = load_spec()
ANS = json.loads(ANSWERS.read_text(encoding="utf-8"))


def test_spec_has_14_pages_and_one_dangling_reference():
    assert len(SPEC.pages) == 14
    assert SPEC.undefined_references() == {"MAIL-02"}


def test_every_answer_anchor_exists_in_the_spec():
    anchors = {a for p in ANS["problems"] + ANS["non_issues"] for a in p["anchors"]}
    assert anchors <= SPEC.all_ids


def test_schema_fits_strict_mode_limits():
    schema = question_list_schema(SPEC.page_ids)
    text = json.dumps(schema)
    for banned in ("minLength", "maxLength", "minimum", "maximum", "maxItems"):
        assert banned not in text
    # the SDK's own transform must leave a strict-compatible schema unchanged in meaning (no request is sent)
    assert anthropic.transform_schema(schema)["required"] == ["questions"]
    assert all(t.get("strict") for t in build_tools(SPEC.page_ids))


def test_validation_names_each_error():
    bad = {"questions": [dict(VALID[0], location={"page": "SC-01", "item_ids": ["SC-01-R09"], "section": None}),
                         dict(VALID[1], question="English only")]}
    parsed, errors = validate_question_list(bad, SPEC)
    assert parsed is None
    assert any("Japanese" in e for e in errors)
    bad2 = {"questions": [dict(VALID[0], location={"page": "SC-01", "item_ids": ["SC-01-R09"], "section": None})]}
    parsed, errors = validate_question_list(bad2, SPEC)
    assert errors == ["Q001.location.item_ids: 'SC-01-R09' does not appear in the spec"]


def test_nullable_fields_accept_null():
    parsed, errors = validate_question_list({"questions": VALID}, SPEC)
    assert errors == [] and parsed.questions[2].spec_quote is None


def test_scorer_counts_hits_kinds_and_false_positives():
    s = score(VALID, ANS)
    assert s["found"] == 3 and s["found_with_kind"] == 3
    assert {"P01", "P07", "P16"}.isdisjoint(s["missed"])
    assert s["false_positives"] == [{"non_issue": "N03", "question": "Q004"}]


def test_dry_run_exercises_the_loop(tmp_path):
    client = FakeClient(SPEC.page_ids)
    r = run(client, SPEC, RunConfig(), log=tmp_path / "steps.jsonl")
    assert r.outcome == "done" and r.steps == 5 and r.submits == 2
    reqs = client.messages.requests
    # the second request carries the unknown page as is_error, the fourth carries the validation errors
    results = [b for b in reqs[2]["messages"][-1]["content"] if b.get("is_error")]
    assert len(results) == 1 and "SC-13" in results[0]["content"]
    assert reqs[3]["messages"][-1]["content"][0]["is_error"] is True
    assert reqs[0]["thinking"] == {"type": "adaptive"} and "tool_choice" not in reqs[0]
    assert r.cost_usd > 0


def test_step_limit_stops_the_loop(tmp_path):
    client = FakeClient(SPEC.page_ids)
    r = run(client, SPEC, RunConfig(max_steps=2))
    assert r.outcome == "step_limit" and r.steps == 2


@pytest.mark.parametrize("stop,outcome", [("max_tokens", "max_tokens"), ("refusal", "refusal"),
                                          ("model_context_window_exceeded", "context_window_exceeded")])
def test_other_stop_reasons_end_the_run(stop, outcome):
    from spec_review.fake_client import _msg

    client = FakeClient(SPEC.page_ids, script=[_msg(stop, [])])
    assert run(client, SPEC, RunConfig()).outcome == outcome


def test_end_turn_without_submission_is_nudged_once():
    from types import SimpleNamespace as NS

    from spec_review.fake_client import _msg

    text = [NS(type="text", text="終わりました")]
    client = FakeClient(SPEC.page_ids, script=[_msg("end_turn", text), _msg("end_turn", text)])
    r = run(client, SPEC, RunConfig())
    assert r.outcome == "no_submission" and r.steps == 2
