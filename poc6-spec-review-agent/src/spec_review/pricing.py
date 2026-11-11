"""US dollars per million tokens. Source: the claude-api skill model table, read 2026-11-11.
Check https://platform.claude.com/docs/en/about-claude/pricing before relying on a figure."""

from __future__ import annotations

from typing import Any

# input, output, cache write (5 minutes), cache read
PRICES = {
    "claude-sonnet-5-5": (2.00, 10.00, 2.50, 0.10),
    "claude-opus-5-5": (4.00, 20.00, 5.00, 0.20),
    # Haiku 5.5 prices for prompts of 100K tokens or fewer; above that it is 0.50 / 2.50.
    "claude-haiku-5-5": (0.10, 0.50, 0.125, 0.01),
}


def usage_dict(usage: Any) -> dict[str, int]:
    get = (lambda k: usage.get(k)) if isinstance(usage, dict) else (lambda k: getattr(usage, k, None))
    return {
        "input_tokens": get("input_tokens") or 0,
        "output_tokens": get("output_tokens") or 0,
        "cache_creation_input_tokens": get("cache_creation_input_tokens") or 0,
        "cache_read_input_tokens": get("cache_read_input_tokens") or 0,
    }


def cost_usd(model: str, usage: dict[str, int]) -> float:
    inp, out, cw, cr = PRICES[model]
    if model == "claude-haiku-5-5":
        prompt = usage["input_tokens"] + usage["cache_creation_input_tokens"] + usage["cache_read_input_tokens"]
        if prompt > 100_000:
            inp, out, cw, cr = 0.50, 2.50, 0.625, 0.05
    return (
        usage["input_tokens"] * inp
        + usage["output_tokens"] * out
        + usage["cache_creation_input_tokens"] * cw
        + usage["cache_read_input_tokens"] * cr
    ) / 1_000_000
