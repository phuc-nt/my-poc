"""Offline tests for part 7 (A1): structured tool errors, the spec server's error categories and empty results, and
the question desk's tools, gate, policy hook, handoff checks and result check. No model is called."""

import asyncio
import json

from mcp import Client

from spec_review import intake as it
from spec_review.mcp_server import build_server
from spec_review.spec import load_spec
from spec_review.tool_errors import error_payload, parse_error, sdk_error

SPEC = load_spec()


def run(coro):
    return asyncio.run(coro)


def test_error_payload_shape():
    e = error_payload("transient", "timed out")
    assert e == {"errorCategory": "transient", "isRetryable": True, "message": "timed out"}
    assert error_payload("validation", "bad", field="x")["isRetryable"] is False
    assert error_payload("business", "rule", retryable=True)["isRetryable"] is True
    r = sdk_error("permission", "no", page_id="SC-01")
    assert r["is_error"] and parse_error(r["content"][0]["text"])["page_id"] == "SC-01"
    assert parse_error("plain text") is None and parse_error('{"count": 0}') is None
    try:
        error_payload("fatal", "x")
        raise AssertionError("an unknown category must be refused")
    except ValueError:
        pass


async def _calls(server, calls):
    async with Client(server) as c:
        return [await c.call_tool(name, args) for name, args in calls]


def test_spec_server_error_categories():
    def broken(pid):
        raise TimeoutError("store down")

    unknown, outside, inside = run(_calls(build_server(SPEC, scope={"OVR", "CMN", "SC-01"}), [
        ("read_page", {"page_id": "SC-13"}), ("read_page", {"page_id": "SC-02"}), ("read_page", {"page_id": "sc-01"})]))
    assert unknown.is_error and unknown.structured_content["errorCategory"] == "validation"
    assert unknown.structured_content["valid_page_ids"] == ["OVR", "CMN", "SC-01"]
    assert outside.is_error and outside.structured_content == {
        **outside.structured_content, "errorCategory": "permission", "isRetryable": False, "page_id": "SC-02"}
    assert not inside.is_error and inside.content[0].text == SPEC.pages["SC-01"].text
    (down,) = run(_calls(build_server(SPEC, reader=broken), [("read_page", {"page_id": "SC-01"})]))
    assert down.is_error and down.structured_content["isRetryable"] is True
    assert json.loads(down.content[0].text)["errorCategory"] == "transient"  # the text carries the same payload


def test_search_empty_is_a_result_not_an_error():
    hit, empty, bad, scoped = run(_calls(build_server(SPEC), [
        ("search_spec", {"pattern": "自動ログアウト"}), ("search_spec", {"pattern": "存在しない語句XYZ"}),
        ("search_spec", {"pattern": "(unclosed"})])) + run(_calls(build_server(SPEC, scope={"SC-02"}), [
        ("search_spec", {"pattern": "自動ログアウト"})]))
    assert not hit.is_error and hit.structured_content["count"] > 0
    assert not empty.is_error and empty.structured_content["count"] == 0 and empty.structured_content["matches"] == []
    assert bad.is_error and bad.structured_content["errorCategory"] == "validation"
    assert not scoped.is_error and scoped.structured_content["pages_searched"] == 1
    assert all(m.startswith("SC-02:") for m in scoped.structured_content["matches"])


# --- the question desk ---------------------------------------------------------------------------------------------

def desk(inject=True):
    qs, reply, expected = it.load_data()
    state = it.DeskState(questions=qs, reply=reply, inject_transient=inject)
    tools = {t.name: t for t in it.build_tools(state)}
    gate = it.build_hooks(state)["PreToolUse"][0]

    async def act(name, args):
        if __import__("re").match(gate.matcher, it.T[name]):
            out = await gate.hooks[0]({"tool_name": it.T[name], "tool_input": args}, None, None)
            if out:
                return {"denied": json.loads(out["hookSpecificOutput"]["permissionDecisionReason"])}
        r = await tools[name].handler(args)
        text = r["content"][0]["text"]
        return parse_error(text) if r.get("is_error") else {"ok": json.loads(text) if text[:1] in "{[" else text}

    return state, expected, lambda name, **args: run(act(name, args))


def handoff(qid, reason, quote, items, previous=None):
    return dict(question_id=qid, reason_code=reason, reason_detail="承認の要否を判断する必要があるため。",
                customer_answer_quote=quote, spec_item_ids=items, previous_answer=previous,
                recommended_action="仕様変更として影響範囲を確認し、承認者が判断してください。")


Q1 = "自動ログアウトは共通仕様に合わせ、30分に統一してください。"
Q2 = "貸出期間の上限は1か月に変更したいと考えています。"
Q3 = "一覧の表示件数は1ページ50件でお願いします。"
Q4 = "社内で確認中のため、来週中に改めて回答いたします。"
Q5 = "CSVの文字コードはUTF-8（BOM付き）、改行コードはCRLFとしてください。"


