"""Offline tests for part 7 (A3, A4): the labelled pool, the stratified sample, the verifier request, the batch run
that resubmits only the failed custom_ids, and the calibration. A fake batch API answers; nothing goes to the
network."""

import json
from types import SimpleNamespace

from spec_review import verify as v
from spec_review.score import ANSWERS
from spec_review.spec import load_spec

SPEC = load_spec()
ANS = json.loads(ANSWERS.read_text("utf-8"))


def msg(verdict=None, stop="end_turn", text=None):
    body = text if text is not None else json.dumps(verdict, ensure_ascii=False)
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=body)], stop_reason=stop,
                           usage=SimpleNamespace(input_tokens=1000, output_tokens=100, cache_creation_input_tokens=0,
                                                 cache_read_input_tokens=0))


def verdict(real=True, conf=0.9):
    return {"is_real_problem": real, "kind": "missing" if real else "none", "severity": "major" if real else "none",
            "confidence": conf, "reason": "x"}


class FakeBatches:
    """`answer(custom_id, params, round)` returns a result: a message, or ('errored'|'expired', None)."""

    def __init__(self, answer):
        self.answer, self.created, self.store = answer, [], {}

    def create(self, requests):
        bid = f"b{len(self.created) + 1}"
        self.created.append([r["custom_id"] for r in requests])
        self.store[bid] = [(r["custom_id"], self.answer(r["custom_id"], r["params"], len(self.created)))
                           for r in requests]
        return SimpleNamespace(id=bid, processing_status="in_progress")

    def retrieve(self, bid):
        return SimpleNamespace(id=bid, processing_status="ended", request_counts=None)

    def results(self, bid):
        for cid, a in self.store[bid]:
            if isinstance(a, tuple):
                err = SimpleNamespace(error=SimpleNamespace(type="api_error"))
                yield SimpleNamespace(custom_id=cid, result=SimpleNamespace(type=a[0], error=err))
            else:
                yield SimpleNamespace(custom_id=cid, result=SimpleNamespace(type="succeeded", message=a))

    def cancel(self, bid):
        pass


def client(answer):
    b = FakeBatches(answer)
    return SimpleNamespace(messages=SimpleNamespace(batches=b)), b


def test_labels_come_from_the_scorer():
    qs = [{"id": "Q001", "location": {"page": "SC-01", "item_ids": ["SC-01-R04"], "section": None},
           "kind": "contradiction", "severity": "major", "issue": "", "question": "", "spec_quote": None},
          {"id": "Q002", "location": {"page": "SC-05", "item_ids": ["SC-05-F03"], "section": None},
           "kind": "missing", "severity": "minor", "issue": "", "question": "", "spec_quote": None},
          {"id": "Q003", "location": {"page": "SC-02", "item_ids": ["SC-02-F99"], "section": None},
           "kind": "missing", "severity": "minor", "issue": "", "question": "", "spec_quote": None}]
    labels = {q["id"]: (q["label"], q["ref"]) for q in v.label_questions(qs, ANS)}
    assert labels["Q002"] == ("not_real", "N01") and labels["Q003"] == (None, None)
    assert labels["Q001"][0] == "real"


def test_pool_and_stratified_sample(tmp_path):
    run = tmp_path / "r1"
    run.mkdir()
    q = {"location": {"page": "SC-05", "item_ids": ["SC-05-F03"], "section": None}, "kind": "missing",
         "severity": "minor", "issue": "i", "question": "q", "spec_quote": None}
    (run / "question_list.json").write_text(json.dumps({"questions": [q | {"id": "Q001"}, q | {"id": "Q002"}]}))
    dry = tmp_path / "x-dry"
    dry.mkdir()
    (dry / "question_list.json").write_text(json.dumps({"questions": [q | {"id": "Q001", "question": "dry"}]}))
    pool = v.build_pool(ANS, tmp_path)
    sources = [p["source"] for p in pool]
    assert sources.count("r1") == 1 and "x-dry" not in sources  # duplicates merged, dry runs skipped
    assert sources.count("decoy") == len(v.DECOYS) and all(p["label"] == "not_real" for p in pool)
    s1, s2 = v.stratified_sample(pool, 2), v.stratified_sample(pool, 2)
    assert s1 == s2 and len([x for x in s1 if x["kind"] == "missing"]) == 2
    # the first picks of a stratum cover different non-issues before any repeats
    assert len({x["ref"] for x in s1 if x["kind"] == "missing"}) == 2


