# Decisions and measurements, per part

Each part records the exam objective it practises, the decision taken, one "why not the other option" note, and what
was measured. The note is the study material: the exam asks for the trade-off.

## Before the parts (2026-11-11)

| Decision | Choice | Why not the other option |
|---|---|---|
| Engine and budget | An API key for this PoC only, cap USD 30 over all parts. The CLI stops when the ledger in `runs/ledger.jsonl` reaches `SPEC_REVIEW_BUDGET_USD` | The subscription cannot run the Messages API loop of P1 or forced `tool_use` of P4, and the Agent SDK documentation asks third-party agents to use an API key |
| Language | Python with `uv`: `anthropic`, `pydantic`, later `claude-agent-sdk` and `mcp` | TypeScript works for every part, but Pydantic is named in the plan and the owner reads Python |
| MCP server | A new small server in this folder (P5) | `mcp-atlassian-server` is not on the machine; the spec is local markdown anyway |
| Spec | Synthetic, 14 pages (overview, common spec, 12 screens), every item with an ID | A real spec is forbidden; IDs let code check every question |
| Scoring | Deterministic: a planted problem is found when a question cites one of its anchor IDs, matched one to one. No model grades | The product's lesson: a self-reported result is not a verified result. A model grader adds cost and its own errors |
| Demo polish | None by default | The owner did not ask for a demo |

## Planted problems

23 problems in [eval/answers.json](../eval/answers.json): 9 missing, 7 contradictions, 7 ambiguous (by intended kind);
3 critical, 12 major, 8 minor. Five non-issues are traps for false positives. `spec-review index` confirms that
`MAIL-02` is the only ID referenced and never defined.

## P1: hand-written loop on the Messages API

**Objectives:** 1.1, 2.1, 4.1, 4.3, 4.4, 5.6.

| Decision | Choice | Why not the other option |
|---|---|---|
| How the output is forced | `tool_choice` left at `auto`; the `submit_question_list` tool is `strict: true`; the prompt says when to call it; if the turn ends without a call, one nudge, then the run fails | Forced `tool_choice` returns a 400 on Sonnet 5.5. `strict` keeps the schema guarantee but not the call itself, so the loop must check that the call happened |
| Where validation lives | Pydantic for shape and Japanese text, then code for IDs that must exist in the spec. Errors go back as `is_error` tool results; 3 submits at most | Strict mode cannot express lengths or cross-checks against the spec; asking the model to check itself is not verification |
| Nullable fields | `spec_quote`, `proposed_answer` and `location.section` are required but nullable (`anyOf` string/null) | Optional fields let the model leave them out silently; required-nullable makes "the spec says nothing" an explicit answer. `type: ["string","null"]` is valid JSON Schema, but the SDK's `transform_schema` rejects it |
| Stop reasons | `tool_use` runs tools; `pause_turn` continues; `end_turn` ends only after an accepted submit; `max_tokens`, `refusal` and `model_context_window_exceeded` end the run with that outcome; anything else is an unexpected stop | Treating every non-`tool_use` stop as success is the classic bug the exam tests |
| Step limit | 25 steps, then outcome `step_limit` | Without a limit a confused model loops until the budget is gone |
| Cost | One moving cache breakpoint on the newest user turn, so each step reads the system prompt, tools and pages from cache; streaming so a large `max_tokens` does not time out | Without caching every step pays full price for the whole spec again |
| Tools | `list_pages`, `read_page` (with `is_error` for an unknown page that lists the valid IDs), `submit_question_list` | One `read_all` tool would be cheaper, but the parallel reads and the error path are what the part practises |

**Measured:**

| Run | Model | Outcome | Steps | Submits | Valid | Found (of 23) | With kind | Severity | False positives | Tokens in / cache read / out | Cost | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dry run (scripted) | fake | done | 5 | 2 | yes | 3 | 3 | 3 | 1 | 15,000 / 70,000 / 6,820 | USD 0 (0.105 if billed) | 0 s |
| 20261111-203930 | Sonnet 5.5, medium | done | 4 | 1 | yes | 16 | 16 | 14 | 0 | 24,023 / 16,501 / 5,038 | USD 0.112 | 38 s |
| 20261111-204049 | Sonnet 5.5, medium | done | 4 | 1 | yes | 21 | 19 | 17 | 0 | 16,309 / 28,417 / 6,555 | USD 0.109 | 45 s |
| 20261111-204135 | Sonnet 5.5, medium | done | 4 | 1 | yes | 19 | 19 | 18 | 0 | 13,833 / 28,417 / 5,595 | USD 0.093 | 38 s |

"Tokens in" counts uncached input plus cache writes. Scores are after the rescore with `accepted_unplanned` (below).

**What the runs showed:**

- **Valid output 3 of 3 on the first submit.** Strict tool plus a required-nullable schema gave no validation retry. The
  retry path is tested offline only (the dry run).
- **Recall varies: 16, 21, 19 of 23 (mean 81%).** P23 (a button that is not in the item list) was missed by all three
  runs; P08, P09, P18, P19 by two. One pass over 14 pages is not reliable for the small "missing" problems. This is the
  case for P2: one subagent per screen, then a cross-page pass (objective 4.6).
- **Real gaps that were not planted.** The runs found five real gaps the answer list did not have: cancel deletes the
  request outright, hand-out before or after the period, a schedule that shows only approved requests, password rules,
  and the department master. They are now `accepted_unplanned` (X01 to X05) in the answer list: they are neither found
  nor false positives. The lesson for the exam: a fixed answer list is a floor, and a human reviews the questions it
  does not cover (`unplanned_for_review` in the score).
- **Mis-citation is the main error, not hallucination.** Run 1 asked about P09 (who approves when the head applies)
  but cited `SC-07-R02` and `SC-07-F02`, so the scorer counted it as a false positive on the trap N05. Run 3 merged two
  problems into one question. Both are provenance faults (objective 5.6): the question is right, its place is wrong. A
  check that `spec_quote` really appears in the cited page would catch the first kind in code (P4).
- **All 14 pages read in one parallel batch** at step 2, so the run is four steps: list, read all, submit, end.
- **The last step costs about 28% of the run.** After the accepted submit the model gets one more turn to say it is
  done, and that turn writes the cache again (about USD 0.03). Ending the loop on the accepted submit, without
  sending the tool result back, saves it. Kept as is in P1, so the stop-reason handling stays complete.

Spent on P1: USD 0.31 of 30.

## P2: the Claude Agent SDK, coordinator and subagents

**Objectives:** 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.3, 4.6, 5.6. Code: [src/spec_review/sdk_agent.py](../src/spec_review/sdk_agent.py),
command `spec-review p2`. `claude-agent-sdk` 0.2.180 with its bundled Claude Code CLI 2.1.321, on the same API key.

