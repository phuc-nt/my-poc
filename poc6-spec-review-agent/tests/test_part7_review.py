"""Offline tests for part 7 (A2, A6): the v2 schema and its code checks, the retry policy, the manifest, the resume
and the synthesis report. A fake client answers; nothing goes to the network."""

import json
import re
from contextlib import contextmanager
from types import SimpleNamespace

from spec_review import review_v2 as rv
from spec_review.extract import Meter, P4Config
from spec_review.score import ANSWERS
from spec_review.spec import load_spec

SPEC = load_spec()
ANS = json.loads(ANSWERS.read_text("utf-8"))


def q(**over):
    d = {"id": "Q001", "location": {"page": "SC-01", "item_ids": ["SC-01-R04", "CMN-R01"], "section": None},
         "kind": "contradiction", "kind_detail": None, "detected_pattern": "value_mismatch", "severity": "major",
         "issue": "自動ログアウトの時間が共通仕様と異なる。", "question": "自動ログアウトまでの時間は30分と60分のどちらでしょうか。",
         "spec_quote": "ログイン後、60分間操作がない場合",
         "sides": [{"item_id": "SC-01-R04", "value": "60分"}, {"item_id": "CMN-R01", "value": "30分"}],
         "conflict_detected": True, "proposed_answer": None}
    d.update(over)
    return d


def amb(qid="Q001", page="SC-03", item="SC-03-R03", severity="minor"):
    return q(id=qid, location={"page": page, "item_ids": [item], "section": None}, kind="ambiguous",
             detected_pattern="vague_wording", severity=severity, spec_quote=None, sides=[], conflict_detected=False)


def reply(data):
    text = json.dumps({"questions": data}, ensure_ascii=False)
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], stop_reason="end_turn",
                           usage=SimpleNamespace(input_tokens=1000, output_tokens=200, cache_creation_input_tokens=0,
                                                 cache_read_input_tokens=0))


class FakeClient:
    """Answers by screen: `by_screen[screen]` is a list of question lists, one per attempt."""

    def __init__(self, by_screen):
        self.by_screen, self.requests = {k: list(v) for k, v in by_screen.items()}, []
        self.messages = self

    @contextmanager
    def stream(self, **request):
        self.requests.append(request)
        screen = re.search(r'<page id="(SC-\d\d)">', request["messages"][0]["content"][0]["text"]).group(1)
        answers = self.by_screen[screen]
        data = answers.pop(0) if len(answers) > 1 else answers[0]
        yield SimpleNamespace(get_final_message=lambda: reply(data))


def test_schema_v2_stays_strict():
    item = rv.schema_v2(SPEC.page_ids)["properties"]["questions"]["items"]
    assert set(item["required"]) == set(item["properties"]) and item["additionalProperties"] is False
    assert "other" in item["properties"]["kind"]["enum"] and item["properties"]["detected_pattern"]["enum"] == rv.PATTERNS
    side = item["properties"]["sides"]["items"]
    assert side["required"] == ["item_id", "value"] and side["additionalProperties"] is False
    req = rv.build_request_v2("sonnet-format", SPEC, "SC-01", P4Config())
    assert req["output_config"]["format"]["schema"]["properties"]["questions"]["items"] == item
    assert "detected_pattern" in req["messages"][0]["content"][0]["text"]
    assert rv.build_request_v2("haiku-forced", SPEC, "SC-01", P4Config())["tools"][0]["input_schema"]["properties"][
        "questions"]["items"] == item


def test_validate_v2_computes_the_conflict():
    out, problems = rv.validate_v2({"questions": [q()]}, SPEC, "SC-01")
    assert problems == [] and out[0]["conflict_verified"] is True
    assert rv.item_row(SPEC, "CMN-R01")[0] == "CMN" and "30分" in rv.item_row(SPEC, "CMN-R01")[1]

    def msgs(item, screen="SC-01"):
        _, ps = rv.validate_v2({"questions": [item]}, SPEC, screen)
        return [(p.message, p.fixable) for p in ps]

    not_copied = msgs(q(sides=[{"item_id": "SC-01-R04", "value": "六十分"}, {"item_id": "CMN-R01", "value": "30分"}]))
    assert len(not_copied) == 1 and "not in the row of SC-01-R04" in not_copied[0][0] and not_copied[0][1]
    same = msgs(q(sides=[{"item_id": "SC-01-R04", "value": "操作がない場合"}, {"item_id": "CMN-R01", "value": "操作がない場合"}]))
    assert len(same) == 1 and "do not differ" in same[0][0]
    stated = msgs(amb(item="SC-03-R03") | {"conflict_detected": True, "location": {"page": "SC-03",
                                                                                   "item_ids": ["SC-03-R03"],
                                                                                   "section": None}})
    assert len(stated) == 1 and "conflict_detected is true" in stated[0][0]
    other = msgs(amb() | {"kind": "other", "kind_detail": None})
    assert other and "kind_detail" in other[0][0]
    assert msgs(amb() | {"kind": "other", "kind_detail": "用語の表記揺れ"}) == []

    # SC-05 cannot see SC-08: the side's value is not in the request, so the problem is not fixable by a retry.
    away = q(location={"page": "SC-05", "item_ids": ["SC-05-R01", "SC-08-R02"], "section": None},
             spec_quote=None, sides=[{"item_id": "SC-05-R01", "value": "最大14日"},
                                     {"item_id": "SC-08-R02", "value": "最大1か月"}])
    assert msgs(away, "SC-05") == [(msgs(away, "SC-05")[0][0], False)] and "SC-08" in msgs(away, "SC-05")[0][0]
    assert msgs(away, "SC-08") != [] and msgs(away, "SC-08")[0][1] is False  # SC-08 cannot see SC-05 either


