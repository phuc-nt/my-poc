# The agent kit: tests that stay in step with the product

A kit that lets a coding agent (Claude Code, or any agent that reads `AGENTS.md`) do four jobs on the API test suite:
- set up where the tests run;
- write tests;
- maintain them;
- keep them current as the product's source changes.

Every test is tied to a plain-language test case. A reader can see which feature and which business rule a test protects without reading its code.

Everything lives in `tests/`, so the kit travels with the suite when it is copied to the real project ([02-adoption-guide.md](02-adoption-guide.md)).

## 1. The parts

| Part | Path | What it does |
|---|---|---|
| Rules | `tests/AGENTS.md` (`tests/CLAUDE.md` imports it) | What lives where, the ten rules every change follows (case first, one case tag per test, the fixtures and matchers, data isolation, no secrets, contracts change only on purpose), the commands, and what "done" means |
| Skills | `tests/.claude/skills/` | Step-by-step procedures the agent loads when a request matches |
| | `api-test-env` | A new target environment, the local simulation, the pipeline stage, linking the kit to a product repository |
| | `api-test-write` | From the code to the cases to the tests, and proving a new test can fail |
| | `api-test-maintain` | Triage of a failure (product change, product defect, test defect, environment, flaky), keeping a case and its test together through renames, splits and removals |
| | `api-test-sync` | After a source or API change: find the impacted features, review each against its diff, update cases then tests, close the gaps, stamp |
| Case catalogue | `tests/cases/` | One Markdown file per feature: its cases (`Rule`, `Given`, `When`, `Then`, `Operations`, `Status`), its specs, and the product files it depends on. Format: `tests/cases/README.md` |
| Tooling | `tests/scripts/cases.mjs`, `tests/kit.config.json` | `check`, `impact`, `stamp`, `matrix`, `next-id` (as `npm run cases:*`). No dependency beyond Node 22 and git |
| Generated | `cases/TRACEABILITY.md`, `cases/review.lock.json` | The matrix of features, cases, tests and operations; when each feature was last reviewed against its source |
| Guards | `tests/.claude/settings.json` and `scripts/hooks/stop-check.sh`; `scripts/pipeline.sh` | A Claude Code Stop hook that will not let the agent finish while the catalogue and the tests disagree; the same check as a pipeline step |

The skills are plain Markdown. Claude Code loads them on its own. Another agent can be pointed at them from `AGENTS.md`, which most coding agents read.

## 2. How a test is tied to a case and to the code

```
cases/service-a/pin.md                                     specs/service-a/pin.spec.ts
---                                                        test('a wrong PIN is E204 ...',
feature: A-PIN                                                  { tag: '@A-PIN-01' }, ...)
specs: [specs/service-a/pin.spec.ts]
source:                                     ──────────►   product files whose change
  - service-a:src/main/java/**/controller/AppUserController.java   makes A-PIN "stale"
  - service-a:src/main/java/**/service/UserService*.java
  - common:src/main/java/**/validation/Pin.java
---
## A-PIN-01 A wrong PIN says how many attempts are left
- **Rule:** ...   - **Given:** ...   - **When:** ...   - **Then:** ...
- **Operations:** `PUT /app/v1/users/{userId}/pin`   ──►   operations of contracts/service-a.json
```

- **Test to case.** The test's tag carries the case id. `check` lists the tests with Playwright, with no service needed, and matches the tags against the case headings. Then:
  - a test without a case is an error;
  - so are a case marked automated with no test, a tag that names no case, and a test with two case tags.
- **Case to API.** `Operations` name operations of the reviewed contract. `check` errors on an operation that is not in the contract, which means it was renamed or removed. `--strict` also errors on a contract operation that no case covers.
- **Feature to source.** `source` lists the product files as `root:glob`, with the roots named in `kit.config.json`.
  - `stamp` records a hash of those files and the commit of each root in `review.lock.json`. When the hash changes, the feature is **stale**.
  - Stale does not mean the tests are wrong. It means nobody has checked them against the new code yet.
  - `--strict` also errors on product files in scope that no feature lists, so new code cannot slip past the catalogue.

## 3. The lifecycle