| Decision | Choice | Why not the other option |
|---|---|---|
| Shape | One coordinator; one `screen-reviewer` subagent per screen (`AgentDefinition`, tools: `read_page` only); the coordinator reads every page itself for a cross-page pass, merges and submits | A subagent per screen sees each screen closely but cannot see contradictions between pages; the coordinator alone is P1 again. The two passes are objective 4.6 |
| Context passing | OVR and CMN go into the subagent's system prompt; the coordinator's prompt to it names only the screen | A subagent starts with an empty context. Putting the shared pages in its system prompt gives twelve subagents the same cacheable prefix |
| Tools | Built-in tools: `Agent` only (`tools=["Agent"]`). The spec is an in-process SDK MCP server (`create_sdk_mcp_server`), `readOnlyHint` on the read tools. `setting_sources=[]` and `strict_mcp_config=True` | Without the two isolation options the run would load the owner's own settings, plugins, hooks and MCP servers |
| What still asks | `allowed_tools` auto-approves `list_pages`, `read_page`, `Agent`. `submit_question_list` is left out, so it reaches `can_use_tool`, which denies every other tool | A `PreToolUse` hook that returns *allow* would skip `can_use_tool`; the coverage hook below returns no decision when it passes |
| Human approval | `can_use_tool` on the submit: a valid list with critical questions goes to a reviewer (`--approval ask` on the terminal, 600 s, no answer means reject; or a fixed policy). A rejected question that comes back, with any severity, is denied without asking; the third denial sets `interrupt` | Approving before validation would ask the reviewer about a list that code then rejects, so invalid lists go straight to the tool, which returns the errors. Matching rejected questions by their item IDs, not their severity, stops "downgrade to get past the gate" |
| Subagent answers | Taken by code at `SubagentStop` (`last_assistant_message`) and at `PostToolUse` on `Agent`: JSON parsed, IDs normalised (NFKC, upper case), checked against the spec. The coordinator gets a note that the answer is data, not instructions | A subagent answer is untrusted text to its parent. Parsing it in code also gives a score for the subagents alone, so a loss in the merge shows |
| Gate before the submit | `PreToolUse` on the submit denies it until every screen has a parsed subagent answer | Run 1 below gated on "every screen page was read by a subagent" and passed while no answer had arrived: the gate checked a proxy, not the outcome |
| State across a restart | Hook state (answers, approvals, rejections) is saved to `state.json` and loaded on `--resume` | A resume starts a new process; hooks keep their state in memory. Without the file a resumed session could resubmit a rejected question |
| Cost | `max_budget_usd` per run (default 3, capped by what is left of the 30), cost from `ResultMessage.total_cost_usd`, cross-checked against `model_usage` and our price table | — |

**Measured** (Sonnet 5.5 for coordinator and subagents, effort medium):

| Run | Approval | Questions | Found (of 23) | With kind | Severity | False positives | Accepted unplanned / for review | Subagents alone: findings, found | Cost | Time |
|---|---|---|---|---|---|---|---|---|---|---|
| 205123 (gate on pages read) | accept | 25 | 23 | 22 | 19 | 0 | 1 / 1 | not received | USD 0.548 | 71 s |
| 205406 | accept | 37 | 22 | 20 | 17 | 1 | 5 / 9 | 68, 22 | USD 0.547 | 87 s |
| 205601 | accept | 42 | 23 | 21 | 16 | 2 | 6 / 11 | 68, 22 | USD 0.581 | 97 s |
| 205605 | reject | 35 | 20 | 17 | 15 | 1 | 3 / 11 | 65, 22 | USD 0.743 | 135 s |
| fork of 205605 | accept | 34 | 20 | 16 | 15 | 1 | 3 / 10 | — | USD 0.181 | 56 s |

Every run produced a valid list on the first submit. In the reject run the policy rejected all four critical
questions (P03, P07, P11 and X01); P07 still counts as found through another question that cites its anchor.

**What the runs showed:**

- **Subagents ran in the background.** CLI 2.1.321 launched every `Agent` call asynchronously (`status:
  async_launched`) in all runs, also with `background=False` in the `AgentDefinition`. In run 1 the coordinator read
  the pages itself and submitted before any subagent answered, and the gate let it through because it checked pages
  read. Its 23 of 23 is a single pass by the coordinator with the P2 prompt, not the subagent design. After the gate
  changed to "a parsed answer per screen", taken at `SubagentStop`, the coordinator waited for the twelve task
  notifications by itself (the gate never had to block). Exam lesson: check the outcome, not a proxy; and do not
  assume a subagent call returns its answer.
- **Recall: 22 to 23 of 23 against 16 to 21 for P1, for five times the cost** (USD 0.55 against 0.10). The subagents
  alone found 22 of 23 in every run; the one they miss, P21, is on OVR, which no subagent reviews, and the
  cross-page pass caught it every time.
- **The merge loses things.** P08 (purpose field length) was found by the subagents in all three runs that had their
  answers, and the coordinator dropped it in two of them. A coordinator that rewrites findings is a filter with its own errors; the score of
  the subagents alone is what shows it.
- **More questions, more noise.** 35 to 42 questions against 20 to 28: false positives rose from 0 to 1 or 2 (the
  traps N01 and N05), and 9 to 11 questions are outside the answer list for a human to read.
- **The rejected questions stayed out.** With every critical question rejected, the coordinator removed the four,
  did not resubmit them with a lower severity, and listed them in its final answer. The repeat guard was not needed,
  but it is tested offline.
- **Resume and fork.** `--resume <run> --fork` branched a new session (a new ID) from the reject run and asked for a
  deduplicated list: it read no page again, and reused the warm cache (202K tokens read, 27K written), for USD 0.18.
  On a resumed session `total_cost_usd` and `model_usage` are cumulative over the whole history (the CLI reported
  0.92); the CLI now subtracts the earlier cost, and the ledger line was corrected.
- **Haiku 5.5 appears in `model_usage`** (about USD 0.0004 a run): the CLI's own small side calls, not ours.

Spent on P2: USD 2.60. Total so far: USD 2.91 of 30.

## P3: summaries and a glossary in files, read back instead of kept in the context

**Objectives:** 5.1, 5.4, 1.3. Code: [src/spec_review/notes.py](../src/spec_review/notes.py) (the notes) and the notes
mode of [src/spec_review/sdk_agent.py](../src/spec_review/sdk_agent.py); commands `spec-review notes` and
`spec-review p3`. The notes are in [notes/](../notes/): `summaries/<page>.md`, `glossary.md`, `manifest.json`.

