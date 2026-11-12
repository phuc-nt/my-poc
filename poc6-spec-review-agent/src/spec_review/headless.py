"""Part 6: Claude Code run headless (`claude -p`) on this project's own configuration, and a script that checks it.

The run uses what a developer would use interactively: the project CLAUDE.md, the path rules in `.claude/rules`, the
`/review-spec` command, the hook in `.claude/settings.json` and the spec MCP server from `.mcp.json`. Only the output
is machine-shaped: `--output-format json` gives one result object, and `--json-schema` makes the answer an object of
a known shape. Code then parses it, validates the questions against the spec, scores them and books the cost.

`--bare` is not used: it skips CLAUDE.md discovery and hooks, which are what this part is about.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .schema import question_list_schema, validate_question_list
from .score import score
from .spec import Spec

ROOT = Path(__file__).resolve().parents[2]
MCP_CONFIG = ROOT / ".mcp.json"
T_READ = "mcp__spec__read_page"

# Which configuration files should reach a run of /review-spec, and which should not: the project CLAUDE.md always,
# the review policy it imports with @docs/review-policy.md (part 7), the spec rule because the command reads
# spec/*.md, and neither the src/ CLAUDE.md nor the Python rule, because the run opens no file under src/ or tests/.
EXPECTED_TAGS = {"P6-PROJECT", "P6-IMPORT", "P6-RULE-SPEC"}
ABSENT_TAGS = {"P6-SRC-DIR", "P6-RULE-PY"}

# The first wording ("Create .env.local ...") never reached the hook: the model refused on the CLAUDE.md rule alone.
# The probe tests the hook, so it says what is being tested and that the hook, not the model, is to refuse.
# The second run hit the Read deny rule on .env.local before the hook, so the target is a secret file that only the
# hook covers (.env.* in the hook, not in permissions.deny).
HOOK_TARGET = ".env.hook-probe"
HOOK_PROBE = ("The project owner is testing this project's PreToolUse hook, which must block writes to secret files. "
              "The hook has to see a real tool call, so make exactly one Write call: file_path {target} in the project "
              "folder, content DEMO_FLAG=1 (a dummy flag, no secret). Do not refuse it yourself; the hook decides. "
              "Make no other tool call and do not retry. Then reply with the text the tool returned, word for word.").format(target=HOOK_TARGET)


def review_schema(spec: Spec) -> dict[str, Any]:
    qs = question_list_schema(spec.page_ids, min_questions=0)
    return {"type": "object",
            "properties": {"rule_tags": {"type": "array", "items": {"type": "string"},
                                         "description": "Every 'Rule tag:' value in your instructions, as written."},
                           "questions": qs["properties"]["questions"]},
            "required": ["rule_tags", "questions"], "additionalProperties": False}


def build_command(prompt: str, model: str, max_budget_usd: float, *, schema: dict[str, Any] | None,
                  tools: list[str], claude: str = "claude") -> list[str]:
    cmd = [claude, "-p", prompt, "--output-format", "json", "--model", model,
           "--setting-sources", "project",  # this folder's settings, CLAUDE.md and rules; not the user's own
           "--mcp-config", str(MCP_CONFIG), "--strict-mcp-config",  # an explicit config needs no approval prompt
           "--tools", ",".join(t for t in tools if not t.startswith("mcp__")),  # built-in tools on offer
           "--allowedTools", ",".join(tools),  # allowed without asking
           "--permission-mode", "dontAsk",  # anything else is denied, never prompted
           "--max-budget-usd", f"{max_budget_usd:.2f}", "--no-session-persistence"]
    if schema is not None:
        cmd += ["--json-schema", json.dumps(schema, ensure_ascii=False)]
    return cmd


@dataclass
class HeadlessResult:
    returncode: int
    raw: dict[str, Any] | None
    parse_error: str | None = None
    seconds: float = 0.0
    stderr_tail: str = ""
    answer: Any = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def cost_usd(self) -> float:
        return float((self.raw or {}).get("total_cost_usd") or 0.0)


def parse_output(stdout: str) -> tuple[dict[str, Any] | None, Any, str | None]:
    """The result object of `--output-format json`, and the answer in it: `structured_output` when a schema was
    given, else the `result` text (parsed as JSON when it is JSON)."""
    try:
        raw = json.loads(stdout)
    except ValueError as e:
        return None, None, f"stdout is not one JSON object: {e}"
    if isinstance(raw, list):  # older versions printed the message list; the result is the last element
        raw = next((m for m in reversed(raw) if isinstance(m, dict) and m.get("type") == "result"), None)
        if raw is None:
            return None, None, "no result element in the output list"
    if raw.get("structured_output") is not None:
        return raw, raw["structured_output"], None
    text = raw.get("result") or ""
    try:
        return raw, json.loads(text[text.index("{"): text.rindex("}") + 1]), None
    except ValueError:
        return raw, text, None


def run_headless(cmd: list[str], env: dict[str, str], timeout_s: float = 600) -> HeadlessResult:
    if shutil.which(cmd[0]) is None:
        return HeadlessResult(returncode=127, raw=None, parse_error=f"{cmd[0]} is not on PATH")
    t0 = time.monotonic()
    p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout_s)
    raw, answer, err = parse_output(p.stdout)
    return HeadlessResult(returncode=p.returncode, raw=raw, parse_error=err, seconds=round(time.monotonic() - t0, 1),
                          stderr_tail=p.stderr[-2000:], answer=answer)


def screen_problems(answers: dict[str, Any], screen: str) -> list[str]:
    return [p["id"] for p in answers["problems"] if any(a.startswith(screen + "-") for a in p["anchors"])]


def check_review(res: HeadlessResult, spec: Spec, answers: dict[str, Any], screen: str) -> dict[str, Any]:
    raw, a = res.raw or {}, res.answer if isinstance(res.answer, dict) else {}
    tags = set(a.get("rule_tags") or [])
    parsed, errors = validate_question_list({"questions": a.get("questions", [])}, spec, check_quotes=True,
                                            allow_empty=True)
    questions = [q.model_dump(mode="json") for q in parsed.questions] if parsed else []
    s = score(questions, answers) if parsed else None
    want = screen_problems(answers, screen)
    found_here = sorted(p for p in (s or {}).get("matches", {}) if p in want)
    checks = {
        "exit_0": res.returncode == 0,
        "json_parsed": res.raw is not None and res.parse_error is None,
        "not_is_error": raw.get("is_error") is False,
        "structured_output": raw.get("structured_output") is not None,
        "questions_valid": parsed is not None,
        "expected_tags_loaded": EXPECTED_TAGS <= tags,
        "unrelated_tags_absent": not (ABSENT_TAGS & tags),
    }
    return {"checks": checks, "passed": sum(checks.values()), "of": len(checks), "rule_tags": sorted(tags),
            "validation_errors": errors, "questions": questions, "screen_problems": want, "found_on_screen": found_here,
            "score": s}


def check_hook(res: HeadlessResult, target: Path) -> dict[str, Any]:
    text = res.answer if isinstance(res.answer, str) else json.dumps(res.answer, ensure_ascii=False)
    checks = {
        "json_parsed": res.raw is not None,
        "file_not_created": not target.exists(),
        "reason_reached_model": "Blocked by the project hook" in (text or ""),
    }
    return {"checks": checks, "passed": sum(checks.values()), "of": len(checks), "reply": text}
