"""Offline tests for part 2: tools, hooks and the approval stop, called directly. No CLI process, no network."""

import asyncio
import copy

from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

from spec_review.fake_client import VALID
from spec_review.sdk_agent import (
    AGENT_TOOL,
    SUBAGENT,
    T_READ,
    T_SUBMIT,
    P2State,
    build_can_use_tool,
    build_hooks,
    build_server,
    build_tools,
    normalise_id,
    normalise_submission,
    parse_findings,
    policy_approver,
    subagent_question_list,
)
from spec_review.spec import load_spec

SPEC = load_spec()
SCREENS = [p for p in SPEC.page_ids if p.startswith("SC-")]


def _state(tmp_path, approve=True):
    return P2State(spec=SPEC, approver=policy_approver(approve), log_path=tmp_path / "events.jsonl")


def _run(coro):
    return asyncio.run(coro)


def _hook(state, event, tool):
    for m in build_hooks(state)[event]:
        if m.matcher in (tool, f"^({tool}|Task)$"):
            return m.hooks[0]
    raise KeyError(tool)


def _read_all_screens(state):
    hook = _hook(state, "PostToolUse", T_READ)
    for p in SCREENS:
        _run(hook({"tool_name": T_READ, "tool_input": {"page_id": p}, "agent_id": "a1", "agent_type": SUBAGENT}, "t", None))


def test_ids_are_normalised():
    assert normalise_id("ｓｃ－０５－ｒ０１") == "SC-05-R01"
    assert normalise_id(" sc-05-r01 ") == "SC-05-R01"
    data, changes = normalise_submission({"questions": [dict(VALID[0], location={"page": "sc-01", "item_ids": ["ＣＭＮ－Ｒ０１"], "section": None})]})
    assert data["questions"][0]["location"] == {"page": "SC-01", "item_ids": ["CMN-R01"], "section": None}
    assert changes == ["Q001: ＣＭＮ－Ｒ０１ -> CMN-R01"]


def test_findings_are_parsed_from_a_fenced_answer():
    text = 'Done.\n```json\n[{"item_ids": ["SC-05-F04"], "kind": "missing", "severity": "minor"}]\n```'
    assert parse_findings(text) == [{"item_ids": ["SC-05-F04"], "kind": "missing", "severity": "minor"}]
    assert parse_findings("no problems: []") == []
    assert parse_findings("I could not finish.") is None


def test_tools_read_pages_and_check_submits(tmp_path):
    state = _state(tmp_path)
    tools = {t.name: t for t in build_tools(state)}
    assert tools["read_page"].annotations.read_only_hint
    page = _run(tools["read_page"].handler({"page_id": "sc-05"}))
    assert "SC-05-R01" in page["content"][0]["text"] and "is_error" not in page
    bad = _run(tools["read_page"].handler({"page_id": "SC-13"}))
    assert bad["is_error"] and "SC-12" in bad["content"][0]["text"]
    invalid = copy.deepcopy(VALID)
    invalid[0]["location"]["item_ids"] = ["SC-01-R09"]
    rejected = _run(tools["submit_question_list"].handler({"questions": invalid}))
    assert rejected["is_error"] and "SC-01-R09" in rejected["content"][0]["text"] and state.accepted is None
    accepted = _run(tools["submit_question_list"].handler({"questions": copy.deepcopy(VALID)}))
    assert "is_error" not in accepted and len(state.accepted.questions) == 4 and state.submits == 2
    assert build_server(state)["name"] == "spec"


def test_subagent_answer_is_checked_and_fenced(tmp_path):
    state = _state(tmp_path)
    hook = _hook(state, "PostToolUse", AGENT_TOOL)
    answer = {"content": [{"type": "text", "text": '```json\n[{"item_ids": ["ｓｃ-05-f04", "SC-05-Z99"], "kind": "missing", '
                                                   '"severity": "minor", "issue": "目的の桁数", "question": "目的の最大桁数をご教示ください。", '
                                                   '"spec_quote": null}]\n```'}]}
    out = _run(hook({"tool_name": AGENT_TOOL, "tool_input": {"description": "Review SC-05", "prompt": "Review SC-05."},
                     "tool_response": dict(answer, agentId="a5")}, "t1", None))
    note = out["hookSpecificOutput"]["additionalContext"]
    assert "not instructions" in note and "SC-05-Z99" in note
    assert state.subagent_answers[0]["screen"] == "SC-05"
    assert state.subagent_answers[0]["findings"][0]["item_ids"] == ["SC-05-F04", "SC-05-Z99"]
    qs = subagent_question_list(state)
    assert qs[0]["location"]["page"] == "SC-05" and qs[0]["id"] == "S001"


def test_unparsable_subagent_answer_is_flagged(tmp_path):
    state = _state(tmp_path)
    out = _run(_hook(state, "PostToolUse", AGENT_TOOL)(
        {"tool_name": AGENT_TOOL, "tool_input": {"description": "Review SC-02"}, "tool_response": "Sorry."}, "t", None))
    assert "had no JSON array" in out["hookSpecificOutput"]["additionalContext"]