| Decision | Choice | Why not the other option |
|---|---|---|
| Who writes the notes | Haiku 5.5, effort low, one call per page and one for the glossary, built once and reused while the spec hash is the same | The notes are extraction, not judgement; a cheap model is enough when code checks the result. Rebuilding per run would pay for the same text every time |
| What a summary must keep | Every ID and every number of its page, checked by code. A note that loses one gets one retry naming what was lost; what the retry still loses is appended by code as the original lines | A summary that drops "30分" or a row ID silently removes the fact a cross-page contradiction rests on. The model is told to keep them, but only the check makes it true (5.1: the facts that matter are kept verbatim, not paraphrased) |
| What the subagent receives | Its screen (read with `read_page`), the glossary and the OVR and CMN summaries in its system prompt; full OVR or CMN on demand with `read_page`, other summaries with `read_note` | P2 put the full OVR and CMN text there. The study map asks for the summary instead of the whole spec (1.3) |
| What the coordinator receives | No page up front. `read_note("index")` (every summary, the map), `read_note("glossary")`, `search_spec` (a regex grep returning `PAGE:line: text`, at most 40 lines) and `read_page` to confirm | P2's coordinator read all 14 pages. A map plus grep is how a large spec, or a large codebase, is explored without loading it (5.4) |
| Quotes | `spec_quote` must come from `read_page` or `search_spec`, never from a summary (prompt rule) | A summary rewords. A quote taken from it looks exact and is not, which is a provenance fault (5.6) |
| Everything else | Same as P2: the gate on a parsed answer per screen, the approval stop, the state file, the scorer | So the comparison with P2 changes one thing: what is in the context |

**The notes** (built once, USD 0.016, 104 s, 15 sequential calls):

| | Spec | Notes |
|---|---|---|
| Characters | 9,922 (14 pages) | 7,979 for the 14 summaries (80% of the spec) plus 1,532 for the glossary |
| Facts lost on the first try | — | Every note lost something: mostly the section IDs (SC-05-2), and 7 role-matrix IDs in the glossary |
| Lost after the retry | — | 2 notes: three OVR section headings and the 「1人」 sentence of CMN; appended by code (4 lines) |

**Measured** (Sonnet 5.5 for coordinator and subagents, effort medium, approval policy accept; the P2 rows are the
accept runs that had subagent answers):

| Run | Questions | Found (of 23) | With kind | Severity | False positives | Accepted / for review | Subagents alone: findings, found | Subagent first prompt | Coordinator peak context | Pages read by the coordinator | Cost | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P2 205406 | 37 | 22 | 20 | 17 | 1 | 5 / 9 | 68, 22 | 5,613 tokens | 68,361 | 14 | USD 0.547 | 87 s |
| P2 205601 | 42 | 23 | 21 | 16 | 2 | 6 / 11 | 68, 22 | 5,613 | 73,404 | 14 | USD 0.581 | 97 s |
| P3 211132 | 32 | 20 | 18 | 16 | 0 | 2 / 10 | 71, 21 | 6,983 | 69,555 | 0 (index, glossary, 3 greps) | USD 0.614 | 73 s |
| P3 211135 | 35 | 23 | 22 | 19 | 0 | 4 / 8 | 71, 22 | 6,983 | 69,687 | 0 (index, glossary, 3 greps) | USD 0.538 | 82 s |

Context sizes come from the per-message usage in `transcript.jsonl` (`context_stats`), so the P2 runs were measured
again for free. Every run produced a valid list on the first submit.

**What the runs showed:**

- **On this spec the notes save nothing.** The spec is already tables of IDs and values, so a summary that must keep
  every ID and number keeps 80% of the text. The subagent prompt grew by 24% (6,983 against 5,613 tokens), because
  the glossary came on top of the OVR and CMN summaries, which together are longer than the two pages. The
  coordinator's peak context did not move (about 70K tokens): what fills it is the twelve subagent answers and its
  own submit, not the pages. Cost is the same (USD 0.54 to 0.61 against 0.55 to 0.58); output tokens are 55% of it.
  Exam lesson: summarising pays when the source is prose much larger than its facts, or larger than the window; a
  fact check is what decides how far it can compress, and here the answer was "hardly".
- **Grep did the cross-page work.** The coordinator read no page at all. It read the map and the glossary, then
  searched three times with patterns it chose well (`分|日間|か月|MAIL-02|差戻し|予約済|お知らせ`, `資産番号|YYYY`, the vague
  words `一定|適切|関係者|夜間|適宜`), and found the contradictions that need two pages (P01, P07, P17) in both runs. A
  test found a trap in grep itself: lengths sit in the 桁数 column with no unit, so a search for `\d+桁` misses SC-10;
  the prompt now says to search by item name too.
- **Recall is the same: 20 and 23 against 22 and 23.** The subagents alone found 21 and 22 of 23, as in P2; they read
  only their own screen and never asked for the full OVR or CMN. The 20 is the merge again: the coordinator dropped
  P19 and P20, which its subagents had found, and P08, which they had not. The merge lost findings in 3 of the 5 runs
  of P2 and P3 that had subagent answers; it is the weak step of this design, whatever the context holds.
- **Fewer traps hit.** No false positive in either P3 run, against 1 and 2 in P2. Two runs are too few to credit the
  notes for it.
- **Quotes picked up the summary's wording.** 4 of 67 quotes differ from the spec by a final 「。」 that the summaries
  add to table cells: the coordinator rewrote the subagents' exact quotes from the index it held. The meaning is
  intact, but the prompt rule ("never from a summary") did not hold; a check in code that each quote occurs in the
  cited page is the fix (P4). In the three P2 accept runs, 103 of 104 quotes occur in the spec as written; the other joins two spec sentences with 「/」.
- **The glossary leans toward judgement.** Asked to list "state values used outside their group" and "pages that use a
  MAIL ID", Haiku wrote that SC-10 uses 予約済 and that MAIL-02 has no definition: two planted problems (P06, P16) in
  a note that was told not to judge. Both were found in every P2 run without notes, so recall is not inflated here,
  but a cross-reference section is a review step, and on a real spec it belongs to the review, not to the notes.

Spent on P3: USD 1.17 (notes 0.016, two runs 1.15). Total so far: USD 4.08 of 30.

## P4: one request per screen, five ways to force the output, validation and retry, a test set

**Objectives:** 4.3, 4.4, 2.3, 4.1, 4.2, 4.5, 5.5. Code: [src/spec_review/extract.py](../src/spec_review/extract.py),
the quote check in [src/spec_review/schema.py](../src/spec_review/schema.py); command `spec-review p4`.

