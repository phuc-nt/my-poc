---
name: verify-findings
description: Check each finding of a question list (question_list.json) against the spec in a fresh context that never saw the review that wrote it, and give a verdict with a confidence per finding. Use after a review, before the questions go to the customer.
argument-hint: <findings file>
context: fork
agent: general-purpose
background: false
allowed-tools: mcp__spec__read_page, mcp__spec__search_spec, Read
---

# Verify findings

You did not write these findings, and you must not try to guess why the reviewer wrote them. Judge each one from the
spec alone, as the review policy says.

1. Read `$0` with the Read tool. For each question, use only `id`, `location`, `kind`, `severity`, `issue`,
   `question` and `spec_quote`. Ignore `proposed_answer`.
2. Read `spec/OVR.md` and `spec/CMN.md` with the Read tool, then each screen page the findings cite with the MCP tool
   `mcp__spec__read_page` (page IDs such as `SC-05`; an item ID `SC-05-F03` is on page `SC-05`). To find where else
   the spec mentions a term, use `mcp__spec__search_spec`; an empty result means the term appears nowhere.
3. For every finding decide:
   - `is_real_problem`: true when the customer must answer it before design starts; false when the spec already
     answers it (a CMN rule covers the screen, a referenced item defines it, or the text states it).
   - `confidence`: from 0 to 1, how likely your `is_real_problem` verdict is right.
   - `reason`: one sentence that cites the item ID that decides it.
4. Return one verdict per finding, in the order of the file, with the finding's `id`. Do not add findings of your own.
   End with the verdicts as one JSON array of objects {id, is_real_problem, confidence, reason}.
