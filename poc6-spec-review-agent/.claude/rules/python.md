---
paths:
  - "src/**/*.py"
  - "tests/**/*.py"
---

# Python files

Rule tag: P6-RULE-PY

- Tests are offline: a fake client, never the network. Run `uv run pytest -q` after a change.
- Money is counted from `usage` with `pricing.py`, and every billed run appends one line to `runs/ledger.jsonl`.