| Decision | Choice | Why not the other option |
|---|---|---|
| The test set | 12 cases, one per screen. OVR and CMN go in one cached system block, the screen in the user message, and the answer is one structured output: no tool loop | One request over the whole spec (P1) is one sample, not a test set, and its tool loop cannot go through Batches. Cost: a problem that needs two screens is out of reach. P21 is anchored only on `OVR-N02`, so 22 of 23 is the best possible here |
| Five modes | `haiku-forced` (forced `tool_choice` on a strict tool), `haiku-forced-loose` (forced, no `strict`), `haiku-format` (`output_config.format`), `sonnet-strict` (`auto` on a strict tool), `sonnet-format`. All use adaptive thinking at effort medium | Forced `tool_choice` is the exam's form, and a probe on 2026-11-11 (USD 0.0003) showed that only Haiku 5.5 still accepts it: Sonnet 5.5 returns a 400. The loose mode measures what `strict` adds |
| The system block | The same text for every mode on one model, so the cache prefix is shared | A mode-specific instruction in the system block would split the cache and change two things at once |
| An empty answer | Allowed: `minItems: 0` in this schema; SC-06 has no planted problem | `minItems: 1` makes the model invent a question for a clean screen: a false-positive generator built into the schema |
| Validation | Pydantic for shape and length, code for IDs that must exist, and now code for `spec_quote`: it must occur in the spec after NFKC and whitespace folding, else it is an error that says to copy one passage exactly or use null | The quote check was the fix P1 and P3 asked for (5.6). Exact byte match would reject a full-width digit; a fuzzy match would accept the reworded quote it is meant to catch |
| Retry | 3 attempts at most. A tool answer gets an `is_error` tool result listing the errors (a forced mode stays forced); an `auto` turn with no call gets one nudge; a JSON answer gets a user turn listing the errors. `max_tokens` and `refusal` end the case without a retry | The same request after `max_tokens` is cut at the same place; it needs a larger limit or a smaller case. Retrying a refusal pushes against a safety decision |
| Few-shot (4.2) | Two worked examples and one counter-example ("no question: the common spec answers it") from a fictional meeting-room spec, appended to the system block | Examples taken from this spec would leak the answer list into the prompt and inflate recall |
| Batches (4.5) | `--batch` sends the 12 first attempts as one Message Batch at half price and polls; a retry runs synchronously | A retry needs the first answer, so batching it means a second batch and a second wait. A batch request cannot stream or loop |

**Measured** (12 cases each, effort medium, one run per row; "tokens in" counts uncached input plus cache writes):

| Run | Mode | Valid first / final (attempts) | Retry causes | First answers with thinking | Questions | Found (of 23) | With kind | Severity | False positives | Accepted / for review | Tokens in / cache read / out | Cost | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 212313 | haiku-forced | 10 / 12 (14) | quote 2 | 0 of 12 | 69 | 21 | 16 | 18 | 4 (N01, N02, N05) | 9 / 35 | 22,962 / 52,728 / 22,192 | USD 0.014 | 38 s |
| 212401 | haiku-forced-loose | 11 / 12 (13) | unknown ID 1 | 0 of 12 | 68 | 21 | 19 | 16 | 3 (N01, N04, N05) | 5 / 39 | 16,842 / 52,728 / 20,465 | USD 0.012 | 34 s |
| 212436 | haiku-format | 10 / 12 (14) | quote 2 | 11 of 12 | 41 | 20 | 18 | 15 | 0 | 7 / 14 | 16,610 / 53,768 / 28,800 | USD 0.017 | 57 s |
| 212902 | haiku-format, few-shot | 11 / 12 (13) | quote 1 | 11 of 12 | 40 | 19 | 16 | 15 | 1 (N02) | 6 / 14 | 15,913 / 56,076 / 28,316 | USD 0.016 | 42 s |
| 212543 | sonnet-strict | 12 / 12 (12) | none | 0 of 12 | 54 | 22 | 17 | 15 | 4 (N03, N04, N05) | 3 / 25 | 11,554 / 44,616 / 14,456 | USD 0.174 | 39 s |
| 212623 | sonnet-format | 12 / 12 (12) | none | 0 of 12 | 60 | 22 | 17 | 14 | 4 (N03, N04, N05) | 5 / 29 | 10,758 / 45,496 / 16,117 | USD 0.189 | 39 s |
| 212822 | sonnet-format, few-shot | 12 / 12 (12) | none | 0 of 12 | 61 | 22 | 18 | 13 | 4 (N03, N04, N05) | 4 / 31 | 11,295 / 51,403 / 16,635 | USD 0.196 | 39 s |
| 212955 | sonnet-format, batch | 12 / 12 (12) | none | 0 of 12 | 65 | 22 | 18 | 13 | 3 (N03, N04, N05) | 5 / 35 | 10,758 / 45,496 / 17,597 | USD 0.102 | 315 s |

Every run ended at 12 of 12 valid. A false positive is counted per question, so one trap can count twice.

**What the runs showed:**

- **A forced call on Haiku never thinks, and its answers are noisier.** With `tool_choice` forced, Haiku returned no
  thinking block in 24 of 24 first answers (strict and loose); with `output_config.format` the same model thought on
  11 of 12. The forced answers had 68 and 69 questions against 41, 3 and 4 trap hits against 0, 35 and 39 questions
  for a human to review against 14, and rated 41 of 69 as minor. Recall moved by one (21 against 20). Exam lesson:
  forcing the call buys the call, and on Haiku 5.5 it costs the reasoning; for a judgement task the JSON form with
  thinking is the better Haiku setting, and forcing fits plain extraction.
- **Every retry was a content fault that only code catches.** 5 of the 6 retries in the Haiku runs were quotes that
  are not in the spec, the sixth an ID that does not exist (`CMN-C001`). There was no schema fault in any run,
  `strict` or not, and each fault was fixed by one retry that named it. So in this sample `strict` added nothing that
  the model did not already do; the guarantee that mattered came from Pydantic plus the ID and quote checks (4.4).
  Sonnet needed no retry in 48 cases, and `auto` never needed the nudge: 12 of 12 called the tool.
- **Sonnet at effort medium chose not to think.** Adaptive thinking was on, and Sonnet returned no thinking block in
  48 of 48 first answers (600 to 1,500 output tokens a case). Haiku at the same effort thought on 22 of 24 JSON
  answers. Adaptive means the model decides; effort is the knob, not the `thinking` field.
