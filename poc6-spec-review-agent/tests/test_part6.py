"""Offline tests for part 6: the Claude Code configuration files, the secret-file hook, the headless command and the
parsing of its JSON output. Nothing here starts Claude Code or calls the API."""

import json
import re
import subprocess
import sys
from pathlib import Path

from spec_review import headless as h
from spec_review.score import ANSWERS
from spec_review.spec import load_spec

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / ".claude" / "hooks" / "block_secret_files.py"
SPEC = load_spec()
ANS = json.loads(ANSWERS.read_text("utf-8"))


def run_hook(call) -> subprocess.CompletedProcess:
    data = call if isinstance(call, str) else json.dumps(call)
    return subprocess.run([sys.executable, str(HOOK)], input=data, capture_output=True, text=True, timeout=10)


def frontmatter(path: Path) -> str:
    text = path.read_text("utf-8")
    assert text.startswith("---\n"), path
    return text.split("---\n")[1]


def test_each_config_file_carries_its_tag_and_scope():
    tags = {p: re.search(r"Rule tag: (P6-[A-Z-]+)", p.read_text("utf-8")).group(1)
            for p in [ROOT / "CLAUDE.md", ROOT / "src" / "CLAUDE.md", *sorted((ROOT / ".claude" / "rules").glob("*.md"))]}
    assert set(tags.values()) == h.EXPECTED_TAGS | h.ABSENT_TAGS
    assert '"spec/**/*.md"' in frontmatter(ROOT / ".claude" / "rules" / "spec-pages.md")
    assert '"src/**/*.py"' in frontmatter(ROOT / ".claude" / "rules" / "python.md")
    assert not (ROOT / "spec" / "CLAUDE.md").exists()  # load_spec reads every *.md in spec/ as a page
    assert set(SPEC.page_ids) == {"OVR", "CMN", *(f"SC-{i:02d}" for i in range(1, 13))}


def test_command_and_skill():
    cmd = (ROOT / ".claude" / "commands" / "review-spec.md").read_text("utf-8")
    assert "allowed-tools: mcp__spec__read_page, Read" in frontmatter(ROOT / ".claude" / "commands" / "review-spec.md")
    assert cmd.count("$ARGUMENTS") >= 2 and "rule_tags" in cmd
    skill = frontmatter(ROOT / ".claude" / "skills" / "score-questions" / "SKILL.md")
    assert "name: score-questions" in skill and "description: " in skill and "spec-review score" in skill


def test_settings_wire_the_hook():
    s = json.loads((ROOT / ".claude" / "settings.json").read_text("utf-8"))
    entry = s["hooks"]["PreToolUse"][0]
    assert set(entry["matcher"].split("|")) >= {"Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"}
    assert ".claude/hooks/block_secret_files.py" in entry["hooks"][0]["command"]
    assert "Read(./.env)" in s["permissions"]["deny"]


def test_hook_blocks_secret_files_only():
    blocked = [("Write", {"file_path": "/p/.env"}), ("Write", {"file_path": "/p/.env.local"}),
               ("Edit", {"file_path": "certs/server.pem"}), ("MultiEdit", {"file_path": "/p/secrets.env"}),
               ("NotebookEdit", {"notebook_path": "/home/u/.ssh/id_rsa"}),
               ("Bash", {"command": "echo KEY=1 >> .env"}), ("Bash", {"command": "printf x | tee -a ~/.ssh/id_ed25519"}),
               ("Bash", {"command": "cp .env.example .env"}), ("Bash", {"command": "sed -i '' s/a/b/ .env.local"}),
               ("Bash", {"command": "dd if=/dev/zero of=api.key count=1"})]
    for tool, inp in blocked:
        r = run_hook({"tool_name": tool, "tool_input": inp})
        assert r.returncode == 2 and "Blocked by the project hook" in r.stderr, (tool, inp)
        assert r.stdout == ""
    allowed = [("Write", {"file_path": "/p/.env.example"}), ("Write", {"file_path": "/p/src/env.py"}),
               ("Edit", {"file_path": "/p/README.md"}), ("Read", {"file_path": "/p/.env"}),
               ("Bash", {"command": "cat .env.example > /tmp/x.txt 2>&1"}), ("Bash", {"command": "uv run pytest -q"}),
               ("Bash", {"command": "grep -n KEY .env.example"})]
    for tool, inp in allowed:
        assert run_hook({"tool_name": tool, "tool_input": inp}).returncode == 0, (tool, inp)
    assert run_hook("not json").returncode == 0  # a broken call is not blocked: the guard fails open, by design


def test_build_command():
    cmd = h.build_command("/review-spec SC-01", "claude-haiku-5-5", 0.3, schema=h.review_schema(SPEC),
                          tools=["Read", h.T_READ])
    assert cmd[:3] == ["claude", "-p", "/review-spec SC-01"] and "--bare" not in cmd
    opt = {cmd[i]: cmd[i + 1] for i in range(3, len(cmd) - 1) if cmd[i].startswith("--")}
    assert opt["--output-format"] == "json" and opt["--setting-sources"] == "project"
    assert opt["--tools"] == "Read" and opt["--allowedTools"] == f"Read,{h.T_READ}"
    assert opt["--permission-mode"] == "dontAsk" and opt["--max-budget-usd"] == "0.30"
    assert "--strict-mcp-config" in cmd and opt["--mcp-config"].endswith(".mcp.json")
    schema = json.loads(opt["--json-schema"])
    assert schema["required"] == ["rule_tags", "questions"] and schema["properties"]["questions"]["minItems"] == 0


def good_question():
    return {"id": "Q001", "location": {"page": "SC-01", "item_ids": ["SC-01-R04", "CMN-R01"], "section": None},
            "kind": "contradiction", "severity": "major", "issue": "自動ログアウトの時間が共通仕様と異なる。",
            "question": "自動ログアウトまでの時間は30分と60分のどちらでしょうか。",
            "spec_quote": "ログイン後、60分間操作がない場合", "proposed_answer": None}


def test_parse_and_check_review():
    out = {"type": "result", "subtype": "success", "is_error": False, "num_turns": 4, "total_cost_usd": 0.012,
           "result": "", "structured_output": {"rule_tags": ["P6-PROJECT", "P6-RULE-SPEC"], "questions": [good_question()]}}
    raw, answer, err = h.parse_output(json.dumps(out, ensure_ascii=False))
    assert err is None and answer["rule_tags"] == ["P6-PROJECT", "P6-RULE-SPEC"]
    res = h.HeadlessResult(returncode=0, raw=raw, answer=answer)
    c = h.check_review(res, SPEC, ANS, "SC-01")
    assert c["passed"] == c["of"] and c["found_on_screen"] == ["P01"] and res.cost_usd == 0.012
    assert set(c["screen_problems"]) == {"P01", "P04"}

    leaked = dict(answer, rule_tags=["P6-PROJECT", "P6-RULE-SPEC", "P6-RULE-PY"])
    reworded = dict(answer, questions=[good_question() | {"spec_quote": "60分操作がなければ"}])
    for a, failing in ((leaked, "unrelated_tags_absent"), (reworded, "questions_valid")):
        c = h.check_review(h.HeadlessResult(returncode=0, raw=raw, answer=a), SPEC, ANS, "SC-01")
        assert not c["checks"][failing] and c["passed"] == c["of"] - 1

    raw2, text, _ = h.parse_output(json.dumps({"type": "result", "is_error": False, "result": "書き込みは拒否されました。"}))
    assert text == "書き込みは拒否されました。" and h.parse_output("Error: budget")[2].startswith("stdout is not")
