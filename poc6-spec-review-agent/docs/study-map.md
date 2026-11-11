# Study map: exam objectives and the PoC parts that practise them

The exam is Claude Certified Architect – Foundations (exam code CCAR-F). This map has one row per task statement of the
exam guide and names the PoC part that practises it.

## Sources, and how far they can be trusted

| Fact | Source | Status |
|---|---|---|
| 120 minutes (about 135 minutes in the seat), scaled score 720 of 1000 to pass, valid 12 months, USD 125 since 2026-06-30, a partner company email needed, booked through Pearson | [Partner Academy FAQ](https://anthropic-partners.skilljar.com/page/faq-certifications) | Official |
| The exam guide itself (domains, task statements, scenarios) | Partner Academy, on each certification page, after sign-in | Official, **not read here**: it needs the owner's sign-in |
| Five domains with weights, 30 task statements, six scenarios, 60 questions with 4 of the 6 scenarios drawn per sitting, guide v1.0 effective July 2026 | Community copies of the guide, mainly [jc-aiwiki](https://jc-aiwiki.pages.dev/claude-ai/official-exam-guide), checked against [Tutorials Dojo](https://tutorialsdojo.com/ccar-f-claude-certified-architect-foundations-study-guide/) | **Unverified**: the copies agree with each other. The owner should compare this page with the guide once signed in |

## Domains

| Domain | Weight |
|---|---|
| D1 Agentic Architecture & Orchestration | 27% |
| D2 Tool Design & MCP Integration | 18% |
| D3 Claude Code Configuration & Workflows | 20% |
| D4 Prompt Engineering & Structured Output | 20% |
| D5 Context Management & Reliability | 15% |

## The PoC parts

| Part | What | Week |
|---|---|---|
| P1 | Hand-written loop on the Messages API | 2 |
| P2 | The same slice on the Claude Agent SDK: orchestrator, read-only subagent per screen, hooks, human approval | 2 to 3 |
| P3 | Chapter summaries and glossary written to files | 3 |
| P4 | 質問表 schema: forced `tool_use` vs strict tools vs `output_config.format`, validation, retry, test set at 100% valid | 4 |
| P5 | MCP server for the spec: a tool, a resource, `isError`, `.mcp.json` | 5 |
| P6 | Claude Code configuration: `CLAUDE.md` levels, `.claude/rules`, a command, a hook, a headless run | 5 |

## Task statements

"Study only" means the PoC does not build it; read the documentation and do practice questions.

| ID | Task statement | Part | What to do or look at |
|---|---|---|---|
| 1.1 | Agentic loops | **P1**, P2 | Every `stop_reason` handled in [loop.py](../src/spec_review/loop.py), a step limit, a nudge when `auto` ends without the submit call. In P2, compare how the SDK hides the same loop |
| 1.2 | Coordinator and subagent patterns | **P2** | One orchestrator, one read-only reviewer per screen |
| 1.3 | Subagent invocation and context passing | **P2**, P3 | What each subagent receives: its screen plus the CMN/OVR summary of P3, not the whole spec. Its answer is untrusted text to the parent |
| 1.4 | Multi-step workflows with enforcement and handoff | P1, **P2** | P1: the run counts only when the submit tool accepts the list. P2: a stop for human approval on "critical" questions |
| 1.5 | Agent SDK hooks for interception and normalisation | **P2**, P6 | P2: a `PostToolUse` hook that normalises item IDs. P6: a hook that blocks writing secret files |
| 1.6 | Task decomposition | **P2** | Per-screen review misses cross-page contradictions (P01, P07, P17 sit on two pages): measure it, then add a cross-page pass |
| 1.7 | Session state, resumption and forking | P2 | Add one resume of an SDK session after the approval stop, and one fork to try a second prompt from the same point |
| 2.1 | Tool interfaces and descriptions | **P1**, P5 | Tool descriptions say when to call and what an error means. Exam pattern: fix a misused tool with a clearer description, not a router |
| 2.2 | Structured MCP error responses | **P5** | `isError` with a message that names the valid page IDs |
| 2.3 | Distributing tools and tool choice | P2, **P4** | P2: `allowedTools` per subagent. P4: forced `tool_choice` on Haiku 5.5 against `auto` + `strict` on Sonnet 5.5 (see the drift note below) |
| 2.4 | MCP servers in Claude Code and agents | **P5** | One server used from Claude Code through `.mcp.json` and from the SDK agent |
| 2.5 | Built-in tools (Read, Write, Edit, Bash, Grep, Glob) | P2, P6 | Subagents get Read, Grep and Glob only |
| 3.1 | `CLAUDE.md` hierarchy | **P6** | User, project and directory levels; what loads when |
| 3.2 | Slash commands and skills | **P6** | One command (`/review-spec`) and one skill |
| 3.3 | Path-specific rules | **P6** | `.claude/rules` with `paths:` for `spec/` and `src/` |
| 3.4 | Plan mode against direct execution | Study only | Note when plan mode is the right answer |
| 3.5 | Iterative refinement | P4, P6 | The retry loop; refining a prompt against the scorer |
| 3.6 | CI/CD | **P6** | One headless run with `-p --output-format json`, its result parsed by a script. A pipeline file is study only |
| 4.1 | Explicit criteria to reduce false positives | **P1**, P4 | Measurable definitions of kind and severity in [prompts.py](../src/spec_review/prompts.py). The non-issues N01 to N05 measure false positives |
| 4.2 | Few-shot prompting | **P4** | Add two examples; compare kind accuracy and false positives with P1 |
| 4.3 | Structured output through tool use and JSON schemas | **P1**, **P4** | The strict `submit_question_list` tool; in P4 also `output_config.format` |
| 4.4 | Validation, retry and feedback loops | **P1**, **P4** | Pydantic plus the ID check in code; the errors go back as `is_error` and the model resubmits |
| 4.5 | Batch processing | P4 | Optional: run the P4 test set through the Message Batches API (half price, no tool loop) and compare |
| 4.6 | Multi-instance and multi-pass review | **P2** | Per-screen pass, then a cross-page pass; measure what each finds |
| 5.1 | Preserving critical information | **P3** | Glossary and summaries in files, read back instead of kept in the context |
| 5.2 | Escalation and ambiguity | **P2** | "Critical" questions stop for a person |
| 5.3 | Error propagation in multi-agent systems | **P2** | A failed subagent returns a structured failure the orchestrator reports, never a silent gap |
| 5.4 | Large codebase exploration | P3, P6 | Grep and Glob over the spec; summaries as a map |
| 5.5 | Human review and confidence calibration | P2, P4 | The approval stop; severity agreement from the scorer as the calibration measure |
| 5.6 | Provenance and uncertainty in multi-source synthesis | P1, P2 | Every question carries `item_ids` and `spec_quote` (null when the spec is silent); the scorer checks them |

## Scenarios

Four of the six are drawn per sitting.

| Scenario | Closest part |
|---|---|
| Customer Support Resolution Agent | P2 (escalation, approval). Mostly study only |
| Code Generation with Claude Code | P6 |
| Multi-Agent Research System | P2, P3 |
| Developer Productivity with Claude | P6 |
| Claude Code for CI/CD | P6 (headless run) |
| Structured Data Extraction | P1, P4 |

## API drift the exam may not reflect

The guide is dated July 2026; the current API differs in one place that matters for D4 and 2.3.

- **Forced `tool_choice`** (`{"type": "any"}` or `{"type": "tool", ...}`) returns a 400 on Claude Sonnet 5.5, Opus 5.5 and
  Fable 5.x. Claude Haiku 5.5 still accepts it, but a forced call skips thinking. On the other models: `auto` with
  `strict: true` on the tool, or `output_config.format` for a JSON answer. Practise the exam's form on Haiku 5.5 in P4,
  and the current form on Sonnet 5.5. Measured on 2026-11-11: Sonnet 5.5 returns the 400; Haiku 5.5 forced returned no
  thinking block in 24 of 24 answers, against 22 of 24 with `output_config.format` (see P4 in decisions.md).
- **Extended thinking** is `thinking: {"type": "adaptive"}`; `budget_tokens` returns a 400. Effort is set with
  `output_config: {"effort": ...}`. Sampling parameters and assistant prefill return a 400.

When an exam answer and the current API disagree, answer as the guide teaches and note the difference here.
