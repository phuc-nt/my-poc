# Handover: PoC 6, a spec review agent as the case study for the Claude Certified Architect exam (2026-11-11)

Read this first. It was written in a session of the `my-agent-cloud` repository, where the owner's study plan was
compared with their own agent product, so that a session in this repository can start the PoC. Nothing is built yet:
this folder holds only this file. No code, no API key, no data.

## 1. Why this PoC

- **The owner's goal:** pass the Claude Certified Architect – Foundations exam, target date around 2026-12-22, with
  8 to 10 study hours a week over six weeks (2026-11-12 to 2026-12-22).
- **Why a PoC:** the exam is scenario questions about architecture decisions. The owner's plan is to build one small
  system that touches all five domains instead of reading only.
- **Why not the owner's existing product:** the owner already runs a personal agent product (the engine
  `my-agent-crew` and its cloud deployment `my-agent-cloud`). A check of its code on 2026-11-11 showed it covers the
  thinking of about half the exam and none of the two weakest areas (section 3). This PoC fills what it lacks and
  reads it as a reference where it is strong (section 5).

## 2. What the exam covers

**Corrected on 2026-11-11** from the official FAQ and community copies of the exam guide (the guide itself sits
behind the Partner Academy sign-in and was not read). Every task statement and the part that practises it:
[docs/study-map.md](docs/study-map.md).

| Domain | Weight | Task statements |
|---|---|---|
| D1 Agentic Architecture & Orchestration | 27% | 1.1 agentic loops, 1.2 coordinator and subagents, 1.3 subagent invocation and context passing, 1.4 multi-step workflows with enforcement and handoff, 1.5 Agent SDK hooks, 1.6 task decomposition, 1.7 session state, resumption and forking |
| D2 Tool Design & MCP Integration | 18% | 2.1 tool interfaces and descriptions, 2.2 structured MCP error responses, 2.3 distributing tools and tool choice, 2.4 MCP servers in Claude Code and agents, 2.5 built-in tools |
| D3 Claude Code Configuration & Workflows | 20% | 3.1 `CLAUDE.md` hierarchy, 3.2 slash commands and skills, 3.3 path-specific rules, 3.4 plan mode against direct execution, 3.5 iterative refinement, 3.6 CI/CD |
| D4 Prompt Engineering & Structured Output | 20% | 4.1 explicit criteria against false positives, 4.2 few-shot, 4.3 structured output through tool use and JSON schemas, 4.4 validation, retry and feedback, 4.5 batch processing, 4.6 multi-instance and multi-pass review |
| D5 Context Management & Reliability | 15% | 5.1 preserving critical information, 5.2 escalation and ambiguity, 5.3 error propagation in multi-agent systems, 5.4 large codebase exploration, 5.5 human review and confidence calibration, 5.6 provenance and uncertainty |

Official (Partner Academy FAQ): 120 minutes, a scaled score of 720 of 1000 to pass, valid 12 months, USD 125 since
2026-06-30, a partner company email, booked through Pearson. From the community copies, unverified: exam code CCAR-F,
guide v1.0 effective July 2026, 60 questions, 4 of these 6 scenarios drawn per sitting: Customer Support Resolution
Agent, Code Generation with Claude Code, Multi-Agent Research System, Developer Productivity with Claude, Claude Code
for CI/CD, Structured Data Extraction.

