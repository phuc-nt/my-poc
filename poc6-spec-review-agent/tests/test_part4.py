"""Offline tests for part 4: request shapes per mode, the quote check, the retry on each kind of failure, batches."""

import json
from contextlib import contextmanager
from types import SimpleNamespace

from spec_review.extract import (
    NUDGE,
    MODES,
    Meter,
    P4Config,
    build_request,
    merged_questions,
    run_case,
    run_test_set,
    summarise,
)
from spec_review.score import ANSWERS
from spec_review.schema import quote_in_spec, validate_question_list
from spec_review.spec import load_spec

SPEC = load_spec()
QUOTE = "ログイン後、60分間操作がない場合"


def question(**over):
    q = {"id": "Q001", "location": {"page": "SC-01", "item_ids": ["SC-01-R04", "CMN-R01"], "section": None},
         "kind": "contradiction", "severity": "major", "issue": "自動ログアウトの時間が共通仕様と異なる。",
         "question": "自動ログアウトまでの時間は30分と60分のどちらでしょうか。", "spec_quote": QUOTE,
         "proposed_answer": None}
    q.update(over)
    return q


def tool_reply(data, stop="tool_use", thinking=False):
    blocks = [SimpleNamespace(type="thinking", thinking="...")] if thinking else []
    blocks.append(SimpleNamespace(type="tool_use", name="submit_question_list", id="tu1", input=data))
    return SimpleNamespace(content=blocks, stop_reason=stop, usage=_usage())


def text_reply(text, stop="end_turn"):
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], stop_reason=stop, usage=_usage())


def _usage():
    return SimpleNamespace(input_tokens=1000, output_tokens=500, cache_creation_input_tokens=0, cache_read_input_tokens=0)


class FakeClient:
    def __init__(self, replies, batch_replies=None):
        self.replies, self.requests = list(replies), []
        self.messages = self
        self.batches = FakeBatches(batch_replies or {})

    @contextmanager
    def stream(self, **request):
        self.requests.append(json.loads(json.dumps(request, default=lambda o: vars(o))))
        reply = self.replies.pop(0)
        yield SimpleNamespace(get_final_message=lambda: reply)


class FakeBatches:
    def __init__(self, replies):
        self.replies, self.created = replies, None

    def create(self, requests):
        self.created = requests
        return SimpleNamespace(id="b1", processing_status="in_progress")

    def retrieve(self, _id):
        return SimpleNamespace(id="b1", processing_status="ended")

    def results(self, _id):
        return [SimpleNamespace(custom_id=k, result=SimpleNamespace(type="succeeded", message=v))
                for k, v in self.replies.items()]


def test_request_shape_per_mode():
    cfg = P4Config()
    forced = build_request(MODES["haiku-forced"], SPEC, "SC-01", cfg)
    assert forced["tool_choice"] == {"type": "tool", "name": "submit_question_list"} and forced["tools"][0]["strict"]
    assert forced["system"][-1]["cache_control"] == {"type": "ephemeral"} and "SC-01-R04" in forced["messages"][0]["content"][0]["text"]
    assert "strict" not in build_request(MODES["haiku-forced-loose"], SPEC, "SC-01", cfg)["tools"][0]
    auto = build_request(MODES["sonnet-strict"], SPEC, "SC-01", cfg)
    assert auto["tool_choice"] == {"type": "auto"} and auto["model"] == "claude-sonnet-5-5"
    fmt = build_request(MODES["sonnet-format"], SPEC, "SC-01", cfg)
    assert "tools" not in fmt and fmt["output_config"]["format"]["type"] == "json_schema"
    assert fmt["output_config"]["format"]["schema"]["properties"]["questions"]["minItems"] == 0
    assert fmt["system"] == auto["system"]  # one cached prefix per model, whatever the mode
    assert "EX-03-F04" in build_request(MODES["sonnet-format"], SPEC, "SC-01", P4Config(few_shot=True))["system"][0]["text"]


def test_quote_check_and_empty_list():
    assert quote_in_spec(QUOTE, SPEC) and quote_in_spec(QUOTE.replace("60", "６０"), SPEC)  # width is normalised
    assert not quote_in_spec(QUOTE + "。", SPEC)  # an added full stop is not the spec's wording
    assert validate_question_list({"questions": [question()]}, SPEC, check_quotes=True)[0] is not None
    _, errors = validate_question_list({"questions": [question(spec_quote="操作がなければログアウトする")]}, SPEC, check_quotes=True)
    assert errors and "spec_quote" in errors[0]
    assert validate_question_list({"questions": []}, SPEC, allow_empty=True)[0] is not None
    assert validate_question_list({"questions": []}, SPEC)[0] is None


