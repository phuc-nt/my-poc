"""Offline tests for part 3: the notes, their fact check, the code fallback, grep, and the notes mode of the agent."""

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace

from spec_review.notes import (
    Notes,
    build_notes,
    load_notes,
    missing_facts,
    missing_terms,
    search_spec,
    summarise_page,
)
from spec_review.sdk_agent import T_NOTE, T_READ, T_SEARCH, P2Config, P2State, build_options, build_tools, policy_approver
from spec_review.spec import Page, load_spec

SPEC = load_spec()
SC01 = SPEC.pages["SC-01"]


class FakeClient:
    """Answers each request with the next scripted text; counts the calls."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []
        self.messages = self

    @contextmanager
    def stream(self, **request):
        self.calls.append(request)
        text = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        usage = SimpleNamespace(input_tokens=1000, output_tokens=200, cache_creation_input_tokens=0, cache_read_input_tokens=0)
        msg = SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], usage=usage)
        yield SimpleNamespace(get_final_message=lambda: msg)


def full_summary(page: Page) -> str:
    """A summary that keeps everything: the page itself."""
    return page.text


def test_fact_check_finds_lost_ids_and_numbers():
    lossy = SC01.text.replace("60分間", "一定時間").replace("| SC-01-R02 |", "|")
    assert missing_facts(SC01, lossy) == ["SC-01-R02", "60"]
    assert missing_facts(SC01, SC01.text) == []
    flow = Page("X", "x", "1. 申請する\n2. 承認する（14日以内）")
    assert missing_facts(flow, "申請、承認（14日以内）") == []  # list markers are not facts


def test_a_lost_fact_gets_one_retry():
    lossy = SC01.text.replace("60分間", "一定時間")
    client = FakeClient([lossy, full_summary(SC01)])
    r = summarise_page(client, SC01)
    assert r.lost_first == ["60"] and r.lost_after_retry == [] and r.appended_lines == 0
    assert len(client.calls) == 2 and "60" in client.calls[1]["messages"][0]["content"].split("lost these")[1]
    assert r.usage["input_tokens"] == 2000


def test_what_the_retry_still_loses_is_appended_from_the_spec():
    lossy = SC01.text.replace("60分間", "一定時間")
    r = summarise_page(FakeClient([lossy, lossy]), SC01)
    assert r.lost_after_retry == ["60"] and r.appended_lines == 1
    assert "## 原文" in r.text and "| SC-01-R04 | 自動ログアウト | ログイン後、60分間操作がない場合" in r.text
    assert missing_facts(SC01, r.text) == []


def test_glossary_must_name_the_defined_terms_and_used_mails():
    assert "MAIL-02" in missing_terms(SPEC, "MAIL-01 MAIL-03")  # used on SC-09, defined nowhere
    every = " ".join(p.text for p in SPEC.pages.values())
    assert missing_terms(SPEC, every) == []


def test_notes_are_written_and_rebuilt_only_for_a_new_spec(tmp_path):
    answers = [full_summary(p) for p in SPEC.pages.values()] + [" ".join(p.text for p in SPEC.pages.values())]
    notes, cost = build_notes(FakeClient(answers), SPEC, tmp_path)
    assert (tmp_path / "summaries" / "SC-05.md").exists() and (tmp_path / "glossary.md").exists()
    assert cost > 0 and notes.manifest["notes"]["SC-05"]["lost_first"] == []
    assert load_notes(SPEC, tmp_path) is not None
    changed = load_spec()
    changed.pages["SC-01"] = Page("SC-01", SC01.title, SC01.text + "\n追記")
    assert load_notes(changed, tmp_path) is None  # another spec version: the notes are stale


def test_search_spec_greps_every_page():
    lines, err = search_spec(SPEC, "資産番号")
    assert err is None and {x.split(":")[0] for x in lines} >= {"SC-08", "SC-10", "SC-12"}
    by_unit, _ = search_spec(SPEC, r"\d+桁")  # lengths in the 桁数 column carry no unit: grep by item name too
    assert not any(x.startswith("SC-10:") for x in by_unit)
    assert search_spec(SPEC, "(")[1].startswith("Invalid regular expression")
    many, _ = search_spec(SPEC, "SC-", limit=5)
    assert len(many) == 6 and "more lines" in many[-1]


def _notes() -> Notes:
    return Notes({p: f"# {p} summary" for p in SPEC.page_ids}, "# glossary", {})


def test_note_tools_in_part3_mode(tmp_path):
    state = P2State(spec=SPEC, approver=policy_approver(True), log_path=tmp_path / "e.jsonl", notes=_notes())
    tools = {t.name: t for t in build_tools(state)}
    run = asyncio.run
    assert run(tools["read_note"].handler({"name": "glossary"}))["content"][0]["text"] == "# glossary"
    assert "# SC-05 summary" in run(tools["read_note"].handler({"name": "Index"}))["content"][0]["text"]
    assert run(tools["read_note"].handler({"name": "ｓｃ-05"}))["content"][0]["text"] == "# SC-05 summary"
    bad = run(tools["read_note"].handler({"name": "SC-13"}))
    assert bad["is_error"] and "glossary" in bad["content"][0]["text"]
    found = run(tools["search_spec"].handler({"pattern": "MAIL-02"}))["content"][0]["text"]
    assert "SC-09:" in found


def test_part3_subagent_gets_notes_not_full_pages(tmp_path):
    notes = _notes()
    state = P2State(spec=SPEC, approver=policy_approver(True), log_path=tmp_path / "e.jsonl", notes=notes)
    opts = build_options(state, P2Config(notes=notes), tmp_path, {})
    sub = opts.agents["screen-reviewer"]
    assert '<note id="glossary">' in sub.prompt and "# CMN summary" in sub.prompt
    assert SPEC.pages["CMN"].text not in sub.prompt and sub.tools == [T_READ, T_NOTE]
    assert T_SEARCH in opts.allowed_tools and "read_note" in opts.system_prompt
    p2 = build_options(P2State(spec=SPEC, approver=policy_approver(True), log_path=tmp_path / "f.jsonl"),
                       P2Config(), tmp_path, {})
    assert SPEC.pages["CMN"].text in p2.agents["screen-reviewer"].prompt and T_NOTE not in p2.allowed_tools


def test_context_stats_split_coordinator_and_subagents(tmp_path):
    import json

    from spec_review.sdk_agent import context_stats

    def msg(parent, read, write):
        return json.dumps({"type": "AssistantMessage", "parent_tool_use_id": parent,
                           "usage": {"input_tokens": 2, "cache_read_input_tokens": read, "cache_creation_input_tokens": write}})

    rows = [msg(None, 5000, 1000), msg("t1", 5000, 600), msg("t1", 5600, 400), msg("t2", 5000, 600), msg(None, 9000, 3000),
            json.dumps({"type": "ResultMessage"})]
    (tmp_path / "transcript.jsonl").write_text("\n".join(rows), encoding="utf-8")
    assert context_stats(tmp_path / "transcript.jsonl") == {"coordinator_peak": 12002, "subagents": 2,
                                                            "subagent_first_mean": 5602, "subagent_peak_mean": 5802}
