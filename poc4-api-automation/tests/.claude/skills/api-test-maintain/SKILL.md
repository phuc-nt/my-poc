---
name: api-test-maintain
description: Diagnose and fix failing, flaky or outdated API tests, and refactor the suite without losing coverage. Use when a test run fails, when a test is flaky, when asked to "fix the tests", "clean up the specs", "rename / move / split / remove a test", or after a framework change.
---

# Maintain the API tests

Read `AGENTS.md` first.

## 1. Triage a failure before touching code

Get the facts from the run: the failing test, its case tag, the assertion, and the attached call log (`api-calls.json` in the report: masked requests and responses with their `X-One-Time-Uuid`). `npm run report` opens the last HTML report. Then decide which of these it is:

| Kind | Signs | What to do |
|---|---|---|
| Product changed on purpose | The source or the contract changed (`npm run cases:impact` names the feature) and the new behaviour is the intended one | Use the api-test-sync skill: update the case, then the test |
| Product defect | The code changed or was always so, and the case's `Rule` still holds | Do not change the assertion. Report it with the case id, the request and the response (masked). Mark it `test.fail()`, with a `Notes:` line on the case, only once a person confirms it is a known defect |
| Test defect | Wrong expectation, wrong data, a missing `@write`, an order dependency, missing clean-up | Fix the test; re-read the case to keep it the source of truth |
| Environment or data | 401 on everything, unreachable service, a pool user locked, seeded data missing | Fix the environment (api-test-env skill), not the test. Unlock or reset the data |
| Flaky | Passes on retry; timing, async polling, a shared record | Find the race. Poll with `expect.poll` and a deadline instead of sleeping; use the worker's own data. Never only add retries |

Run the single case again with `--grep @<CASE-ID>` and `--repeat-each 5` before and after the fix.

## 2. Keep the case and the test together

- Changing what a test checks: change the case's `Then` (and `Rule` if the rule changed) in the same change.
- Renaming or moving a test: keep its case tag. Moving it to another spec: update the feature's `specs:` list.
- Splitting a test: each part gets its own case (`cases:next-id`), or the parts stay one test.
- Removing a test: remove its case (or mark it `manual` with the reason). Never leave a case `automated` with no test; `cases:check` fails on it.
- Merging duplicates: keep the clearer case, delete the other, retag. Ids are never reused.

## 3. Refactor safely

- Count before and after: `npm run cases:matrix` and compare the case and test totals; the coverage must not drop by accident.
- Shared helpers belong in `src/` only when three or more specs need them; framework changes need a test in `specs/framework.spec.ts` and a passing `npm run framework`.
- Never weaken the guards (`src/env.ts`, the write guard in `src/api-client.ts`, `src/mask.ts`) to make a test pass.

## 4. Finish

```bash
npm run typecheck
npx playwright test --grep "<the cases you touched>"
npm run cases:matrix && npm run cases:check
```
Stamp a feature (`npm run cases:stamp -- <FEATURE>`) only if you also reviewed its cases against the current source. Report the failure kind, the fix, and any product defect found.