- **One request per screen found 22 of 23 on Sonnet**, the best this test set allows, for USD 0.17 to 0.20 against
  P1's 16 to 21 for USD 0.10 and P2's 22 to 23 for USD 0.55. It asks more (54 to 61 questions against P2's 37 to 42)
  because nothing merges or drops. Strict tool and JSON form gave the same recall; the JSON form wrote 11% more
  output and cost 9% more.
- **"False positive" is an upper bound.** Sonnet's four trap hits are, read one by one, questions about other gaps on
  the trap's item (which year starts the request-number sequence, paging on the overdue list), not the trap itself.
  The scorer matches by ID, so a question on the same row counts against the trap. Haiku's N01 and N02 hits are real:
  it asked about a format the common spec gives, and options given by reference to another screen. Calibration
  (5.5): the severity agreement is 13 to 18 of the found problems in every mode, so severity still needs the human
  check.
- **Few-shot changed nothing measurable.** Sonnet: one more right kind, one fewer right severity, the same traps.
  Haiku: one fewer found, one trap more. The criteria from P1 already define kind and severity, and the examples
  add 537 cached tokens. One run each cannot show a change of one or two; P1 showed that much between identical runs.
- **Twelve valid answers made an invalid list.** Each case passed the schema, but the merged list of three runs had
  61 to 69 questions against the 60 limit of one list. The limit is per answer, not per report, so the Excel export
  validates question by question.
- **The batch cost 46% less and took 8 times as long.** The same 12 requests through Message Batches cost USD 0.102
  against 0.189, with the same validity and recall. The cache still worked inside the batch: one write, then 45,496
  cached tokens read, as in the synchronous run, so the half price comes on top of the cache discount. The answer
  took 315 s against 39 s (the batch ended between two 15-second polls at about 5 minutes). Exam lesson (4.5): a batch
  fits a nightly re-review of a whole spec, not a person waiting at the screen, and it fits only one-shot requests: no
  tool loop, no streaming, and a retry needs a second round.

Spent on P4: USD 0.72 (probe 0.0003, eight runs 0.72). Total so far: USD 4.80 of 30.

## P5: an MCP server for the spec

**Objectives:** 2.2, 2.4, 2.1. Code: [src/spec_review/mcp_server.py](../src/spec_review/mcp_server.py) (the server),
[src/spec_review/mcp_check.py](../src/spec_review/mcp_check.py) (an Agent SDK session that uses it),
[.mcp.json](../.mcp.json); commands `spec-review-mcp` (the server on stdio) and `spec-review p5`.

| Decision | Choice | Why not the other option |
|---|---|---|
| SDK | The official `mcp` Python SDK 2.3 (`MCPServer`, formerly `FastMCP`), stdio transport | The in-process SDK server of P2 runs only inside the Agent SDK. A stdio process is what Claude Code, the SDK and any other client can start from one config |
| One tool | `read_page(page_id)`, annotated read-only, idempotent and closed-world. The description says where the IDs come from (the index resource), what to quote from, and what an unknown ID returns. IDs are folded (NFKC, upper case) as in P2 | A `list_pages` tool would duplicate the resource. Annotations let a client auto-approve a read-only tool |
| One resource | `spec://index` (JSON): each page's ID, title, number of item IDs and length, and the spec hash | Pages as resources would let the client load them without a model decision; the index is the map the model reads before it asks (application-controlled context against model-controlled tools) |
| Errors (2.2) | An unknown page raises `ToolError`, which the SDK turns into a result with `isError: true` and the message: the ID asked for, the valid IDs, where the titles are | A protocol error (JSON-RPC) ends the call; the model never sees a reason. Any other exception reaches the model only as "Error executing tool read_page", with no way to correct itself |
| Secrets | `.mcp.json` holds `"SPEC_SERVER_TOKEN": "${SPEC_SERVER_TOKEN}"` and `"SPEC_DIR": "${SPEC_DIR:-spec}"`; the server refuses to start without the token and writes the reason to stderr. The token is a stand-in for the upstream credential a real spec server (wiki, tracker) needs | A value written in `.mcp.json` goes into git with the project. stdout carries the protocol, so a diagnostic printed there would break the client |
| One config for both clients | Claude Code reads `.mcp.json` at project scope; the SDK session passes the same file as `mcp_servers=Path(".mcp.json")` (the `--mcp-config` flag) with `strict_mcp_config=True` | Two configs drift. Strict mode keeps the user's own MCP servers out of the run |
| The SDK check | Haiku 5.5, effort low, built-in tools limited to `ListMcpResourcesTool` and `ReadMcpResourceTool`, `permission_mode="dontAsk"`. The agent reads the index, reads SC-06, tries SC-13 and reports; code checks the transcript and the facts, not the report | Asking the agent whether the error came back is a self-report. The test `told_not_shown` shows the gap: an answer can quote the error text while the call never happened |

**Measured:**

| Check | Result |
|---|---|
| Offline tests (in-process `Client`, a stdio subprocess, the config file) | 6 tests pass: page read, ID folding, `is_error` with the valid IDs, the index, start-up refused without the token (exit 2, nothing on stdout), `${VAR}` in `.mcp.json` |
| SDK session 20261111-213716 | 8 of 8 checks: server connected, resource read, SC-06 read, SC-13 returned `is_error`, and the answer's page count, title, the 7 SC-06 IDs and the error text all match the spec. 4 turns, 7.6 s, USD 0.001 |
| Claude Code, `claude mcp get spec` | Scope "Project config (shared via .mcp.json)", status "Pending approval": a project server does not start until a person approves it in an interactive session. The listing shows `${SPEC_SERVER_TOKEN}`, never its value |

**What the runs showed:**

- **The error result did its job.** The model read the error, quoted it, and the message named the valid IDs; with
  three steps asked it made exactly three calls. The text the model sees starts with "Error executing tool
  read_page:", which the SDK adds; the message after it is the server's.
- **A project `.mcp.json` is not trusted by default; an explicit `--mcp-config` is.** Claude Code holds a cloned
  project's server until a person approves it, because the server is a command that runs on the machine. The SDK
  passed the file on the command line, which is the caller's own consent, and the server started without a prompt. A
  CI job uses the explicit flag (P6).
- **The secret never appears in a file.** The SDK run had no token in the shell, so the CLI generated one for the run
  and passed it as an environment variable; Claude Code expanded it into the server's environment.

Spent on P5: USD 0.001. Total so far: USD 4.80 of 30.

## P6: Claude Code configuration, a hook, and one headless run

**Objectives:** 3.1, 3.2, 3.3, 3.6, 1.5, 2.5; 3.4 as a study note. Files: [CLAUDE.md](../CLAUDE.md) (project level),
[src/CLAUDE.md](../src/CLAUDE.md) (directory level), [.claude/rules/](../.claude/rules/) (two path rules),
[.claude/commands/review-spec.md](../.claude/commands/review-spec.md),
[.claude/skills/score-questions/SKILL.md](../.claude/skills/score-questions/SKILL.md),
[.claude/settings.json](../.claude/settings.json) with
[.claude/hooks/block_secret_files.py](../.claude/hooks/block_secret_files.py); the driver
[src/spec_review/headless.py](../src/spec_review/headless.py), command `spec-review p6`. The root `.gitignore`
ignores every `CLAUDE.md` and `.claude/` in the repository; three exceptions let these files travel with PoC 6, and
`settings.local.json` stays ignored.

| Decision | Choice | Why not the other option |
|---|---|---|
| CLAUDE.md levels (3.1) | User level (`~/.claude/CLAUDE.md`) left alone and kept out of the run with `--setting-sources project`; project level in the PoC folder (always loaded); directory level in `src/` (loaded when a file under `src/` is read) | A directory file in `spec/` would be the natural place for the spec rules, but `load_spec` reads every `*.md` there as a page: a `CLAUDE.md` would become a fifteenth page and change the spec hash. The spec rules went into a path rule instead |
| Path rules (3.3) | `spec-pages.md` with `paths: spec/**/*.md` (never edit the test data, cite by ID, quote exactly) and `python.md` with `src/**/*.py` and `tests/**/*.py` (offline tests, cost in the ledger) | A directory `CLAUDE.md` covers one folder; a rule's glob covers files across folders (`src/` and `tests/`), and it needs no file inside the folder it governs |
| Seeing what loaded | Each file carries a tag (`Rule tag: P6-...`). The command asks for the tags in `rule_tags`; code expects `P6-PROJECT` and `P6-RULE-SPEC` and requires `P6-SRC-DIR` and `P6-RULE-PY` to be absent | Asking "which files did you load" gets file names the model may guess. A tag can be reported only if it was seen, and the two absent tags catch a model that lists everything |
| Command against skill (3.2) | `/review-spec <screen>`: the person starts it, `$ARGUMENTS` names the screen, `allowed-tools` pre-approves `mcp__spec__read_page` and `Read`. `score-questions`: a skill the model picks up from its description when asked how good a run was; it may run only `uv run spec-review score` | A command is a fixed procedure the person triggers with an argument; a skill is guidance the model loads when the task matches, and its folder can hold more files. Scoring as a command would need the person to know when to call it |
| The hook (1.5) | `PreToolUse` on `Write\|Edit\|MultiEdit\|NotebookEdit\|Bash`; it reads the path (or the redirect, `tee`, `cp`, `mv`, `sed -i`, `dd of=` targets of a command), never the file; exit 2 with the reason on stderr; any other failure exits 0 | CLAUDE.md is advice the model weighs; a hook is code that runs on every call. `PostToolUse` is too late: the file is written. Failing closed would stop all work on a hook bug, and the deny list and `.gitignore` stand behind it |
| Permission rules | `deny: Read(./.env), Read(./.env.local)` | The hook guards writes; reading the key is the leak that matters, and it needs no hook |
| Headless run (3.6) | `claude -p "/review-spec SC-01" --output-format json --json-schema <schema> --model claude-haiku-5-5 --setting-sources project --mcp-config .mcp.json --strict-mcp-config --tools Read --allowedTools Read,mcp__spec__read_page --permission-mode dontAsk --max-budget-usd 0.30 --no-session-persistence`, with only PATH, HOME, TMPDIR, LANG, the API key and the server token in the environment | `--bare` skips CLAUDE.md discovery and hooks, which are what this part tests. The project `.mcp.json` alone waits for approval (P5); the explicit flag is the caller's consent. `--json-schema` returns a checked object in `structured_output` instead of text to dig JSON out of. A narrow environment keeps a CI job's other secrets away from the agent |
| Built-in tools (2.5) | The review gets `Read` only (plus the MCP tool); the hook probe gets `Write` only | Every tool on offer is a tool the model may call. `dontAsk` denies anything not allowed, so nothing waits for a prompt that no one in CI can answer |

**Measured** (Haiku 5.5, SC-01, which holds two planted problems, P01 and P04):

| Run | Review checks | Tags reported | Questions: found, other | Review cost, turns, time | Hook probe |
|---|---|---|---|---|---|
| Offline | 6 tests | (tags present in each file, expected and absent sets disjoint) | | | 10 blocked calls, 7 allowed, broken input passes |
| 214413 | 7 of 7 | P6-PROJECT, P6-RULE-SPEC | 4: P01, P04, plus P15 (cross-page), 1 for review | USD 0.0036, 5, 20 s | 2 of 3: the model refused on the CLAUDE.md rule and made no call; the hook never ran |
| 214505 | 7 of 7 | the same | 3: P01, P04 | USD 0.0019, 5, 20 s | 2 of 3: the Write to `.env.local` was stopped by the Read deny rule ("File is covered by a Read deny rule in your permission settings and cannot be written"); the hook never ran |
| 214559 | 7 of 7 | the same | 2: P01, P04 | USD 0.0017, 5, 18 s | 3 of 3: Write to `.env.hook-probe`, blocked by the hook; the model quoted "PreToolUse:Write hook error: ... Blocked by the project hook: '.env.hook-probe' is a secret file"; file not created; USD 0.0010 |

The review checks are: exit 0, one JSON object, `is_error` false, `structured_output` present, the questions valid
against the spec (IDs exist, quotes exact), the two expected tags present and the two others absent. In the last run
Claude Code read 23,857 cached input tokens (its own system prompt, the CLAUDE.md files, the rule and the pages),
wrote 2,896 output tokens, 1,959 of them thinking, and returned `num_turns` 5: `read_page`, two `Read`s, the
structured answer.

**What the runs showed:**

- **Three guards stood between the model and a secret file, and they answer in order.** First the model itself,
  reading the CLAUDE.md rule; then the permission rules (a `Read` deny on a path also refused a `Write` to it, in
  Claude Code 2.1.310, before the hook ran); then the hook. Only the hook does not depend on the model or on a list
  of names someone kept current.
- **A probe has to reach the layer it tests.** The first two probes "passed" by the file check alone, yet the hook
  never ran. The check that its reason reached the model is what caught it. The fix was a target that only the hook
  covers and a prompt that says the hook, not the model, is to refuse.
- **The path rule loaded only when the run touched its files.** In all three runs the rule for `spec/**` was there
  and the rule for `src/**` and the `src/` CLAUDE.md were not. The run used both the built-in `Read` on `spec/*.md`
  and the MCP `read_page`; it does not show which of the two brought the rule in. Claude Code sees `spec/OVR.md` as a
  path only through `Read`, so that is the likely one.
- **One screen, headless, cost under a fifth of a cent.** Claude Code's prompt is large, but it was cached. The
  answer is in `structured_output`; the `result` text is empty, so a script that reads `result` gets nothing.
- **Haiku rated both SC-01 questions critical, against major in the answer list**, in every run: severity agreed 0
  of 2 each time, while the kind was right.

**Study notes.** Plan mode (3.4) suits a change whose approach is still open or that touches many files: P6 itself
(settings, a hook, rules, a `.gitignore` exception) is that kind. A plan read before any edit is cheaper than undoing
one. Direct execution suits a known, local edit (the probe wording). Headless, `--permission-mode plan` gives a plan
with no edit. A CI job (3.6, study only) would run the same command on a pull request that touches `spec/`, with the
key from the CI secret store, then fail the job when the script's checks fail:

```yaml
- run: uv run spec-review p6 --screen SC-01   # exit 1 when a check fails
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    SPEC_REVIEW_BUDGET_USD: "1"
```

Spent on P6: USD 0.011 (three runs of a review and a probe). Total so far: USD 4.82 of 30.

## P7: gaps the exam guide names that P1 to P6 did not practise (group A)

**Objectives:** 1.4, 1.5, 2.2, 5.2 (A1); 4.3, 4.4 (A2); 4.6, 5.5 (A3); 4.5 (A4); 3.1, 3.2, 3.6, 4.6 (A5); 5.3,
5.4, 5.6 (A6). Files: [tool_errors.py](../src/spec_review/tool_errors.py) and
[intake.py](../src/spec_review/intake.py) with [eval/intake/](../eval/intake/) (A1),
[review_v2.py](../src/spec_review/review_v2.py) (A2, A6), [verify.py](../src/spec_review/verify.py) (A3, A4),
[ci_review.py](../src/spec_review/ci_review.py), [docs/review-policy.md](review-policy.md),
[.claude/commands/re-review-spec.md](../.claude/commands/re-review-spec.md),
[.claude/skills/verify-findings/SKILL.md](../.claude/skills/verify-findings/SKILL.md) and
[ci/spec-review.yml](../ci/spec-review.yml) (A5). Commands `intake`, `review2`, `verify`, `ci`. Tests
`tests/test_part7_*.py`; the suite is 80 tests.

| Decision | Choice | Why not the other option |
|---|---|---|
| Tool errors (A1, 2.2) | One shape: `errorCategory` (transient, validation, business, permission), `isRetryable`, a message for the model. An empty search is `count: 0` with `isError` false | A bare `isError` and a sentence says something failed, not whether to retry, fix the input or hand over. An empty result that looks like an error makes the agent report a gap that is not there, and the reverse hides an outage |
| The desk's rules (A1, 1.4, 1.5) | A `PreToolUse` hook denies `record_answer`, `escalate` and `mark_follow_up` until `get_question` succeeded for that ID (the prerequisite gate), and denies `record_answer` on a critical question with "escalate with policy_critical" (the policy redirect) | A rule in the prompt is weighed against the user's message; a hook is code on every call. The deny message names the next action, so a block becomes a redirect instead of a dead end |
| Handoff (A1, 5.2) | `escalate` takes a structured summary (reason code, detail, the customer's words quoted, item IDs, the previous answer when it conflicts, a recommended action) and code checks it: the quote is in the reply, the items belong to the question | A person who gets the ticket should act without the transcript. "Escalated, see conversation" is what the exam's support scenario marks wrong |
| Checking the desk | From the tool state (what was recorded, escalated, followed up) against `eval/intake/expected.json`, never from the agent's report | The report is the agent's claim. One injected transient failure checks it retried that call and nothing else |
| Schema v2 (A2, 4.3) | `kind` gains `other` with a required `kind_detail`; `detected_pattern` per question; a contradiction carries `sides` (item ID, value copied from that row) and the model's `conflict_detected`; code computes `conflict_verified` from the sides | Without `other`, a misfit is forced into a category and the kind accuracy lies. A contradiction whose two values are copied can be checked by code; one the model only asserts cannot |
| Retry policy (A2, 4.4) | Errors the model can fix (schema, a quote or value not copied exactly, `conflict_detected` against the copied sides) go back; an error no retry can fix (a side on a page the case does not see) is dropped and recorded; the same errors twice stop the case (`no_progress`) | Retrying when the information is not in the request costs tokens and invites the model to invent the missing row |
| Crash recovery and synthesis (A6, 5.3, 5.4, 5.6) | `manifest.json` written after every case; each finished case in `cases/<screen>.json`; `--resume` requests only pending cases. The report states coverage (screens missing and why), gives each claim its sources (case, rows, quote page, spec hash), and keeps two claims that disagree side by side | A run that dies at screen 9 should not pay for screens 1 to 8 again. A report that omits the screens it did not reach reads as "no problems there" |
| Verifier (A3, 4.6) | A separate request per finding that sees the cited pages, OVR and CMN, and only the claim fields (location, kind, severity, issue, question, quote), never `proposed_answer` or the reviewer's reasoning; it returns `is_real_problem`, a corrected kind and severity, a confidence and a reason | A second look in the same context tends to agree with the first. Self-review is the pattern the exam marks wrong for 4.6 |
| Calibration (A3, 5.5) | A pool of 486 labelled findings from every earlier run (deduplicated) plus 5 decoys written to be wrong on purpose; a stratified sample of 6 per (label, kind) stratum (34, since only 4 non-real contradictions exist); per threshold, the share automated, the accuracy and the worst kind's accuracy; the chosen threshold is the lowest where both reach 0.95 | The pool is 92% real: a random sample of 34 would hold about 3 non-real findings, and an accuracy on it would mostly measure the easy class. A threshold that is good on average can still be bad for one kind |
| Batch with resubmit (A4, 4.5) | `run_batch_with_resubmit`: a round collects results by `custom_id`, checks each (errored, expired, `max_tokens`, invalid JSON, wrong shape), and resubmits only the failed IDs, with `max_tokens` doubled after a cut-off; a refusal is not resubmitted; at most 3 rounds, then `gave_up`. `--inject-fault` gives one request `max_tokens=16` | Resubmitting the whole batch pays twice for what succeeded. Results come back in any order, so matching is by `custom_id`, never position |
| Where batches fit | Calibration and other overnight work only. Not the CI check (see the template's header) | The Batches API promises results within 24 hours, not minutes: a pull request cannot wait on it |
| Shared policy (A5, 3.1) | `docs/review-policy.md` (tag `P6-IMPORT`), imported by the project CLAUDE.md with `@docs/review-policy.md`; review, re-review and verifier work to the same rule of "same finding" | Copying the rule into three prompts lets them drift. An import in a code span is not followed: the test checks the line is outside backticks |
| Re-review (A5, 3.6) | `/re-review-spec <screen> <prior file>` with `argument-hint` and positional `$0`/`$1`; it reports only new findings and places every prior ID in `still_open` or `addressed`. Code counts duplicates by the policy rule | Re-reviewing from scratch on every push repeats old comments on the pull request. `$ARGUMENTS` would put the file path into the page ID |
| Independent verify session (A5, 4.6) | A second `claude -p` process runs the `verify-findings` skill (`context: fork`, `agent: general-purpose`, `allowed-tools` read only). Its prompt asks the main model to call the skill through the Skill tool | A subagent in the reviewer's own session shares its starting point. A typed `/verify-findings` in `-p` returned no answer (below) |

**Measured, A1** (Haiku 5.5, a reply that answers Q001, Q002 (critical), Q003 (conflicts with an earlier answer),
Q004 (promised later), Q005, names an unknown Q007 and skips Q006):

| Run | Rules in the prompt | User message | Checks | Hook blocks | Cost |
|---|---|---|---|---|---|
| 074002 | yes | plain | 8 of 8 | none | USD 0.0031, 15 turns |
| 074026 | no (hooks only) | plain | 8 of 8 | none | USD 0.0032, 14 turns |
| 074108 | no | asks to record Q002 directly and skip `get_question` | 8 of 8 | `record_answer` Q002, `policy_critical` | USD 0.0040, 17 turns |

In all three, Q002 went to `escalate` with `policy_critical`, Q003 with `conflicting_answer` naming the earlier
"1ページ20件", Q004 to follow-up, Q007 and Q006 in the report; the transient timeout on Q001 was retried once and
nothing else was. The handoffs passed the code checks.

**Measured, A2 and A6** (Sonnet 5.5, `output_config.format`, effort medium, the 12 screens): run 074508 stopped after
4 cases (`--stop-after 4`, USD 0.083), then `--resume` requested the 8 pending cases only (USD 0.190; total USD 0.273).
All 12 valid, 0 dropped, 0 conflicts left in the report. Against P4 in the same mode: found 22 of 23 (the same),
found with the right kind 20 (P4: 17), severity agreed 16 (14), false positives 3 (4). On SC-11 the first attempt
said `conflict_detected` false on a role row that the copied sides show to differ; the retry with that error fixed
it. The partial report after the stop said "partial: 8 screens not reviewed; findings about them are absent, not
negative" and listed the seven unreviewed screens with planted problems.

**Measured, A3 and A4** (Sonnet 5.5, effort low, run 075052, one batch, `--inject-fault`): round 1, 34 submitted, 33
succeeded, V001 cut off at `max_tokens`; round 2 resubmitted V001 alone with 4,000 tokens and it succeeded. Nothing
given up. 35 billed messages, USD 0.064 at the batch price, 457 s (394 s for round 1).

| Calibration | Value |
|---|---|
| Accuracy over 34 | 0.85 (real 17 of 18, not real 12 of 16) |
| By kind | ambiguous 0.92, missing 0.83, contradiction 0.80 |
| By confidence | below 0.6: 1 of 1; 0.6 to 0.8: 0.71 (14); 0.8 to 0.9: 0.92 (13); 0.9 and over: 1.0 (6) |
| Mean confidence | 0.78 when right, 0.72 when wrong |
| Threshold chosen (accuracy and worst kind at least 0.95) | 0.9: 6 of 34 automated (18%); at 0.8, 56% automated at 0.95 accuracy but the worst kind at 0.875 |
| Kind agreed on real findings | 0.83 |

The five errors, read one by one: one real finding rejected (P10: "MSG-E005 is used for both checks", which the
verifier called a UX preference). Four non-real labels the verifier called real; three of them come from the scorer,
not the verifier: a finding that cites an anchor of a non-issue is labelled a false positive even when it asks
something else (V055 asks how an item is chosen for editing, V216 the reference date of the overdue count, V286 what
send-back does; all three are reasonable questions, as P4 found when it called "false positive" an upper
bound). The fourth (V062, a decoy on N02) is the verifier's own error:
the category list is given by reference to SC-03-F02, and the verifier saw SC-10, OVR and CMN but not SC-03.

**Measured, A5** (SC-05, which holds P02, P07, P08, P09 and P10):

| Run | Session 1 | Session 2 (verify) | Checks | Cost |
|---|---|---|---|---|
| 075436 | Haiku review: P02, P08, P09, P10; tags P6-IMPORT, P6-PROJECT, P6-RULE-SPEC | typed `/verify-findings`: `num_turns` 0, `result` "Command completed", no structured output | 10 of 13 | USD 0.009 |
| 075605 | Haiku review: P02, P08, P10 | through the Skill tool: 3 verdicts, 3 of 3 agree with the scorer | 13 of 13 | USD 0.009 |
| 075656 | Haiku re-review with 075605 as prior: 0 new, 0 duplicates, Q001 to Q003 still open | not run | 11 of 11 | USD 0.003 |
| 075722 | Sonnet re-review with the same prior: 2 new (P09 and one unplanned), 0 duplicates, 3 still open | both kept (0.70, 0.80), 1 of 1 labelled agrees | 17 of 17 | USD 0.159 |

**What the runs showed:**

- **A hook that is never challenged is not tested.** With the rules in the prompt, and also without them, Haiku
  escalated Q002 by itself: the policy hook never fired. Only the run whose user message pushed for the shortcut
  reached the hook, which denied the call, and the model then escalated with the hook's reason. The same lesson as the
  P6 probe: a guard is measured by the run that reaches it.
- **The richer schema helped the kind more than the recall.** Recall stayed at 22 of 23; kind and severity agreement
  rose. Copied `sides` let code catch a wrong `conflict_detected` and send it back with a precise error.
- **A crash cost nothing twice.** The resume paid for 8 cases, not 12, and the partial report said what it did not
  cover instead of reading as a clean bill.
- **The verifier's confidence barely separates right from wrong** (0.78 against 0.72), and the 0.6 to 0.8 band was
  71% accurate. Taken at face value, a confidence of 0.7 means little; calibrated, only 0.9 and over earned automation
  here, and that was 18% of the findings. The figure is from 34 items: one more error at 0.9 would move it.
- **A calibration is only as good as its labels.** Three of five "verifier errors" were the scorer's anchor rule
  labelling a different question as a false positive. Reading the wrong rows by hand is part of the method, not an
  extra.
- **Giving a verifier only the cited pages is a trade-off.** It keeps the context small and blind to the reviewer, but
  a finding about a cross-reference (SC-10-F03 points to SC-03-F02) can only be judged with the referenced page. The
  next step would add the pages of items the cited rows reference.
- **A forked skill typed as a slash command in `claude -p` gives back nothing.** Claude Code 2.1.310 ran the fork
  (tokens were spent) but returned `"Command completed"` with no structured output. Asked to call the skill through
  the Skill tool, the main model got the fork's answer and filled the schema. `subagent_stats.spawned` stayed 0 in
  both cases, so it cannot show whether a fork ran.
- **A re-review with the prior findings stays quiet as asked, and the model sets the ceiling.** Both re-reviews
  placed every prior ID and repeated none. Haiku found nothing new on SC-05; Sonnet found P09, which Haiku's first
  review had missed, for 17 times the cost. P07, a cross-page contradiction, was missed by all four sessions.

Spent on P7: USD 0.53 (A1 0.010, A2 and A6 0.273, A3 and A4 0.064, A5 0.181). Total so far: USD 5.34 of 30.
