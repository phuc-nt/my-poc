# PoC 6 project instructions

Rule tag: P6-PROJECT

This folder is a study PoC: an agent that reviews a synthetic Japanese screen specification (`spec/`) and writes the
question list (質問表). The answer list is `eval/answers.json`; read [README.md](README.md) for the commands.

- Synthetic or public material only. No specification, screenshot or term from a real customer or project.
- Never read, print or write `.env` or any other secret file; a hook blocks writing them. Show key names only.
- Anything billed (a command that calls the API) needs the owner's approval and stays inside the budget in `.env`
  (`SPEC_REVIEW_BUDGET_USD`). `uv run pytest -q` and `--dry-run` cost nothing.
- A question cites item IDs that exist in the spec, and `spec_quote` is copied exactly from a page, or null.
- Documents in this folder are in English; questions to the customer are in Japanese.