Links from the plan: [Partner Academy FAQ](https://anthropic-partners.skilljar.com/page/faq-certifications),
[Anthropic Academy](https://anthropic.skilljar.com/), [Claude documentation](https://docs.claude.com),
[MCP specification](https://modelcontextprotocol.io). Third-party, for practice questions only:
[Claude Certification Guide](https://claudecertificationguide.com/learn),
[Tutorials Dojo](https://tutorialsdojo.com/ccar-f-claude-certified-architect-foundations-study-guide/),
[CloudThat](https://www.cloudthat.com/resources/?p=78361).

## 3. What the owner's product covers, and what it does not

Measured by grep over the engine's code (`my-agent-crew`, version 0.39.0) on 2026-11-11.

| Domain | The product has | The product lacks |
|---|---|---|
| Agentic Architecture | Its own tool loop, a `delegate` tool (the subagent model), approvals with a time limit, scheduled jobs | The Claude Agent SDK: 0 files. `stop_reason` is handled in 1 file; the engine calls Anthropic over raw HTTP, not the SDK |
| Context Management | Trimming of old tool outputs, spilling large outputs to disk, session summaries, facts and memory kept outside the context, the 1-hour prompt cache | Claude Code's own commands (`/compact`) |
| Tool Design & MCP | A full MCP **client**: OAuth, tool search, result limits, `isError` handling | It is not an MCP server and uses no resources or prompts: 0 files. No `.mcp.json` |
| Structured Output | JSON schemas for its tools | No forced `tool_choice`, no validate and retry loop: 0 files for both. **The largest gap** |
| Claude Code | Nothing in the product. The engine's repository has a `.claude/` folder (rules, hooks, agents, skills, `settings.json`) | Headless runs with `--output-format json`; the user, project and directory levels read as a system |

So this PoC must weigh, in this order: structured output, the Agent SDK, the MCP server side, Claude Code
configuration. Context management and loop design are learned mostly by reading the product.

## 4. Proposed scope (the owner's plan, cut down: the owner has not confirmed the cuts)

**The story:** an agent that reviews a Japanese specification (仕様書) and writes the question list (質問表) a bridge
engineer would send to the customer.

- **Input:** a specification in markdown files (later, pages read through an MCP server).
- **Output:** the question list as JSON and Excel. Each row: the place in the specification, the kind of problem
  (missing, contradictory, ambiguous), the severity, and the question written in Japanese.

**The parts, in the order of the gaps:**

| Part | Domain | Study week |
|---|---|---|
| A hand-written loop on the Messages API: `tool_use` and `end_turn`, the other stop reasons, a step limit | Agentic | 2 |
| The same slice on the Claude Agent SDK: one orchestrator, one read-only subagent per screen of the specification, `allowedTools`, a `PostToolUse` hook, a stop for human approval on "critical" questions | Agentic | 2 to 3 |
| A summary per chapter and a glossary written to a file instead of kept in the context | Context | 3 |
| The 質問表 schema forced through `tool_use`, nullable fields for what the specification does not say, Pydantic validation, a retry that sends the error back; a test set where 100% of outputs are valid. **Corrected:** forced `tool_choice` returns a 400 on Sonnet 5.5 and Opus 5.5; practise it on Haiku 5.5 and compare with `strict` tools and `output_config.format` on Sonnet 5.5 | Structured Output | 4 |
| An MCP server that serves the specification: one tool, one resource, `isError` for a missing page; `.mcp.json` at project scope with secrets from environment variables | MCP | 5 |
| `CLAUDE.md` at several levels, `.claude/rules` by path, one slash command, one hook that blocks writing secret files, one headless run with `--output-format json` | Claude Code | 5 |

**Cut from the owner's plan, to fit the hours:** writing the agent twice in full. Write the hand loop once, small,
then move one slice to the SDK and compare the two; the comparison is what fixes the SDK's names in memory. The
owner's `mcp-atlassian-server` can stand in for a new MCP server if it is at hand: add a resource to it.

**Record per part:** the exam objective it practises, the decision taken, and one "why not the other option" note.
The exam asks for the trade-off, so the note is the study material.

## 5. What to read in the owner's product

The two repositories are private and sit beside this one on the owner's machine (`../my-agent-crew`,
`../my-agent-cloud`). Read them; do not copy code out of them into this repository and do not change them.

| Topic | Where | What to take |
|---|---|---|
| The tool loop | `my_agent_crew/agent/loop.py`, `loop_guard.py`, `step_limit.py`, `tool_batches.py` | One loop for chat, Telegram and jobs; a step limit; parallel tool calls in one batch |
| The Anthropic wire | `my_agent_crew/llm/anthropic_wire.py`, `anthropic_stream.py`, `anthropic_errors.py` | Where `stop_reason` and `cache_control` are handled; streaming; what happens when credit runs out |
| Subagents | `my_agent_crew/tools/delegate.py`, `delegate_outcome.py`, `agent/child_wrap_up.py` | A child has a fresh context and returns one final message; the parent waits with a timeout; one level only |
| Human approval | `my_agent_crew/agent/tool_gate.py`, `approval_expiry.py` | Approval as a stored row with a 600-second limit; a policy of "only sends and deletes ask" |
| Context | `my_agent_crew/agent/context_trim.py`, `payload_trim.py`, `memory/session_summary.py`, `memory/fact_*.py` | Keep the last 20 tool outputs, spill the rest to disk, facts and summaries outside the context |
| MCP client | `my_agent_crew/mcp/tool_result.py`, `tool_search.py`, `tool_limits.py`, `schema_fold.py`, `oauth.py` | How a client treats `isError`, large results and many tools: the other side of what the PoC's server returns |
| Claude Code configuration | The engine's `CLAUDE.md`, `CLAUDE.local.md` and `.claude/` (`rules/`, `hooks/hooks.json`, `agents/`, `settings.json`) | A real project's rules by path, hooks and subagent definitions to read before writing the PoC's own |
| Design documents | The engine's `docs/system-architecture.md`, `docs/tools.md`, `docs/memory.md`; the cloud's `docs/04-decisions.md` | The reasons behind each choice, in Vietnamese |
| Harness comparison | The cloud's `reports/Đề xuất từ các agent harness.md` | How Claude Code, the Agent SDK and other harnesses solve the same problems, with sources |

**Lessons the product already paid for:**

- **A self-reported result is not a verified result.** A job that says "done" only means the turn ended. The product
  is adding a deterministic check per job. In the PoC: validate the output in code, never by asking the model.
- **State in memory is lost on restart.** Counters and approval records belong in a store.
- **A subagent's answer is untrusted text to its parent,** like a web page. A review on 2026-11-11 found the product
  passes it in without a fence.
- **Autonomy needs a list of what still asks.** The same review found calls that send data out without asking
  (shell with network, URL fetch). Decide the PoC's list before the first run.
- **A denied call gets repeated.** The model re-issues the same call after a denial unless code stops it.

**Where the product differs from Anthropic's way on purpose.** The exam asks for Anthropic's way: answer from the
official documentation, not from the product's habits.

- It does not use the Agent SDK or the official Anthropic SDK; it has its own loop and raw HTTP.
- It trims and summarises the context itself instead of using the platform's features.
- Its approvals are rows in a database, not the SDK's permission modes or hooks.
- It never forces a schema with `tool_choice`.

## 6. To verify before building

None of these was checked in the session that wrote this file.

- **The official exam guide:** domains, weights, the six scenario groups, the required courses, validity.
- **The engine rule of this repository:** `CLAUDE.md` says Claude Code on the subscription is the engine for AIPF PoC
  runs, and a run on an API key needs the owner's approval with the expected cost. This PoC cannot avoid the Messages
  API (the hand loop, forced `tool_use`). Ask once for an approval that covers the PoC, with a budget. Check whether
  the Agent SDK can run on the subscription or needs an API key.
- **Current API shapes:** read the documentation before writing; do not write from memory. Known drift: on current
  models extended thinking is `thinking: {type: "adaptive"}` and `budget_tokens` is rejected; model ids are
  `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`. The plan's item "try extended thinking and compare cost"
  must use the current form. Check also whether structured outputs now have a dedicated feature beside forced
  `tool_use`, and which one the exam guide asks for.
- **The specification to review:** it must be synthetic or public. Write one for the PoC (10 to 20 screens, with
  planted omissions and contradictions, so the output can be scored against a known answer list).

## 7. First steps

1. Read the official exam guide; write a study map with one row per objective and the part of the PoC that practises
   it. Correct sections 2 and 4 from it.
2. Check the points of section 6 and put the open decisions of section 8 to the owner in one message.
3. Write this folder's `README.md`, and add PoC 6 to the root [README](../README.md) (PoC 5 is not listed there yet
   either).
4. Write the synthetic specification and its answer list first: every later part is measured on it.
5. Build in the order of section 4. After each part, record the decision notes and what was measured (valid-output
   rate, planted problems found, tokens, cost, time).
6. In the last study week the PoC stops; the owner works practice exams.

## 8. Open decisions for the owner

**Decided on 2026-11-11:** an API key with a USD 30 cap for all parts (the Agent SDK runs on the same key), Python, a
new small MCP server in this folder, the cuts of section 4 kept, no demo polish. Details:
[docs/decisions.md](docs/decisions.md). The questions as first asked:

- Confirm or change the cuts of section 4.
- An API key and a budget for the PoC (section 6), or a way to stay on the subscription.
- A new small MCP server, or a resource added to `mcp-atlassian-server`.
- Python (the plan names Pydantic) or TypeScript for the Agent SDK part.
- Whether the PoC is later shown at work as a demo: that changes how much polish it gets, and it must still hold no
  customer document.

## 9. Rules

- **No customer material.** No specification, screenshot or term from a real customer or project goes into this
  folder, a prompt or a test, whatever the confidentiality agreement allows elsewhere. Synthetic or public only.
- **Credentials and personal data:** never print or commit an API key, an email, a real name or the employer's name.
  Keep keys in `.env` (ignored); show key names only. Never read the `.env*` or `env` files of the two product
  repositories or their `environments/` folders.
- **Before a commit:** grep the added lines for keys, tokens, emails and names. Public documentation URLs are fine.
- **Commits:** follow the flow the PoC 5 handover points to (`aipf-sdlc/environments/poc/HANDOVER.md`, section 6).
  Commit and push only when the owner asks.
- **Paid usage:** anything billed needs the owner's approval first, with the expected cost.
- **Working with the owner:** reply in Vietnamese, with English for component names and IT terms. Help level LOW
  (`CLAUDE.md`). Documents in this repository are in English.