def test_verifier_sees_the_cited_pages_not_the_reasoning():
    item = {"location": {"page": "SC-05", "item_ids": ["SC-05-R01", "SC-08-R02"], "section": None},
            "kind": "contradiction", "severity": "major", "issue": "i", "question": "q", "spec_quote": None,
            "label": "real", "ref": "P09", "source": "s", "proposed_answer": "secret", "pid": "V001"}
    assert v.cited_pages(item, SPEC) == ["SC-05", "SC-08"]
    p = v.verify_params(item, SPEC)
    user = p["messages"][0]["content"]
    assert '<page id="SC-05">' in user and '<page id="SC-08">' in user and '<page id="SC-01">' not in user
    assert "label" not in user and "P09" not in user and "secret" not in user
    assert '<page id="CMN">' in p["system"][0]["text"] and p["system"][0]["cache_control"]
    schema = p["output_config"]["format"]["schema"]
    assert schema["additionalProperties"] is False and set(schema["required"]) == set(schema["properties"])


def test_read_verdict_flags_unusable_answers():
    assert v.read_verdict(msg(verdict()))[1] is None
    assert v.read_verdict(msg(stop="max_tokens", text='{"is_'))[1] == "max_tokens"
    assert v.read_verdict(msg(text="not json"))[1] == "invalid_json"
    assert v.read_verdict(msg(text='{"is_real_problem": true}'))[1] == "invalid_shape"


def test_batch_resubmits_only_the_failed_custom_ids():
    def answer(cid, params, rnd):
        if cid == "A" and params["max_tokens"] < 100:
            return msg(stop="max_tokens", text="{")
        if cid == "B" and rnd == 1:
            return ("errored", None)
        if cid == "C" and rnd == 1:
            return ("expired", None)
        if cid == "D":
            return msg(stop="refusal", text="")
        return msg(verdict())

    c, b = client(answer)
    params = {k: {"max_tokens": 16 if k == "A" else 4000} for k in "ABCDE"}
    log = []
    out = v.run_batch_with_resubmit(c, params, lambda m: v.read_verdict(m)[1], v.default_fix(4000), log.append,
                                    poll_s=0)
    assert b.created == [list("ABCDE"), ["A", "B", "C"]]  # D refused: not resubmitted
    assert sorted(out["good"]) == ["A", "B", "C", "E"] and out["gave_up"] == ["D"]
    r1 = out["rounds"][0]["failed"]
    assert r1["A"] == "max_tokens" and r1["B"].startswith("errored") and r1["C"].startswith("expired")
    assert len(out["billed"]) == 1 + 1 + 1 + 3  # A, D, E in round 1; A, B, C in round 2: errors are not billed
    assert out["rounds"][1]["failed"] == {}


def test_calibration_picks_a_threshold_per_segment():
    rows = []
    for i in range(10):  # high confidence, right
        rows.append({"pid": f"H{i}", "label": "real", "ref": "P01", "kind": "missing", "verdict": verdict(True, 0.95)})
    for i in range(4):  # low confidence, half wrong
        rows.append({"pid": f"L{i}", "label": "not_real", "ref": "N01", "kind": "ambiguous",
                     "verdict": verdict(i % 2 == 0, 0.55)})
    c = v.calibrate(rows)
    assert c["n"] == 14 and c["confusion"] == {"not_real->not_real": 2, "not_real->real": 2, "real->real": 10}
    assert c["chosen"]["threshold"] == 0.6 and c["chosen"]["automated"] == 10 and c["chosen"]["accuracy"] == 1.0
    assert c["segments"]["kind"]["ambiguous"]["accuracy"] == 0.5
    assert c["thresholds"][0]["accuracy"] < 0.95  # at 0.5 everything is automated and the wrong ones come with it
    assert c["mean_confidence_right"] > c["mean_confidence_wrong"] and len(c["wrong"]) == 2


def test_run_verify_end_to_end(tmp_path):
    run = tmp_path / "runs" / "r1"
    run.mkdir(parents=True)
    q = {"id": "Q001", "location": {"page": "SC-01", "item_ids": ["SC-01-R04"], "section": None},
         "kind": "contradiction", "severity": "major", "issue": "i", "question": "q", "spec_quote": None}
    (run / "question_list.json").write_text(json.dumps({"questions": [q]}))

    def answer(cid, params, rnd):
        if params["max_tokens"] == 16:
            return msg(stop="max_tokens", text="{")
        real = "SC-01-R04" in params["messages"][0]["content"]
        return msg(verdict(real, 0.9))

    c, b = client(answer)
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    r = v.run_verify(c, SPEC, ANS, out_dir, per_stratum=3, inject_fault=True, poll_s=0, runs=tmp_path / "runs")
    assert r["sample"] == 1 + len(v.DECOYS) and len(b.created) == 2 and len(b.created[1]) == 1
    assert r["gave_up"] == [] and r["calibration"]["accuracy"] == 1.0 and r["cost_usd"] > 0
    assert (out_dir / "verdicts.json").exists() and (out_dir / "batch.jsonl").exists()
