"""Part 5: an MCP server that serves the specification over stdio.

One tool, `read_page`, returns a page's markdown; an unknown page is an `isError` result that names the valid IDs, so
the model can correct itself. One resource, `spec://index`, lists the pages with their titles, item counts and the
spec's hash: the map a client reads before it asks for a page.

Configuration comes from the environment, which `.mcp.json` fills with `${VAR}` expansion:

- `SPEC_SERVER_TOKEN` (required): a stand-in for the upstream credential a real spec server needs (a wiki or tracker
  API token). This server only checks that it is set and never prints it; the point is that the secret lives in the
  shell environment, never in `.mcp.json`.
- `SPEC_DIR` (optional): the folder of page files, default `spec/` in this project.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from .sdk_agent import normalise_id
from .spec import SPEC_DIR, ID_PATTERN, Spec, load_spec

TOKEN_VAR = "SPEC_SERVER_TOKEN"
INDEX_URI = "spec://index"

READ_PAGE_DESCRIPTION = (
    "Return the full markdown text of one page of the specification. Call it with a page ID from the index resource "
    f"({INDEX_URI}): OVR (overview, roles, glossary), CMN (common rules), SC-01 to SC-12 (screens). Quote the spec "
    "from this text, never from memory or a summary. An unknown ID returns an error that lists the valid IDs."
)


def spec_hash(spec: Spec) -> str:
    h = hashlib.sha256()
    for page in spec.pages.values():
        h.update(page.page_id.encode() + b"\0" + page.text.encode("utf-8") + b"\0")
    return h.hexdigest()[:12]


def index(spec: Spec) -> dict:
    return {"spec_hash": spec_hash(spec),
            "pages": [{"page_id": p.page_id, "title": p.title, "item_ids": len(set(ID_PATTERN.findall(p.text))),
                       "chars": len(p.text)} for p in spec.pages.values()]}


def build_server(spec: Spec) -> MCPServer:
    server = MCPServer("spec-review", version="0.1.0",
                       instructions=f"Read {INDEX_URI} first for the page list, then read pages with read_page.")

    @server.tool(description=READ_PAGE_DESCRIPTION,
                 annotations=ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False))
    def read_page(page_id: str) -> str:
        page = spec.pages.get(normalise_id(page_id))
        if page is None:
            # ToolError becomes a CallToolResult with is_error=True: the model reads it and can retry with a valid ID.
            # Any other exception would reach the model only as "Error executing tool read_page".
            raise ToolError(f"Unknown page ID {page_id!r}. Valid page IDs: {', '.join(spec.page_ids)}. "
                            f"Titles are in the resource {INDEX_URI}.")
        return page.text

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
    build_server(spec).run("stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
