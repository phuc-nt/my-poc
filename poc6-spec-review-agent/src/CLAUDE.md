# Code under src/

Rule tag: P6-SRC-DIR

- Python 3.11+, run with `uv run`. Every module starts with a docstring that says which part of the PoC it serves.
- The scorer and the validators are code, never a model: a self-reported result is not a verified result.
- A change to a schema, a prompt or a scorer needs an offline test in `tests/` before any billed run.
