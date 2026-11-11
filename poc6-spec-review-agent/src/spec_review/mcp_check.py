"""Part 5: the stdio MCP server used from an Agent SDK session, configured by the same `.mcp.json` as Claude Code.

The agent must read the index resource, read one page, and try one unknown page. Code then checks the transcript, not
the agent's own report: which tools were called, whether the unknown page came back as an error result, and whether
the answer's facts match the spec.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)

from .mcp_server import INDEX_URI, index
from .pricing import cost_usd
from .sdk_agent import _jsonable, _usage_from_model_usage
from .spec import Spec

ROOT = Path(__file__).resolve().parents[2]
MCP_CONFIG = ROOT / ".mcp.json"
SERVER = "spec"
T_READ = f"mcp__{SERVER}__read_page"
RESOURCE_TOOLS = ["ListMcpResourcesTool", "ReadMcpResourceTool"]

SYSTEM = ("You check an MCP server that serves a specification. Use only the tools you are given. Report what the "
          "tools returned, exactly; do not guess.")
PROMPT = f"""Do these three steps in order, using the MCP server named "{SERVER}":
1. Read the resource {INDEX_URI}.
2. Call read_page for SC-06.
3. Call read_page for SC-13.
Then reply with one JSON object and nothing else:
{{"index_pages": <number of pages in the index>, "sc06_title": "<the first heading of SC-06, without #>",
 "sc06_item_ids": [<every ID that starts with SC-06- in the page, in order of first appearance>],
 "sc13_error": "<the error text read_page returned for SC-13>"}}"""


@dataclass
class P5Result:
    init: dict[str, Any]
    calls: list[dict[str, Any]] = field(default_factory=list)  # tool name, input, is_error of its result
    answer: dict[str, Any] | None = None
    answer_error: str | None = None
    result: ResultMessage | None = None
    seconds: float = 0.0
    own_cost_usd: float | None = None


def build_options(env: dict[str, str], cwd: Path, model: str, max_budget_usd: float) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        model=model,
        system_prompt=SYSTEM,
        mcp_servers=MCP_CONFIG,  # a path: passed to --mcp-config, which expands ${SPEC_SERVER_TOKEN} from env
        strict_mcp_config=True,  # only this file, not the user's own MCP servers
        setting_sources=[],
        tools=RESOURCE_TOOLS,  # the built-in tools that read MCP resources; nothing else built in
        allowed_tools=[*RESOURCE_TOOLS, T_READ],
        permission_mode="dontAsk",  # anything not allowed is denied, never prompted
        max_turns=8,
        max_budget_usd=max_budget_usd,
        effort="low",
        cwd=str(cwd),
        env=env,
    )


async def run_p5(run_dir: Path, env: dict[str, str], model: str = "claude-haiku-5-5",
                 max_budget_usd: float = 0.25) -> P5Result:
    options = build_options(env, ROOT, model, max_budget_usd)  # cwd ROOT: the config's `uv run` needs the project
    res = P5Result(init={})
    pending: dict[str, dict[str, Any]] = {}
    text = ""
    t0 = time.monotonic()
    with (run_dir / "transcript.jsonl").open("w", encoding="utf-8") as tr:
        async for msg in query(prompt=PROMPT, options=options):
            tr.write(json.dumps(_jsonable(msg), ensure_ascii=False, default=str) + "\n")
            if isinstance(msg, SystemMessage) and msg.subtype == "init":
                res.init = {k: msg.data.get(k) for k in ("model", "tools", "mcp_servers", "apiKeySource",
                                                         "permissionMode", "claude_code_version")}
            elif isinstance(msg, AssistantMessage):
                for b in msg.content:
                    if isinstance(b, ToolUseBlock):
                        pending[b.id] = {"tool": b.name, "input": b.input, "is_error": None}
                        res.calls.append(pending[b.id])
                    elif isinstance(b, TextBlock):
                        text = b.text
            elif isinstance(msg, UserMessage) and isinstance(msg.content, list):
                for b in msg.content:
                    if isinstance(b, ToolResultBlock) and b.tool_use_id in pending:
                        pending[b.tool_use_id]["is_error"] = bool(b.is_error)
            elif isinstance(msg, ResultMessage):
                res.result = msg
    res.seconds = round(time.monotonic() - t0, 1)
    if res.result and res.result.model_usage:
        try:
            res.own_cost_usd = round(sum(cost_usd(m, _usage_from_model_usage(u))
                                         for m, u in res.result.model_usage.items()), 6)
        except KeyError:
            res.own_cost_usd = None
    try:
        res.answer = json.loads(text[text.index("{"): text.rindex("}") + 1])
    except ValueError as e:
        res.answer_error = f"no JSON object in the final text: {e}"
    return res


def check(res: P5Result, spec: Spec) -> dict[str, Any]:
    """What code can verify: the server connected, each step happened, the error came back as an error, and the
    answer's facts are the spec's."""
    import re

    servers = {s.get("name"): s.get("status") for s in (res.init.get("mcp_servers") or [])}
    reads = [c for c in res.calls if c["tool"] == T_READ]
    page = spec.pages["SC-06"]
    want_ids = list(dict.fromkeys(re.findall(r"SC-06-[A-Z]?\d+", page.text)))
    a = res.answer or {}
    checks = {
        "server_connected": servers.get(SERVER) == "connected",
        "resource_read": any(c["tool"] == "ReadMcpResourceTool" and c["input"].get("uri") == INDEX_URI
                             for c in res.calls),
        "sc06_read_ok": any(c["input"].get("page_id", "").upper() == "SC-06" and c["is_error"] is False for c in reads),
        "sc13_is_error": any(c["input"].get("page_id", "").upper() == "SC-13" and c["is_error"] is True for c in reads),
        "index_pages": a.get("index_pages") == len(index(spec)["pages"]),
        "sc06_title": a.get("sc06_title") == page.title,
        "sc06_item_ids": a.get("sc06_item_ids") == want_ids,
        "sc13_error_names_valid_ids": "SC-12" in str(a.get("sc13_error", "")),
    }
    return {"checks": checks, "passed": sum(checks.values()), "of": len(checks), "expected_sc06_item_ids": want_ids}