def test_forced_tool_retry_sends_the_errors_as_a_tool_error():
    bad = {"questions": [question(location={"page": "SC-01", "item_ids": ["SC-01-R99"], "section": None})]}
    client = FakeClient([tool_reply(bad), tool_reply({"questions": [question()]})])
    r = run_case(client, SPEC, "SC-01", P4Config(mode="haiku-forced"), Meter(10))
    assert r.valid and [a.problem for a in r.attempts] == ["unknown_id", None]
    sent = client.requests[1]["messages"][-1]["content"][0]
    assert sent["type"] == "tool_result" and sent["is_error"] and "SC-01-R99" in sent["content"]
    assert client.requests[1]["tool_choice"]["type"] == "tool"


def test_auto_tool_without_a_call_is_nudged():
    client = FakeClient([text_reply("レビューしました。"), tool_reply({"questions": []}, thinking=True)])
    r = run_case(client, SPEC, "SC-06", P4Config(mode="sonnet-strict"), Meter(10))
    assert r.valid and r.questions == [] and [a.problem for a in r.attempts] == ["no_call", None]
    assert client.requests[1]["messages"][-1]["content"][0]["text"] == NUDGE
    assert r.attempts[1].thinking_blocks == 1


def test_json_form_retries_until_valid_or_gives_up():
    reworded = json.dumps({"questions": [question(spec_quote=QUOTE + "。")]}, ensure_ascii=False)
    good = json.dumps({"questions": [question()]}, ensure_ascii=False)
    client = FakeClient([text_reply("{not json"), text_reply(reworded), text_reply(good)])
    r = run_case(client, SPEC, "SC-01", P4Config(mode="sonnet-format"), Meter(10))
    assert r.valid and [a.problem for a in r.attempts][:2] == ["invalid_json: Expecting property name enclosed in "
                                                              "double quotes: line 1 column 2 (char 1)", "quote_not_in_spec"]
    assert "spec_quote" in client.requests[2]["messages"][-1]["content"][0]["text"]
    give_up = run_case(FakeClient([text_reply(reworded)] * 3), SPEC, "SC-01", P4Config(mode="sonnet-format"), Meter(10))
    assert not give_up.valid and give_up.outcome == "invalid_after_retries" and len(give_up.attempts) == 3


def test_max_tokens_is_not_retried():
    r = run_case(FakeClient([text_reply("{", stop="max_tokens")]), SPEC, "SC-01", P4Config(), Meter(10))
    assert r.outcome == "max_tokens" and len(r.attempts) == 1


def test_batch_first_attempts_at_half_price_then_synchronous_retry(tmp_path):
    good = text_reply(json.dumps({"questions": [question()]}, ensure_ascii=False))
    bad = text_reply(json.dumps({"questions": [question(spec_quote="ない言葉")]}, ensure_ascii=False))
    client = FakeClient([good], batch_replies={"SC-01": good, "SC-02": bad})
    cfg = P4Config(mode="sonnet-format", batch=True, screens=["SC-01", "SC-02"], batch_poll_s=0)
    results, _ = run_test_set(client, SPEC, cfg, tmp_path / "cases.jsonl")
    assert [r.valid for r in results] == [True, True] and len(client.batches.created) == 2
    assert results[0].attempts[0].batch and results[0].attempts[0].cost_usd == 0.0035  # (2000 + 5000) / 1e6 / 2
    assert [a.batch for a in results[1].attempts] == [True, False] and len(client.requests) == 1


def test_budget_stop_and_summary(tmp_path):
    good = text_reply(json.dumps({"questions": [question()]}, ensure_ascii=False))
    cfg = P4Config(mode="sonnet-format", screens=["SC-01", "SC-02"], budget_left_usd=0.001)
    results, seconds = run_test_set(FakeClient([good, good]), SPEC, cfg, tmp_path / "cases.jsonl")
    assert results[0].valid and results[1].outcome.startswith("budget")
    merged = merged_questions(results)
    assert [q["id"] for q in merged] == ["Q001"] and merged[0]["case"] == "SC-01"
    s = summarise(results, seconds, json.loads(ANSWERS.read_text("utf-8")), cfg)
    assert s["valid_first"] == 1 and s["valid_final"] == 1 and s["score"]["found"] == 1


def test_merged_list_over_60_still_exports(tmp_path):
    from spec_review.cli import write_p4_xlsx

    merged = [question(id=f"Q{i:03d}") | {"case": "SC-01"} for i in range(1, 62)]  # 12 valid cases can add up past 60
    (tmp_path / "question_list.json").write_text(json.dumps({"questions": merged}, ensure_ascii=False), encoding="utf-8")
    assert write_p4_xlsx(tmp_path, SPEC) and (tmp_path / "質問表.xlsx").exists()
