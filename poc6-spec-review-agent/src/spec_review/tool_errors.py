"""Part 7 (A1): one shape for every tool error, so an agent can decide what to do next without reading prose.

A bare `isError` with a sentence tells the model that something failed, not whether to retry, fix the input, stop or
hand the case to a person. Every error here carries:

- `errorCategory`: `transient` (the backend timed out; the same call may work), `validation` (the input is wrong; fix
  it, never repeat it), `business` (the input is valid but a rule forbids the action; do not retry, escalate or
  report), `permission` (this caller may not do it; do not retry).
- `isRetryable`: true only for transient errors, unless the caller says otherwise.
- `message`: what happened and what to do, written for the model.

An empty result is not an error: a search that ran and found nothing returns `count: 0` with `isError` false. The two
must never look alike, or an agent treats "the backend failed" as "there is nothing" and reports a gap that is not
there.
"""

from __future__ import annotations

import json
from typing import Any

CATEGORIES = ("transient", "validation", "business", "permission")


def error_payload(category: str, message: str, *, retryable: bool | None = None, **detail: Any) -> dict[str, Any]:
    if category not in CATEGORIES:
        raise ValueError(f"unknown error category {category!r}")
    return {"errorCategory": category, "isRetryable": category == "transient" if retryable is None else retryable,
            "message": message, **detail}


def sdk_error(category: str, message: str, **kw: Any) -> dict[str, Any]:
    """The error as an Agent SDK in-process tool result."""
    return {"content": [{"type": "text", "text": json.dumps(error_payload(category, message, **kw), ensure_ascii=False)}],
            "is_error": True}


def sdk_ok(data: Any) -> dict[str, Any]:
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    return {"content": [{"type": "text", "text": text}]}


def parse_error(text: str) -> dict[str, Any] | None:
    """The payload back from a result text, or None when the text is not one of these errors."""
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("errorCategory") in CATEGORIES else None
