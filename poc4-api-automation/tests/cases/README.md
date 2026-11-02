# Test-case catalogue

Every automated API test has a case here, written in plain language, that says which product feature and which business rule it protects. A reader who has never opened a spec can tell from this folder what the suite covers, what it does not, and why each test exists. `scripts/cases.mjs` keeps this folder, the specs and the product source in step.

| File | What it is |
|---|---|
| `<area>/<name>.md` | One feature: its cases, the specs that automate them, and the source files that implement it |
| `_template.md` | The starting point for a new feature |
| `TRACEABILITY.md` | Generated (`npm run cases:matrix`): every case, its status, its tests and its operations, plus the uncovered operations |
| `review.lock.json` | Generated (`npm run cases:stamp`): when each feature was last reviewed against its source |

## A feature file

```markdown
---
feature: A-PIN                      # the feature id: capitals and digits, one optional dash (A-PIN, SMK)
title: PIN of a user
service: a                          # the service whose contract the bare operations below belong to
specs:
  - specs/service-a/pin.spec.ts     # the spec files that automate these cases
source:                             # the product code this feature depends on, as <root>:<glob>
  - service-a:src/main/java/**/PinController.java
  - service-a:src/main/java/**/PinService.java
---

# A-PIN: PIN of a user

One paragraph: what the feature is for, who uses it, and anything a tester must know (state it leaves behind, data it needs).

## A-PIN-01 A user changes their PIN
- **Rule:** The business rule, in one sentence.
- **Given:** The starting state and data.
- **When:** The action.
- **Then:** The expected outcome, in product terms (the codes and fields that matter).
- **Operations:** `PUT /app/v1/users/{userId}/pin`
- **Status:** automated
- **Notes:** Anything else (a known defect, a question for the product team).
```

Rules:
- **Ids.** A case id is the feature id plus a two- or three-digit number: `A-PIN-01`. Get the next one with `npm run cases:next-id -- A-PIN`. Ids are never reused: a case that is dropped is deleted, and its number stays unused.
- **Fields.** `Rule`, `Given`, `When` and `Then` are required. `Operations` lists the API calls the case makes, each in backticks as `METHOD /path` with the contract's path template; prefix it with a service (`b GET /bo/v1/tcus/{tcuId}`) when it belongs to another service than the front matter's. `Status` is `automated` (the default), `planned` (written, not yet automated) or `manual` (checked by hand, never automated).
- **Headings.** A case is a `## <ID> <title>` heading. Any other `##` heading ends the case (use it for notes about the feature); `###` headings may go inside a case.
- **Source roots** are named in `kit.config.json` (`roots`). Globs are git pathspec globs: `**` crosses folders, `*` does not.
- **Language.** Write for a product owner or a new tester: the business terms of the product, not the test's code. Say "a locked user", not "user with `locked=true` in fixture B".

## A test

Each test names exactly one case, with a tag:

```ts
test('a user changes their PIN', { tag: ['@A-PIN-01', '@write'] }, async ({ userA }) => {
  ...
});
```

The test's title may differ from the case's; the tag is the link. Other tags (`@smoke`, `@write`, `@stub`, `@contract`, `@framework`) keep their meaning. Run one case with `npx playwright test --grep @A-PIN-01`, or a feature with `--grep @A-PIN-`.

## The lifecycle

| When | Command | What it tells you |
|---|---|---|
| Before writing or changing a test | `npm run cases:next-id -- <FEATURE>` | The id for a new case. Write the case first, then the test |
| Before every commit (and in the pipeline) | `npm run cases:check` | A test without a case, a case without a test, a tag that names no case, a missing field, an outdated matrix. Exit code 1 on any error |
| After the product source changes | `npm run cases:impact` (`-- --base origin/main` for a branch) | The features, cases and specs whose source or contract changed, the command to run just those tests, and the changed source no feature maps |
| After reviewing a feature against its new source | `npm run cases:stamp -- <FEATURE>` | Records the review; the feature stops being reported as stale |
| After any change here | `npm run cases:matrix` | Rewrites `TRACEABILITY.md` |
| Before a release, or weekly | `npm run cases:check -- --strict` | Also fails on stale features, source no feature maps, and contract operations no case covers |

A feature is **stale** when the source files it maps have changed since its last stamp. Stale does not mean wrong: it means nobody has yet checked that the cases still describe what the code does. The review is: read the source diff (`cases:impact` names the files and the commits), update the cases' text, change or add tests, run them, then stamp.

An operation a case does not need to cover (a debug endpoint, for instance) goes in `kit.config.json` under `uncoveredOperations`, with the reason, so that `--strict` stops reporting it.