def cfg(**over):
    return P4Config(**({"mode": "sonnet-format", "concurrency": 1} | over))


def test_retry_fixes_then_stops():
    bad = q(sides=[{"item_id": "SC-01-R04", "value": "六十分"}, {"item_id": "CMN-R01", "value": "30分"}])
    c = FakeClient({"SC-01": [[bad], [q()]]})
    r = rv.run_case_v2(c, SPEC, "SC-01", cfg(), Meter(1.0))
    assert r.outcome == "valid" and len(r.attempts) == 2 and r.attempts[0].problem == "fixable"
    assert "not in the row" in c.requests[1]["messages"][-1]["content"][0]["text"]

    c = FakeClient({"SC-01": [[bad]]})  # the same mistake every time
    r = rv.run_case_v2(c, SPEC, "SC-01", cfg(max_attempts=5), Meter(1.0))
    assert r.outcome == "no_progress" and len(r.attempts) == 2 and len(c.requests) == 2


def test_absent_information_is_dropped_not_retried():
    away = q(id="Q002", location={"page": "SC-05", "item_ids": ["SC-05-R01", "SC-08-R02"], "section": None},
             spec_quote=None, sides=[{"item_id": "SC-05-R01", "value": "最大14日"},
                                     {"item_id": "SC-08-R02", "value": "最大1か月"}])
    c = FakeClient({"SC-05": [[amb("Q001", "SC-05", "SC-05-R01"), away]]})
    r = rv.run_case_v2(c, SPEC, "SC-05", cfg(), Meter(1.0))
    assert r.outcome == "valid_with_dropped" and len(c.requests) == 1
    assert [x["id"] for x in r.questions] == ["Q001"] and r.dropped[0]["qid"] == "Q002"

    c = FakeClient({"SC-01": [[q(conflict_detected=False)], [q()]]})
    r = rv.run_case_v2(c, SPEC, "SC-01", cfg(), Meter(1.0))
    assert r.stated_vs_computed == [{"id": "Q001", "stated": False, "computed": True}] and r.outcome == "valid"


def test_stop_resume_and_report(tmp_path):
    answers = {"SC-01": [[q()]], "SC-02": [[q(severity="critical", location={"page": "SC-02",
                                                                              "item_ids": ["CMN-R01"], "section": None},
                                              kind="ambiguous", sides=[], conflict_detected=False, spec_quote=None,
                                              detected_pattern="vague_wording")]],
               "SC-03": [[amb()]]}
    c = FakeClient(answers)
    conf = cfg(screens=["SC-01", "SC-02", "SC-03"])
    first = rv.run_v2(c, SPEC, conf, tmp_path, stop_after=2)
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert [x["status"] for x in m["cases"].values()] == ["done", "done", "pending"] and len(c.requests) == 2
    assert first["requested"] == 2 and m["events"][-1]["pending"] == ["SC-03"]

    partial = rv.synthesise(tmp_path, SPEC, ANS)
    assert partial["coverage"]["missing"] == [{"screen": "SC-03", "status": "pending", "outcome": "not run"}]
    assert partial["coverage"]["screens_with_planted_problems_not_reviewed"] == ["SC-03"]
    assert "partial" in partial["coverage"]["note"]

    c2 = FakeClient(answers)
    rv.run_v2(c2, SPEC, conf, tmp_path)  # resume: only the pending case is requested
    assert len(c2.requests) == 1 and "SC-03" in c2.requests[0]["messages"][0]["content"][0]["text"]
    rep = rv.synthesise(tmp_path, SPEC, ANS)
    assert rep["coverage"]["note"] == "complete" and len(rep["claims"]) == 3
    cl = rep["claims"][0]
    assert cl["case"] == "SC-01" and cl["quote_found_on"] == ["SC-01"] and cl["spec_hash"] == rep["spec_hash"]
    assert {s["item_id"]: s["page"] for s in cl["sources"]} == {"SC-01-R04": "SC-01", "CMN-R01": "CMN"}
    (conflict,) = rep["conflicts"]
    assert conflict["item_id"] == "CMN-R01" and "kind and severity" in conflict["note"]
    assert rep["patterns"]["value_mismatch"]["questions"] == 1 and "P01" not in rep["score"]["missed"]
    md = (tmp_path / "report.md").read_text()
    assert "Coverage: 3 of 3" in md and "Conflicting claims" in md
    assert rv.resume_problem(m, SPEC) is None
    assert "spec changed" in rv.resume_problem(m | {"spec_hash": "000000000000"}, SPEC)
