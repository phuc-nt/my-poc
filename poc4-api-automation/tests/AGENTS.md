# API test suite: rules for agents

This folder is a Playwright Test project that tests the product's REST services through their APIs. Read this file before changing anything here. The skills in `.claude/skills/` hold the step-by-step procedures; this file holds the rules they share.

## What lives where

| Path | What it is | Who changes it |
|---|---|---|
| `cases/` | The test-case catalogue: one file per feature, in plain language. Format in `cases/README.md` | You, before the test |
| `specs/` | The tests, by service and feature | You |
| `src/` | The framework: environments and guards, tokens, the API client, masking, the contract validator and diff, fixtures and matchers | Only for a framework change, with a `framework.spec.ts` test |
| `envs/<name>.json` | One target environment. Values are `${VAR}` placeholders | You, from `integration.example.json` |
| `envs/<name>.env` | The values of those variables for a laptop run. Never committed (only `local.env`, with dummy values, is) | The person running the tests |
| `contracts/` | The reviewed OpenAPI contracts responses are held to | Only `npm run contracts:update`, after a person accepts the API change |
| `kit.config.json` | Where the product source and its build-output contracts are | You, when the product's layout changes |
| `cases/TRACEABILITY.md`, `cases/review.lock.json` | Generated | Only `npm run cases:matrix` and `npm run cases:stamp` |

## Rules

1. **Case first, then test.** Every test documents a case in `cases/`. Write or update the case (`Rule`, `Given`, `When`, `Then`, `Operations`) before the code, in the product's business terms. A test whose case you cannot state in one rule is testing too much.
2. **One case tag per test.** Each `test()` carries exactly one case id in its tag option: `{ tag: '@A-PIN-01' }` or `{ tag: ['@A-PIN-01', '@write'] }`. Get new ids with `npm run cases:next-id -- <FEATURE>`. Never reuse an id that was deleted.
3. **Use the framework, not raw requests.** Call through the fixtures (`userA`, `boA`, `internalA`, `partnerB`, `anonA`, `as(service, caller)` and their B twins), with path templates and `params`: `userA.get('/app/v1/users/{userId}', { params: { userId: account.userId } })`. Check responses with `toBeOk(status?)` and `toBeNg(status, code, field?)`, which check the whole protocol and the contract. Do not assert headers or the envelope by hand.
4. **Tag what the test needs.** `@write` if it changes any data, `@stub` if it needs fault injection on a third party, `@smoke` only for the read-only smoke suite. A missing `@write` makes the test fail on a read-only environment; that is the guard working, not a bug to work around.
5. **Own data, put it back.** Use the worker's `account` and `tcuId`, never another worker's. Create what you need (`testVin()`, `pushToken()` from `src/data.ts`). Restore what you change in `finally` or `afterEach` (PIN, lock, unit status, devices). Never depend on another test's leftovers or on test order.
6. **Faults per request.** Stub a third party only for your own request: make a uuid with `crypto.randomUUID()`, register `wiremock.stubFor(uuid, { urlPathPattern, status, ... })`, then send the call with `{ uuid }`; the stub matches only that request's `X-One-Time-Uuid`. Read downstream calls with `wiremock.requests(result.uuid, path)`. Never change a global stub mapping from a test.
7. **No secrets, no personal data.** Never write a real URL, key, token, password, user id or email into a committed file, a test title, a log line or an answer. Real values come from environment variables (`envs/<name>.env`, which git ignores, or the pipeline's secret store). Seeded test users and the `local-only-*` dummies are the only literal identities allowed.
8. **Never target production.** `src/env.ts` refuses it; do not weaken that check, and do not widen `allowWrite` or `stubs` from the command line.
9. **Contracts change only on purpose.** A breaking contract difference means the product changed its API. Report it; refresh `contracts/` with `npm run contracts:update` only when a person confirms the change is intended, and update the affected cases and tests in the same change.
10. **Follow the code, not the guess.** Before writing a case's `Then`, read the controller, service and validation code the feature maps (its `source:` list). Error codes, field names and limits come from there. If the code and the expected behaviour (a requirement, a ticket, the case's `Rule`) disagree, the test asserts the expected behaviour and you report the gap in your answer: never change an assertion to match a bug. Mark such a test `test.fail()`, with a `Notes:` line on the case, only once a person confirms it is a known defect.

## Commands (from this folder)

| Command | When |
|---|---|
| `npm run typecheck` | After every code change |
| `npm run framework` | After any change in `src/`; needs no service |
| `npx playwright test --grep @A-PIN-` | Run one feature (or `@A-PIN-01` for one case) |
| `npm run smoke`, `npm test` | A wider run; needs the target environment up |
| `npm run cases:check` | Before you finish: every test has a case and every case a test, the matrix is current |
| `npm run cases:impact` | After the product source or its API changed: what to review and what to run |
| `npm run cases:stamp -- <FEATURE>` | After you reviewed a feature against its current source |
| `npm run cases:matrix` | After any change in `cases/` or a test's tags |

`TEST_ENV=<name>` picks `envs/<name>.json` (default `local`). On the simulation, the services start with `docker compose up -d --build --wait` from the folder above.

## Done means

- `npm run typecheck` passes, and the tests you touched pass on an environment that allows them (or you said why they could not run);
- `npm run cases:check` passes, with `cases:matrix` rerun;
- every feature you reviewed is stamped, and your answer lists the cases you added, changed or removed, and any behaviour that looks like a product defect.
