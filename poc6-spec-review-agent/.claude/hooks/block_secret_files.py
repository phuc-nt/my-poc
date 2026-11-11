#!/usr/bin/env python3
"""Part 6: a PreToolUse hook that blocks writing a secret file (.env, keys, credentials).

Claude Code sends the tool call as JSON on stdin. Exit 2 blocks the call, and the text on stderr goes to the model as
the reason. Any other failure exits 0 (the call goes on): a broken guard must not stop all work, and the git ignore
rules and the deny list stay behind it. The hook looks at paths only; it never opens a file.

Covered: Write, Edit, MultiEdit, NotebookEdit by path, and Bash commands that redirect (>, >>), tee, cp, mv, install,
touch, ln, dd of= or sed -i into such a file. A guard against mistakes, not a sandbox: an obfuscated command passes.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shlex
import sys

ALLOWED = {".env.example", ".env.sample", ".env.template"}
SECRET = [".env", ".env.*", "*.env", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "id_ecdsa*",
          "credentials", "credentials.*", ".netrc", ".pgpass"]
WRITERS = {"tee", "cp", "mv", "install", "touch", "ln"}


def is_secret(path: str) -> bool:
    name = os.path.basename(path.strip().strip("'\""))
    return bool(name) and name not in ALLOWED and any(fnmatch.fnmatch(name, p) for p in SECRET)


def bash_targets(command: str) -> list[str]:
    """Paths a command may write: redirect targets and the file arguments of common writers."""
    targets = re.findall(r"(?:^|[^<0-9&])\d?>>?\|?\s*([^\s;&|<>]+)", command)
    targets += re.findall(r"\bof=([^\s;&|]+)", command)
    for part in re.split(r"[;&|]+", command):
        try:
            words = shlex.split(part)
        except ValueError:
            words = part.split()
        if not words:
            continue
        tool = os.path.basename(words[0])
        args = [w for w in words[1:] if not w.startswith("-")]
        if tool in WRITERS:
            targets += args
        elif tool == "sed" and any(w.startswith("-i") or w == "--in-place" for w in words[1:]):
            targets += args[1:]
    return targets


def blocked(call: dict) -> str | None:
    tool, inp = call.get("tool_name", ""), call.get("tool_input") or {}
    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        path = inp.get("file_path") or inp.get("notebook_path") or ""
        return path if is_secret(path) else None
    if tool == "Bash":
        return next((t for t in bash_targets(inp.get("command", "")) if is_secret(t)), None)
    return None


def main() -> int:
    try:
        call = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    path = blocked(call)
    if path is None:
        return 0
    print(f"Blocked by the project hook: {os.path.basename(path)!r} is a secret file (keys, tokens, credentials). "
          "The owner edits it by hand; do not write it another way. Put a key name in .env.example instead.",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
