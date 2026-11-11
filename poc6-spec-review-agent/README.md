# PoC 6: Spec Review Agent

A small agent that reads a Japanese screen specification (仕様書) and writes the question list (質問表) a bridge
engineer sends back to the customer: one row per problem, with its place in the spec, its kind (missing,
contradiction, ambiguous), its severity and a question in Japanese. Output is JSON and Excel.

It is the case study for the Claude Certified Architect – Foundations exam (target around 2026-12-22). Each part of the
PoC practises a group of exam objectives; [docs/study-map.md](docs/study-map.md) maps every objective to a part.

The specification is **synthetic**: a fictional equipment lending system with 23 planted problems and 5 traps, so
every run is scored by code against a known answer list. No customer material is used anywhere.

## Status

| Part | What | Status |
|---|---|---|
| P1 | Hand-written loop on the Messages API | Done: 3 billed runs, valid 3 of 3, recall 16 to 21 of 23, USD 0.10 a run |
| P2 | Claude Agent SDK: orchestrator, subagent per screen, hooks, human approval | Done: 4 runs and a fork, recall 22 to 23 of 23, USD 0.55 a run |
| P3 | Page summaries and glossary in files, read back; grep over the spec | Done: notes USD 0.016, 2 runs, recall 20 and 23 of 23, USD 0.58 a run; no saving on this table-shaped spec |
| P4 | Schema forcing compared (forced `tool_use` on Haiku 5.5, strict tools, `output_config.format`), retry, test set | Done: 8 runs of 12 cases, all 12 of 12 valid after at most one retry; Sonnet found 22 of 23 (the most this set allows) for USD 0.19 (0.10 in a batch), Haiku 19 to 21 for USD 0.015 |
| P5 | MCP server for the spec (one tool, one resource, `isError`, secrets from the environment) | Done: 8 of 8 checks from an Agent SDK session configured by `.mcp.json`, USD 0.001 |
| P6 | Claude Code configuration (CLAUDE.md levels, path rules, a command, a skill, a secret-file hook) and a headless run | Done: `claude -p` with `--output-format json` parsed by a script, 7 of 7 checks in 3 runs, the right rules loaded and no others, both SC-01 problems found; the hook blocked a secret file on the third probe; USD 0.011 |

Decisions, trade-offs and measurements per part: [docs/decisions.md](docs/decisions.md). The brief this PoC started
from: [HANDOVER.md](HANDOVER.md).

## Layout

| Path | What |
|---|---|
| `CLAUDE.md`, `src/CLAUDE.md` | P6: project and directory instructions, each with a rule tag |
| `.claude/` | P6: `rules/` (path rules for `spec/` and `src/`), `commands/review-spec.md`, `skills/score-questions/`, `settings.json` (deny list and the hook), `hooks/block_secret_files.py` |
| `.mcp.json` | P5: the spec MCP server for Claude Code and the Agent SDK; the token comes from `${SPEC_SERVER_TOKEN}` |
| `notes/` | P3 working notes built from the spec by `spec-review notes`: `summaries/<page>.md`, `glossary.md`, `manifest.json` (spec hash, facts lost, cost) |
| `spec/` | The synthetic specification: `OVR` (overview, roles, glossary), `CMN` (common rules, role matrix, messages, mails), `SC-01` to `SC-12` (screens) |
| `eval/answers.json` | The planted problems with their anchor IDs, kind and severity, and the non-issues |
| `src/spec_review/` | `spec.py` (loader and ID index), `schema.py` (Pydantic and strict JSON Schema), `score.py` (deterministic scorer), `prompts.py`, `loop.py` (P1), `fake_client.py` (offline script), `sdk_agent.py` (P2 and the notes mode of P3: coordinator, subagents, hooks, approval stop), `notes.py` (P3 notes, fact check, grep), `extract.py` (P4: one request per screen in five output modes, validation with the quote check, retry, batches), `mcp_server.py` (P5: the stdio MCP server), `mcp_check.py` (P5: the SDK session that uses it and the checks), `headless.py` (P6: the `claude -p` command, output parsing and checks), `export.py` (Excel), `cli.py` |
| `tests/` | Offline tests: schema limits, validation, scorer, every stop reason, the step limit (P1); tools, hooks, gate, approval stop, state file (P2); fact check, retry, fallback, grep, notes mode, context sizes (P3); request shape per mode, quote check, retry per failure kind, batches, budget stop (P4); the MCP tool, error result, resource, stdio start-up and config (P5); config files and tags, command and skill, hook wiring and blocking, the headless command and parsing (P6) |
| `runs/` | One folder per run. P1: `steps.jsonl` (tokens and cost per step), `transcript.json`. P2 and P3: `transcript.jsonl` (every SDK message), `events.jsonl` (hook and tool events), `state.json` (hook state for a resume), `subagent_findings.json`. P4: `cases.jsonl` (each attempt per screen: stop reason, problem, errors, thinking, tokens, cost), `cases.json` (each screen's final answer). P5: `transcript.jsonl`. P6: `output.json` and `hook_output.json` (the `claude -p` result objects). All: `question_list.json`, `質問表.xlsx`, `summary.json`. `ledger.jsonl` holds the cost of every billed run. Not in git |

## Commands

Run from this folder. Needs [uv](https://docs.astral.sh/uv/).

```sh
uv sync
uv run pytest -q                         # offline tests
uv run spec-review index                 # pages, ID counts, IDs referenced but not defined, money spent
uv run spec-review run --dry-run         # the whole loop on a scripted fake client: no network, no cost
uv run spec-review run                   # billed: Claude Sonnet 5.5, effort medium, 25 steps at most
uv run spec-review p2 --approval accept   # billed: coordinator and 12 subagents on the Agent SDK, about USD 0.55
uv run spec-review p2                     # the same, critical questions approved on the terminal (600 s, else reject)
uv run spec-review p2 --resume <run> --fork --prompt "..."   # branch a new session from an earlier run
uv run spec-review notes                  # billed, about USD 0.02: build notes/ (skipped while the spec is unchanged)
uv run spec-review p3 --approval accept   # billed: the P2 review working from notes/ and grep, about USD 0.58
uv run spec-review p4 --mode sonnet-format          # billed, about USD 0.19: the 12-screen test set, one request each
uv run spec-review p4 --mode haiku-forced           # about USD 0.015; modes: haiku-forced, haiku-forced-loose, haiku-format, sonnet-strict, sonnet-format
uv run spec-review p4 --mode sonnet-format --few-shot --batch   # with the worked examples; first attempts through Message Batches
uv run spec-review p5                     # billed, about USD 0.001: an Agent SDK session uses the MCP server via .mcp.json
uv run spec-review-mcp                    # the MCP server on stdio (needs SPEC_SERVER_TOKEN in the environment)
uv run spec-review p6 --hook-probe        # billed, under USD 0.01: /review-spec SC-01 headless with claude -p, then the hook probe
uv run spec-review score runs/<run>/question_list.json
```

Before a billed run, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. `SPEC_REVIEW_BUDGET_USD` (default 30)
is the cap over all billed runs: the CLI refuses to start when the ledger reaches it, and a run stops when its own cost
reaches what is left.
`p6` also needs the Claude Code CLI (`claude`) on PATH; it runs with the API key from `.env`, never the subscription
login, and passes only PATH, HOME, TMPDIR, LANG, the key and the server token to it.

## Rules

- Synthetic or public material only. No specification, screenshot or term from a real customer or project.
- The API key stays in `.env`, which git ignores. Show key names only.
- Billed runs stay inside the budget the owner approved (USD 30 for this PoC, API key, all parts). Any other paid use
  needs a new approval.