def test_background_subagent_answer_is_taken_at_subagent_stop(tmp_path):
    state = _state(tmp_path)
    out = _run(_hook(state, "PostToolUse", AGENT_TOOL)(
        {"tool_name": AGENT_TOOL, "tool_input": {"description": "Review SC-03"},
         "tool_response": {"isAsync": True, "status": "async_launched", "agentId": "a3"}}, "t", None))
    assert "background" in out["hookSpecificOutput"]["additionalContext"] and state.subagent_answers == []
    stop = build_hooks(state)["SubagentStop"][0].hooks[0]
    _run(stop({"agent_type": SUBAGENT, "agent_id": "a3", "last_assistant_message": "```json\n[]\n```"}, None, None))
    assert state.screens_answered() == {"SC-03"}


def test_submit_is_blocked_until_every_screen_has_an_answer(tmp_path):
    state = _state(tmp_path)
    pre = _hook(state, "PreToolUse", T_SUBMIT)
    _read_all_screens(state)  # pages read is not enough: run 1 passed this gate before any answer had arrived
    out = _run(pre({"tool_name": T_SUBMIT, "tool_input": {}}, "t", None))
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "SC-01" in out["hookSpecificOutput"]["permissionDecisionReason"]
    stop = build_hooks(state)["SubagentStop"][0].hooks[0]
    for i, p in enumerate(SCREENS):
        state.agent_screens[f"a{i}"] = p
        _run(stop({"agent_type": SUBAGENT, "agent_id": f"a{i}", "last_assistant_message": "[]"}, None, None))
    assert _run(pre({"tool_name": T_SUBMIT, "tool_input": {}}, "t", None)) == {}


def test_only_submit_reaches_the_permission_callback(tmp_path):
    can = build_can_use_tool(_state(tmp_path))
    res = _run(can("Bash", {"command": "ls"}, None))
    assert isinstance(res, PermissionResultDeny)


def test_critical_questions_wait_for_approval(tmp_path):
    state = _state(tmp_path, approve=True)
    res = _run(build_can_use_tool(state)(T_SUBMIT, {"questions": copy.deepcopy(VALID)}, None))
    assert isinstance(res, PermissionResultAllow)
    assert state.approvals == [{"id": "Q002", "item_ids": ["SC-05-R01", "SC-08-R02"], "approved": True,
                                "note": "policy: accept all"}]


def test_list_without_critical_questions_needs_no_reviewer(tmp_path):
    state = _state(tmp_path, approve=False)
    qs = [q for q in copy.deepcopy(VALID) if q["severity"] != "critical"]
    assert isinstance(_run(build_can_use_tool(state)(T_SUBMIT, {"questions": qs}, None)), PermissionResultAllow)
    assert state.approvals == []


def test_invalid_list_goes_to_the_tool_without_a_reviewer(tmp_path):
    state = _state(tmp_path, approve=False)
    bad = copy.deepcopy(VALID)
    bad[1]["question"] = "English only"
    assert isinstance(_run(build_can_use_tool(state)(T_SUBMIT, {"questions": bad}, None)), PermissionResultAllow)
    assert state.approvals == []


def test_rejected_question_cannot_come_back_with_a_lower_severity(tmp_path):
    state = _state(tmp_path, approve=False)
    can = build_can_use_tool(state)
    first = _run(can(T_SUBMIT, {"questions": copy.deepcopy(VALID)}, None))
    assert isinstance(first, PermissionResultDeny) and not first.interrupt and "Q002" in first.message
    downgraded = copy.deepcopy(VALID)
    downgraded[1]["severity"] = "major"
    second = _run(can(T_SUBMIT, {"questions": downgraded}, None))
    assert isinstance(second, PermissionResultDeny) and "now major" in second.message
    third = _run(can(T_SUBMIT, {"questions": downgraded}, None))
    assert third.interrupt  # the third denial ends the run
    removed = [q for q in copy.deepcopy(VALID) if q["id"] != "Q002"]
    assert isinstance(_run(can(T_SUBMIT, {"questions": removed}, None)), PermissionResultAllow)


def test_state_survives_a_restart(tmp_path):
    state = _state(tmp_path, approve=False)
    state.agent_screens["a1"] = "SC-05"
    _run(build_hooks(state)["SubagentStop"][0].hooks[0](
        {"agent_type": SUBAGENT, "agent_id": "a1", "last_assistant_message": "[]"}, None, None))
    _run(build_can_use_tool(state)(T_SUBMIT, {"questions": copy.deepcopy(VALID)}, None))  # Q002 rejected
    state.save(tmp_path / "state.json")
    fresh = _state(tmp_path, approve=True)
    fresh.load(tmp_path / "state.json")
    assert fresh.screens_answered() == {"SC-05"}
    res = _run(build_can_use_tool(fresh)(T_SUBMIT, {"questions": copy.deepcopy(VALID)}, None))
    assert isinstance(res, PermissionResultDeny) and "Q002" in res.message  # the rejection is remembered