| Moment | Who | What runs | Result |
|---|---|---|---|
| A new feature or endpoint | Agent, `api-test-write` | read the code → write cases → `next-id` → tests → `typecheck`, run → `check`, `matrix`, `stamp` | Cases and tests together, the matrix updated |
| Any agent session that touched specs, cases or the framework | Stop hook | `cases.mjs check` | The agent cannot stop with a test that has no case, or a case left without its test |
| Every pipeline run | `scripts/pipeline.sh` | `cases.mjs check`, after the TypeScript check | The same guard for people. Where only `tests/` is present (the compose container), only the catalogue is checked |
| A product change (a merged pull request, a release, a branch) | Agent, `api-test-sync` | `cases:impact` (`--base <ref>` for a branch) → review per feature → update cases, then tests → `stamp` → `check --strict` | Impacted features named with their changed files, contract changes (breaking or not), the cases on changed operations and a `--grep` run command |
| A failed or flaky run | Agent, `api-test-maintain` | triage → fix the right thing → keep the case in step | A product defect is reported, never "fixed" in the assertion |
| Before a release, or weekly | Person or scheduled agent | `cases:check -- --strict` | Zero stale features, zero unmapped source, zero uncovered operations |

`impact` combines two signals:
- **The source diff.** The git diff of each root since the commit recorded at the feature's last review, or since `--base`.
- **The contract diff.** The OpenAPI the build writes, compared with `contracts/` using the same `diffContracts` the drift test uses. A renamed response field shows up as breaking, together with the cases that call that operation, even when the feature's `source` list missed the DTO.

## 4. What the trial showed

The kit was tried on this PoC: 14 features, 64 cases and 64 tests, with every product file in scope mapped.

- **Source change.** One line was added to the VIN validator in `common`. `impact` named B-VIN, its six cases and the command to run them.
- **Contract change.** The profile's `email` was renamed `mailAddress` in the build output. `impact` reported two breaking and two information changes on the two profile operations, in every feature that calls them: SEC, SMK, A-PIN and others. Each came with the cases on those operations.
- **Stop hook.**
  - A test was retagged with a case id that does not exist. The hook blocked the stop with exit 2, naming the unknown tag and the case left without its test.
  - With `stop_hook_active` set, it let the agent stop, so it cannot loop.
  - With no uncommitted changes in specs, cases or src, it did not run at all.
- **A headless agent (Claude Code, Sonnet) with only the kit.**
  - The task: a sandbox copy with one product commit that lowers the PIN attempt limit from 5 to 3. The agent was told to bring the tests up to date without starting the environment.
  - Result: in 11 turns and under a minute, the agent did the following.
    - It ran `impact`, which named A-PIN, A-BOS and A-INT, since all three map the changed service class.
    - It read the diff and changed the text of A-PIN-01 ("2 attempts left") and A-PIN-03 ("the third wrong PIN locks"), then the two tests.
    - It stamped A-BOS and A-INT as unaffected. It passed `typecheck` and `check --strict`.
    - It said which runs were still needed.
    - Without being asked, it pointed out that the product's own unit test still assumed five attempts. A `mvn verify` confirmed it: `UserServiceImplTest.wrongPinCountsAttempt` fails on the new code.
  - Verification: the changed services were then started. The three features' 10 tests passed, and so did all 64.

## 5. Limits

- **Granularity is the file.** A service class shared by several features makes all of them stale when any method changes. The agent then reviews and stamps the features whose behaviour did not change. This costs review time, not correctness. Mapping narrower files reduces the noise.
- **Stale is a prompt, not a verdict.** A feature can be stale with correct tests (after a refactor), and fresh with wrong ones. Examples: a rule implemented in a file the feature does not list, or a behaviour change in configuration outside `sourceScope`. The contract diff covers the API surface. The rest relies on a good `source` list and on `--strict`.
- **The hook is Claude Code only.** Other agents get the same check from the pipeline and from the "done means" list in `AGENTS.md`.
- **Plain language ages too.** `check` proves that each case has its fields and its test. It cannot prove that the text still matches the assertion. That is what the review step of `api-test-sync` is for, and why a stamp means "a person or an agent read this against the code".

## 6. Adopting it

1. Copy `tests/` as the adoption guide says. The kit comes with it: `AGENTS.md`, `CLAUDE.md`, `.claude/`, `cases/`, `kit.config.json`, `scripts/cases.mjs` and `scripts/hooks/`.
2. Delete the PoC's case files, `TRACEABILITY.md` and `review.lock.json`. Keep `README.md` and `_template.md`.
3. In `kit.config.json`, point `roots` at the real modules (for example `"service-a": "../service-a"`). Set `sourceScope` to their `src/main/**`, and set `contracts` to their build-output OpenAPI ([02-adoption-guide.md](02-adoption-guide.md), section 1, springdoc).
4. Ask the agent to write the cases for the first features (`api-test-write`), starting with the smoke suite. Then run `cases:check -- --strict` and work through the unmapped source feature by feature.
5. Add `npm run cases:check -- --strict` as a pull-request check in the product repositories, once the catalogue is complete. Run `cases:impact -- --base origin/main` there too, and post its report on the pull request, so the developer sees which tests the change touches.
