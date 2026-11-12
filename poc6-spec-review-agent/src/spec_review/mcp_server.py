"""Part 5: an MCP server that serves the specification over stdio.

One tool, `read_page`, returns a page's markdown; an unknown page is an `isError` result that names the valid IDs, so
the model can correct itself. One resource, `spec://index`, lists the pages with their titles, item counts and the
spec's hash: the map a client reads before it asks for a page.

Part 7 (A1) makes the errors structured (`tool_errors.py`): every error carries `errorCategory` and `isRetryable`, as
JSON text and as `structuredContent`. `read_page` returns `validation` for an unknown ID, `permission` for a page
outside `SPEC_SERVER_SCOPE`, `transient` when the page store fails. A second tool, `search_spec`, shows the other half
of the pattern: a search that ran and matched nothing is a success with `count: 0`, never an error.

Configuration comes from the environment, which `.mcp.json` fills with `${VAR}` expansion:

- `SPEC_SERVER_TOKEN` (required): a stand-in for the upstream credential a real spec server needs (a wiki or tracker
  API token). This server only checks that it is set and never prints it; the point is that the secret lives in the
  shell environment, never in `.mcp.json`.
- `SPEC_DIR` (optional): the folder of page files, default `spec/` in this project.
- `SPEC_SERVER_SCOPE` (optional, part 7): comma-separated page IDs this token may read, as an upstream permission
  would limit them; unset means every page.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

from typing import Callable

from mcp.server.mcpserver import MCPServer
from mcp.types import CallToolResult, TextContent, ToolAnnotations

from .notes import search_spec as grep_spec
from .sdk_agent import normalise_id
from .spec import SPEC_DIR, ID_PATTERN, Spec, load_spec
from .tool_errors import error_payload

TOKEN_VAR = "SPEC_SERVER_TOKEN"
SCOPE_VAR = "SPEC_SERVER_SCOPE"
INDEX_URI = "spec://index"

READ_PAGE_DESCRIPTION = (
    "Return the full markdown text of one page of the specification. Call it with a page ID from the index resource "
    f"({INDEX_URI}): OVR (overview, roles, glossary), CMN (common rules), SC-01 to SC-12 (screens). Quote the spec "
    "from this text, never from memory or a summary. Errors are JSON with errorCategory and isRetryable: "
    "validation (unknown ID: fix the ID, the error lists the valid ones), permission (outside this token's scope: do "
    "not retry, report it), transient (the store failed: retry once)."
)

SEARCH_DESCRIPTION = (
    "Search every page the token may read with a regular expression (Python syntax). Returns JSON: pattern, count, "
    "matches as PAGE:line: text (at most 40), truncated. count 0 means the search ran and nothing matched: that is a "
    "valid answer, not a failure. An invalid pattern is a validation error."
)


def _ok(text: str, structured: dict | None = None) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], structured_content=structured)


def _error(category: str, message: str, **detail) -> CallToolResult:
    payload = error_payload(category, message, **detail)
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
                          structured_content=payload, is_error=True)


def spec_hash(spec: Spec) -> str:
    h = hashlib.sha256()
    for page in spec.pages.values():
        h.update(page.page_id.encode() + b"\0" + page.text.encode("utf-8") + b"\0")
    return h.hexdigest()[:12]


def index(spec: Spec) -> dict:
    return {"spec_hash": spec_hash(spec),
            "pages": [{"page_id": p.page_id, "title": p.title, "item_ids": len(set(ID_PATTERN.findall(p.text))),
                       "chars": len(p.text)} for p in spec.pages.values()]}


def build_server(spec: Spec, scope: set[str] | None = None,
                 reader: Callable[[str], str] | None = None) -> MCPServer:
    """`scope`: the page IDs this token may read (None: all). `reader`: the page store, replaceable in tests to make
    it fail; by default the pages loaded at start."""
    server = MCPServer("spec-review", version="0.2.0",
                       instructions=f"Read {INDEX_URI} first for the page list, then read pages with read_page.")
    read = reader or (lambda pid: spec.pages[pid].text)
    readable = [p for p in spec.page_ids if scope is None or p in scope]
    ro = ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False)

    @server.tool(description=READ_PAGE_DESCRIPTION, annotations=ro)
    def read_page(page_id: str) -> CallToolResult:
        # A returned CallToolResult goes to the client as it is. A raised ToolError would also become is_error, but
        # only as text: the category and the retry flag would be prose for the model to guess from.
        pid = normalise_id(page_id)
        if pid not in spec.pages:
            return _error("validation", f"Unknown page ID {page_id!r}. Use one of the valid page IDs; titles are in "
                          f"the resource {INDEX_URI}.", valid_page_ids=readable)
        if pid not in readable:
            return _error("permission", f"The page {pid} exists but this server's token may not read it. Do not "
                          "retry; report that the page could not be read.", page_id=pid)
        try:
            return _ok(read(pid))
        except (OSError, TimeoutError) as exc:
            return _error("transient", f"The page store failed while reading {pid} ({type(exc).__name__}). Retry "
                          "the same call once.", page_id=pid, retryAfterSeconds=1)

    @server.tool(description=SEARCH_DESCRIPTION, annotations=ro)
    def search_spec(pattern: str) -> CallToolResult:
        visible = spec if scope is None else Spec(pages={p: spec.pages[p] for p in readable})
        lines, err = grep_spec(visible, pattern)
        if err:
            return _error("validation", f"{err}. Fix the pattern; nothing was searched.", pattern=pattern)
        truncated = bool(lines) and lines[-1].startswith("... ")
        matches = lines[:-1] if truncated else lines
        data = {"pattern": pattern, "count": len(matches), "matches": matches, "truncated": truncated,
                "pages_searched": len(readable)}
        return _ok(json.dumps(data, ensure_ascii=False), data)

    @server.resource(INDEX_URI, name="index", title="Specification index", mime_type="application/json",
                     description="Every page of the specification: ID, title, number of item IDs, length, spec hash.")
    def spec_index() -> str:
        return json.dumps(index(spec), ensure_ascii=False, indent=1)

    return server


def main() -> int:
    if not os.environ.get(TOKEN_VAR):
        # stdout carries the protocol, so diagnostics go to stderr.
        print(f"{TOKEN_VAR} is not set. Export it in the shell; .mcp.json reads it as ${{{TOKEN_VAR}}}.", file=sys.stderr)
        return 2
    spec_dir = Path(os.environ.get("SPEC_DIR") or SPEC_DIR).expanduser()
    spec = load_spec(spec_dir)
    if not spec.pages:
        print(f"No page files in {spec_dir}.", file=sys.stderr)
        return 2
    scope = {normalise_id(x) for x in os.environ.get(SCOPE_VAR, "").split(",") if x.strip()} or None
    build_server(spec, scope=scope).run("stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