def test_gate_policy_and_errors():
    state, _, act = desk()
    assert act("list_questions", status="answered")["ok"]["count"] == 1
    assert act("list_questions", status="open")["ok"]["count"] == 5
    d = act("record_answer", question_id="Q001", answer_quote=Q1, answer_summary="30分に統一する。")
    assert d["denied"]["errorCategory"] == "business" and "get_question" in d["denied"]["message"]
    assert act("get_question", question_id="Q001")["ok"]["severity"] == "major"
    bad = act("record_answer", question_id="Q001", answer_quote="30分に統一", answer_summary="x")  # in the reply: ok
    assert bad["errorCategory"] == "transient" and bad["isRetryable"]  # the injected failure, after validation
    assert act("record_answer", question_id="Q001", answer_quote=Q1, answer_summary="30分に統一する。")["ok"]
    assert act("record_answer", question_id="Q001", answer_quote="六十分", answer_summary="x")["errorCategory"] == "business"

    act("get_question", question_id="q-002")  # IDs are normalised
    pol = act("record_answer", question_id="Q002", answer_quote=Q2, answer_summary="1か月に変更する。")
    assert "policy_critical" in pol["denied"]["message"] and "Q002" not in state.recorded
    unknown = act("get_question", question_id="Q007")
    assert unknown["errorCategory"] == "validation" and not unknown["isRetryable"] and "Q006" in unknown["valid_ids"]

    act("get_question", question_id="Q003")
    closed = act("record_answer", question_id="Q003", answer_quote=Q3, answer_summary="50件とする。")
    assert closed["errorCategory"] == "business" and closed["previous_answer"] == "1ページ20件とする。"
    act("get_question", question_id="Q005")
    assert act("record_answer", question_id="Q005", answer_quote="Shift_JIS", answer_summary="x")["errorCategory"] == "validation"


def test_handoff_validation():
    state, _, act = desk()
    act("get_question", question_id="Q003")
    no_prev = act("escalate", **handoff("Q003", "conflicting_answer", Q3, ["SC-03-R03"]))
    assert no_prev["errorCategory"] == "validation" and "previous_answer" in no_prev["message"]
    wrong = act("escalate", **handoff("Q003", "conflicting_answer", "50件にしてください", ["SC-04-R01"], "20件"))
    assert "customer_answer_quote" in wrong["message"] and "spec_item_ids" in wrong["message"]
    ok = act("escalate", **handoff("Q003", "conflicting_answer", Q3, ["SC-03-R03"], "1ページ20件とする。"))
    assert ok["ok"]["ticket"] == "ESC-001" and state.questions["Q003"]["status"] == "escalated"


def good_run(act):
    for q in ("Q001", "Q002", "Q003", "Q004", "Q005"):
        act("get_question", question_id=q)
    act("record_answer", question_id="Q001", answer_quote=Q1, answer_summary="30分に統一する。")  # transient
    act("record_answer", question_id="Q001", answer_quote=Q1, answer_summary="30分に統一する。")
    act("record_answer", question_id="Q002", answer_quote=Q2, answer_summary="1か月")  # policy block
    act("escalate", **handoff("Q002", "policy_critical", Q2, ["SC-05-R01", "SC-08-R02"]))
    act("record_answer", question_id="Q003", answer_quote=Q3, answer_summary="50件")  # business error
    act("escalate", **handoff("Q003", "conflicting_answer", Q3, ["SC-03-R03"], "1ページ20件とする。"))
    act("mark_follow_up", question_id="Q004", answer_quote=Q4, reason="顧客側で確認中。")
    act("record_answer", question_id="Q005", answer_quote=Q5, answer_summary="UTF-8（BOM付き）、CRLF。")
    act("get_question", question_id="Q007")


def test_report_and_check_pass_on_a_good_run():
    state, expected, act = desk()
    good_run(act)
    wrong = act("submit_report", recorded=["Q001"], escalated=["Q002", "Q003"], follow_up=["Q004"],
                unknown_ids=["Q007"], unanswered=["Q006"], summary="x")
    assert wrong["errorCategory"] == "validation" and "recorded" in wrong["message"]
    assert act("submit_report", recorded=["Q005", "Q001"], escalated=["Q002", "Q003"], follow_up=["Q004"],
               unknown_ids=["Q007"], unanswered=["Q006"], summary="処理完了。")["ok"]
    c = it.check(state, expected)
    assert c["passed"] == c["of"], c["checks"]
    assert [b["rule"] for b in c["blocks"]] == ["policy_critical"] and c["invalid_handoffs"] == 0


def test_check_catches_repeats_and_missing_retry():
    state, expected, act = desk()
    good_run(act)
    act("get_question", question_id="Q007")  # asked again after a validation error
    act("record_answer", question_id="Q002", answer_quote=Q2, answer_summary="1か月")  # asked again after the policy
    c = it.check(state, expected)
    assert not c["checks"]["no_retry_of_non_retryable"] and len(c["repeats"]) == 2
    assert not c["checks"]["report_accepted"]

    state2, expected2, act2 = desk()
    act2("get_question", question_id="Q001")
    act2("record_answer", question_id="Q001", answer_quote=Q1, answer_summary="30分")  # transient, never retried
    c2 = it.check(state2, expected2)
    assert not c2["checks"]["transient_retried"] and not c2["checks"]["recorded"]


def test_options_offer_only_the_desk_tools():
    state, _, _ = desk()
    o = it.build_options(state, "claude-haiku-5-5", "medium", 0.3, False, {}, it.ROOT)
    assert o.tools == [] and set(o.allowed_tools) == set(it.T.values()) and o.permission_mode == "dontAsk"
    assert "policy_critical" not in o.system_prompt and o.setting_sources == []
    on = it.build_options(state, "claude-haiku-5-5", "medium", 0.3, True, {}, it.ROOT)
    assert "policy_critical" in on.system_prompt
