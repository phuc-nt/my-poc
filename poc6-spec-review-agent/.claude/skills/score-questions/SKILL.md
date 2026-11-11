---
name: score-questions
description: Score a question list (question_list.json) of this PoC against the planted problems in eval/answers.json, and explain the result. Use when the user asks how good a review run was, or to compare two runs.
allowed-tools: Bash(uv run spec-review score:*), Read
---

# Score a question list

The scorer is code (`src/spec_review/score.py`), not a judgement: never grade the questions yourself.

1. Find the file. A run writes `runs/<run>/question_list.json`; the user may name a run folder instead of a file.
2. Run `uv run spec-review score <file>`. It costs nothing and needs no key.
3. Report, in this order:
   - `found` of `planted` (recall), then `found_with_kind` and `severity_agree`;
   - `missed`: the planted problem IDs no question cites;
   - `false_positives`: questions on a planted non-issue. This is an upper bound: the scorer matches by anchor ID,
     so a fair question on the same row as a trap also counts;
   - `unplanned_for_review`: questions that match nothing. A person reads these; some are fair finds.
4. When the run covered one screen, say that `planted` counts the whole spec (23 problems), so read `found` against
   the problems of that screen, not against 23.

Do not open `eval/answers.json` to argue with the scorer, and do not change it to fit a run.
