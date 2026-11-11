"""Offline tests for part 5: the MCP server's tool, resource, error result, start-up check and .mcp.json."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

from mcp import Client, StdioServerParameters

from spec_review.mcp_server import INDEX_URI, TOKEN_VAR, build_server
from spec_review.spec import load_spec

ROOT = Path(__file__).resolve().parents[1]
SPEC = load_spec()


def run(coro):
    return asyncio.run(coro)


async def _session(server, calls):
    async with Client(server) as c:
        return [await f(c) for f in calls]


def test_tool_reads_a_page_and_normalises_the_id():
    tools, page, wide = run(_session(build_server(SPEC), [
        lambda c: c.list_tools(),
        lambda c: c.call_tool("read_page", {"page_id": "sc-06"}),
        lambda c: c.call_tool("read_page", {"page_id": "ＳＣ－０６"}),
    ]))
    (tool,) = tools.tools
    assert tool.name == "read_page" and tool.annotations.read_only_hint and INDEX_URI in tool.description
    assert tool.input_schema["required"] == ["page_id"]
    assert not page.is_error and page.content[0].text == SPEC.pages["SC-06"].text
    assert wide.content[0].text == SPEC.pages["SC-06"].text


def test_unknown_page_is_an_error_result_naming_the_valid_ids():
    (r,) = run(_session(build_server(SPEC), [lambda c: c.call_tool("read_page", {"page_id": "SC-13"})]))
    assert r.is_error  # a result the model reads, not a protocol error that ends the call
    assert "SC-13" in r.content[0].text and "SC-12" in r.content[0].text and INDEX_URI in r.content[0].text


def test_index_resource():
    listed, read = run(_session(build_server(SPEC), [lambda c: c.list_resources(), lambda c: c.read_resource(INDEX_URI)]))
    assert [(str(x.uri), x.mime_type) for x in listed.resources] == [(INDEX_URI, "application/json")]
    data = json.loads(read.contents[0].text)
    assert [p["page_id"] for p in data["pages"]] == SPEC.page_ids and len(data["spec_hash"]) == 12
    assert all(p["item_ids"] > 0 for p in data["pages"])


def test_stdio_server_starts_only_with_the_token(tmp_path):
    env = {"SPEC_DIR": str(ROOT / "spec"), "PATH": "/usr/bin:/bin"}
    no_token = subprocess.run([sys.executable, "-m", "spec_review.mcp_server"], env=env, capture_output=True,
                              text=True, timeout=60, stdin=subprocess.DEVNULL)
    assert no_token.returncode == 2 and TOKEN_VAR in no_token.stderr and no_token.stdout == ""
    params = StdioServerParameters(command=sys.executable, args=["-m", "spec_review.mcp_server"],
                                   env=env | {TOKEN_VAR: "test-only"})
    (r,) = run(_session(params, [lambda c: c.call_tool("read_page", {"page_id": "CMN"})]))
    assert r.content[0].text == SPEC.pages["CMN"].text


def test_mcp_json_takes_secrets_from_the_environment():
    cfg = json.loads((ROOT / ".mcp.json").read_text(encoding="utf-8"))["mcpServers"]["spec"]
    assert cfg["type"] == "stdio" and cfg["args"][-1] == "spec-review-mcp"
    assert cfg["env"][TOKEN_VAR] == "${" + TOKEN_VAR + "}"  # expanded by the client, never written here
    assert cfg["env"]["SPEC_DIR"] == "${SPEC_DIR:-spec}"


def test_sdk_options_use_the_same_config_file_and_check_by_transcript(tmp_path):
    import re

    from spec_review.mcp_check import MCP_CONFIG, RESOURCE_TOOLS, T_READ, P5Result, build_options, check

    opts = build_options({TOKEN_VAR: "x"}, tmp_path, "claude-haiku-5-5", 0.1)
    assert opts.mcp_servers == MCP_CONFIG == ROOT / ".mcp.json" and opts.strict_mcp_config
    assert opts.tools == RESOURCE_TOOLS and T_READ in opts.allowed_tools and opts.permission_mode == "dontAsk"
    page = SPEC.pages["SC-06"]
    ids = list(dict.fromkeys(re.findall(r"SC-06-[A-Z]?\d+", page.text)))
    good = P5Result(init={"mcp_servers": [{"name": "spec", "status": "connected"}]}, calls=[
        {"tool": "ReadMcpResourceTool", "input": {"server": "spec", "uri": INDEX_URI}, "is_error": False},
        {"tool": T_READ, "input": {"page_id": "SC-06"}, "is_error": False},
        {"tool": T_READ, "input": {"page_id": "SC-13"}, "is_error": True}],
        answer={"index_pages": 14, "sc06_title": page.title, "sc06_item_ids": ids, "sc13_error": "... SC-12 ..."})
    assert check(good, SPEC)["passed"] == 8
    told_not_shown = P5Result(init=good.init, calls=good.calls[:2], answer=good.answer)  # claims the error, never called
    c = check(told_not_shown, SPEC)["checks"]
    assert not c["sc13_is_error"] and c["sc13_error_names_valid_ids"]
