# API test automation: strategy and findings

This document answers the four questions of the project briefing, using what was built and measured on the simulated environment:

1. What is the test strategy for the two services?
2. How do we build a first smoke suite that runs locally and in the pipeline, step by step?
3. What questions must be answered and what permissions granted? The full list is in [02-adoption-guide.md](02-adoption-guide.md); section 3 here explains why each one matters.
4. What are the risks, and how do we reduce them?

Every number below comes from a run on the simulation (MacBook, Docker 29, 8 Playwright workers) on 2026-10-29.

## Contents

1. [Test strategy](#1-test-strategy)
2. [The first smoke suite, step by step](#2-the-first-smoke-suite-step-by-step)
3. [What the experiments showed](#3-what-the-experiments-showed)
4. [Findings that apply to the real project](#4-findings-that-apply-to-the-real-project)
5. [Risks and mitigations](#5-risks-and-mitigations)

## 1. Test strategy

### 1.1 Starting point

The briefing describes the current state:
- **Tests that exist:** unit tests with JUnit 5 and Mockito, controller tests with MockMvc, H2 in place of the real database, JaCoCo coverage.
- **What is missing:** integration tests, API tests against a deployed service, end-to-end tests, a contract (no OpenAPI), and tests in CI.
- **What the services depend on:** many AWS services and third parties. Authentication is handled outside the repository.

The gap is not "more unit tests". Nothing today checks the services as a client sees them. Nobody checks the protocol headers, the envelope, the security per prefix, the real SQL, the calls between A and B, or the asynchronous flows.

### 1.2 Layers

| Layer | Tool | Runs where | Catches | Owner |
|---|---|---|---|---|
| Unit | JUnit 5, Mockito (exists) | `mvn test`, every build | Business rules in services, in isolation | Developers |
| Controller and contract source | MockMvc with springdoc (one new test per service) | `mvn test`, every build | Generates the OpenAPI document at build time, without starting a server or opening `/v3/api-docs` anywhere | Developers |
| Repository integration | `@MybatisTest` with Testcontainers on the real database engine | `mvn verify` (Failsafe), every build | SQL that H2 accepts but the real engine treats differently (locking, upsert, date arithmetic) | Developers |
| Contract drift | Playwright `@contract`, OpenAPI diff | Every build (from the build output) and after each deploy (live, where allowed) | A renamed or removed field, a new required input, a changed type, before a client finds it | QA with developers |
| API smoke | Playwright `@smoke` | After each deploy, every environment, read-only | The deploy works: every caller group can authenticate and reach both services, and the protocol is intact | QA |
| API regression | Playwright, all other specs | After each deploy to an environment where writes are allowed | Validation, error codes, security per prefix, A to B calls, third-party faults, asynchronous flows | QA |
| End-to-end across systems | Out of scope for the first quarter | Staging, manually triggered | Real third parties and real mobile/web clients | Later |

The API layer drives the services over HTTP from outside, through the same load balancer the clients use. It does not mock anything inside the services. It treats them as black boxes, and its findings hold for what is actually deployed.

### 1.3 Why Playwright Test for an API suite

- **Fixtures.** Each test gets the caller it needs (a user, the back office, an API key, a partner key, anonymous) without login code in the test. Fixtures are typed and have a worker or test scope.
- **Parallelism with isolation.** Workers run in parallel, and each worker owns a test user and a unit. 64 tests take 4 s.
- **Built-in reports.** HTML for people, JUnit XML for the pipeline, retries and traces, all without extra libraries.
- **The same tool later.** If the web prefix gets UI tests, they use the same project, fixtures and pipeline stage.
- **TypeScript.** The suite is code with a type check, not a collection of recorded requests.

### 1.4 What is in scope per prefix

| Prefix | Caller | Auth | What the API tests cover |
|---|---|---|---|
| `/app/**` | Mobile app user | Bearer token, scope user, owner check (token subject must equal the path's user id) | Own data, validation, error codes, another user's data refused |
| `/web/**` | Web user | Same as app | The same profile through the web prefix, consents |
| `/bo/**` | Back-office operator | Bearer token, scope backoffice | Search, paging, unlock, export, VIN registration, SIM activation |
| `/internal/**` | Other services | `X-Api-Key` | User status, push, owner lookup; the key is required |
| `/partner/**` | External workflow, carrier | `X-Partner-Key` | Callbacks: idempotency, conflicts, unknown ids |
| `/health` | Load balancer | none | Smoke and the suite's own pre-check |

### 1.5 Test data strategy

- **Pools, one entry per worker.** Each environment lists test users (`accounts.pool`) and units (`tcuPool`). Worker *n* only uses entry *n*, so parallel tests never touch the same user. The number of workers is capped by the pool size.
- **Create, do not share.** Tests that need a vehicle create one with a random VIN under the `PWT` prefix, which no real vehicle has. A test never depends on data another test made.
- **Put back what you change.** Tests that change shared state restore it in `afterEach`: the PIN, the lock (unlocked through the back office), the unit's SIM status (through the carrier's callback), devices.
- **Accept growth for append-only records.** Some records cannot be deleted through the API: registrations, ended ownerships, export jobs. Each full run leaves about 7 VINs, 4 ended ownerships, 1 subscription and 2 export jobs, all with test prefixes. They need a periodic purge on shared environments (section 5).
- **Seeded reference data.** Search and export tests need known data: 8 pool users, and 4 users created in March 2026. The data is seeded once, and the tests check counts relative to the seed.

### 1.6 Asynchronous flows

- **Polling with a deadline.** The CSV export is requested, then the test polls the status until DONE with `expect.poll`, a 15 s deadline and intervals of 0.5 then 1 s. A flow that never finishes fails with the last status in the message, not a timeout with no detail.
- **Callbacks played by the test.** For the VIN workflow and the SIM carrier, the test acts as the external system. It reads the execution id from the response and calls the partner callback itself. It can then check success, failure, idempotency (the same result twice is OK) and conflicts (a different result later is E250). Waiting for a real workflow is not needed for any of these.
- **Downstream effects through the journal.** Events, mails, pushes and charges are read from WireMock's request journal, filtered by the request's uuid, which the services forward downstream, including from the export job.

### 1.7 Third parties

- **On a test environment:** WireMock stands in for every third party. Default stubs answer the happy path. A test adds a priority-1 stub matched on its own uuid for a fault: 503, 402, or a delay longer than the service's timeout. This is safe with parallel tests, because other tests' requests do not match.
- **Where the third parties are real** (staging): the `@stub` tests are skipped (`stubs: false`). Everything else still runs.

## 2. The first smoke suite, step by step

The smoke suite answers one question after a deploy: does each caller group get through to each service, with the protocol intact? It is read-only, so it is safe on any non-production environment, including shared ones. It is also the pipeline's gate: when it fails, the rest does not run.

### Step 1. Agree the target and the access

Before writing a test, get answers to questions Q1 to Q8 of the adoption guide: environment URLs, how test tokens are obtained, the two API keys, the test users, and network access from the pipeline to the load balancer. Without these, nothing runs.

### Step 2. Create the test project

Copy `tests/` from this PoC into the real repository, next to the two services or in its own repository. Keep `src/`, `playwright.config.ts`, `package.json`, `tsconfig.json`, `scripts/` and `envs/integration.example.json`. Delete the specs except `smoke.spec.ts` and `framework.spec.ts`. Then run `npm ci` and `npm run framework`: the framework tests run without any service.

### Step 3. Describe the environment

Copy `envs/integration.example.json` to `envs/<env>.json`, with:
- the service URLs as `${PW_BASE_URL_A}` and `${PW_BASE_URL_B}`;
- `allowWrite: false`, `stubs: false`, `apiDocs: false` to start;
- the two pool users as `${PW_TEST_USER_1}` and `${PW_TEST_USER_2}`.

Put the real values in an uncommitted `envs/<env>.env`. The `.gitignore` in `tests/` already excludes it.

### Step 4. Get tokens

If the IdP lets the pipeline mint tokens for test users (a client-credentials client, or a test-only connection), adapt `src/auth.ts` to call it. If not, start with `auth.kind: "env-token"`: the pipeline passes `PW_USER_TOKEN_1`, `PW_USER_TOKEN_2` and `PW_BO_TOKEN` as secrets. Short-lived tokens make this a stopgap, so ask Q1 early.

### Step 5. Adapt the smoke tests to real endpoints

`smoke.spec.ts` has 8 tests:
- health of both services;
- a user reads their own profile through app;
- the same profile through web;
- the back office searches;
- an internal key reads a user's status;
- service B lists a user's ownerships;
- service B reads a unit;
- a call with no credentials is E101.

Replace the paths with the real ones: one read-only endpoint per caller group and service. Keep the shape: every call through `toBeOk` or `toBeNg`. The protocol checks then run on every call.

### Step 6. Run it locally against the integration environment

Run `TEST_ENV=<env> npm run smoke`.
- If it fails on `X_ERROR_CODE`, `X_EVENT_TIME` or the uuid echo, it found a real protocol gap. Write it down; do not loosen the matcher.
- If a field in the envelope is unexpected, the contract snapshot is wrong. Fix the snapshot, not the matcher.

### Step 7. Add the pipeline stage

Add the stage after the deploy to the integration environment:
1. Run `scripts/pipeline.sh` (reference: `pipeline/buildspec.yml` for CodeBuild).
2. Read the secrets from the secret store.
3. Publish `results/*/junit.xml` as a test report and `results/` as an artifact.
4. Run the build inside the VPC if the load balancer is internal.

Start the stage as non-blocking for a week, measure flakiness, then make it a gate.

### Step 8. Grow from the smoke suite

Add the next stages in this order:
1. **The contract:** add springdoc to both services and the MockMvc test that writes the spec, then `npm run contracts:update` and review the snapshot.
2. **Security tests:** read-only, high value.
3. **Validation and error-code tests:** read-only, or writing only to the test users.
4. **Write flows:** only on an environment where `allowWrite` is agreed.
5. **Fault injection:** only where third parties can be stubbed.

## 3. What the experiments showed

| # | Experiment | Result |
|---|---|---|
| 1 | Full suite on a fresh stack | 64 passed in 3.7 to 4.1 s with 8 workers; 3.6 s with 4 workers; 9.4 s with 1 worker. The export flow (a 2 s queue delay) is the longest test |
| 2 | Flakiness, `--repeat-each=5` | 320 of 320 passed in 12.2 s; no flaky test. Isolation by worker pools holds under repetition |
| 3 | Read-only run (`PW_ALLOW_WRITE=false PW_STUBS=false`) | 30 tests ran and passed in 1.5 s: smoke, security, framework, contract, and the read-only protocol and validation tests. The 34 `@write`/`@stub` tests were filtered out before running, not failed |
| 4 | The pipeline stage inside a container (`docker compose --profile ci run --rm tests`) | Exit 0 in 23 s, including `npm ci` (2 s); stages framework 6, smoke 8, contract 2, full 48 |
| 5 | Contract drift: `UserProfile.email` renamed to `mailAddress` | Caught three ways (details below the table) |
| 6 | The MockMvc-generated spec against the live `/v3/api-docs` | Identical for both services (A: 16 paths, 27 schemas; B: 11 paths, 18 schemas) |
| 7 | Repository test on PostgreSQL with Testcontainers | 3 tests in 4.5 s, container start included; all of `mvn verify` takes 17 s |
| 8 | Tomcat's relaxed characters turned off (`RELAXED_CHARS=''`) | A raw `\|` in the path gets Tomcat's own HTML 400 page, before Spring: no envelope, no `X_*` headers. The percent-encoded `%7C` still works. The protocol test caught it; every other test passed, because the client encodes by default |

How experiment 5 caught the rename:
1. **The build-time diff,** with no service running, about 8 s after the change: "200.data.email: response field removed" on the app and web operations.
2. **The smoke suite:** both profile tests failed on "must NOT have additional properties: mailAddress".
3. **The live drift test** and two protocol tests that read the profile.

What the results mean:
- **Speed is not the constraint.** Even a suite 10 times larger stays under a minute. The time goes to environment start (about 20 s) and to deploys, not to the tests.
- **The build-time contract check (experiments 5 and 6) is the cheapest guard.** It needs no environment and no open `/v3/api-docs`, and it runs on a pull request before anything is deployed. The MockMvc spec equals the live spec, so the build output can be trusted as the contract source.
- **The strict response schema matters.** A schema that allows extra properties would have passed the renamed field: `email` is not marked as required. `additionalProperties: false`, added by the validator, is what turned the rename into a failure.

## 4. Findings that apply to the real project

These came up while building the simulation and the tests. Each is likely to apply to services A and B too.

| # | Finding | Why it matters | What to do |
|---|---|---|---|
| F1 | springdoc lists 201 and 202 responses under "200" unless the controller says otherwise | The contract's status codes are wrong for create and accept operations | The validator falls back to the "200" schema, so tests still pass. For an accurate contract, add `@ApiResponse(responseCode = "201")` or `@ResponseStatus` to those methods |
| F2 | Custom composed constraints (`@UserId`, `@Vin`) appear in the spec only as `type: string`; the pattern is lost | The contract does not describe what input is valid; clients guess | Keep explicit validation tests per field (the specs do this for VIN, PIN, user id, model code, nickname, plan, ids). Optionally add `@Schema(pattern = ...)` next to the constraint |
| F3 | H2 in PostgreSQL mode accepts SQL that behaves differently on the real engine: `FOR UPDATE SKIP LOCKED`, `ON CONFLICT`, date ranges | Repository tests on H2 pass while the deployed queue or upsert misbehaves | One Testcontainers repository test per mapper with engine-specific SQL. Here: 3 tests, 4.5 s |
| F4 | `/v3/api-docs` is open when springdoc is added with defaults | It publishes the whole API surface | Generate the spec at build time (MockMvc) and keep `springdoc.api-docs.enabled=false` on every deployed environment, or at least in production |
| F5 | A valid token without the right key gets 403 E102 on `/internal` and `/partner`; no key gets 401 E101 | Both are defensible, but tests and clients need one agreed rule | Confirm the rule (Q14) and write the security tests to it |
| F6 | A raw `\|` in the path depends on Tomcat's `relaxed-path-chars`; without it the client gets an HTML 400 outside the envelope | User ids contain `\|`; a mobile client that does not encode breaks with an unreadable error | Ask how the real clients send user ids, and whether the services set relaxed characters (Q15). Keep the protocol test that sends both forms |
| F7 | Correlating downstream calls needs the services to forward `X-One-Time-Uuid`, including from background jobs | Without it, a test cannot fault one request in a shared stub server or read only its own downstream calls | Check whether A and B forward it (Q12). If not, stubs need another key (the VIN, the user id), and parallel fault tests get harder |
| F8 | A scheduled background worker starts in every Spring test context | It ran during the OpenAPI test and touched the database | Put background workers behind a property (`@ConditionalOnProperty`) and turn it off in tests that do not need it |
| F9 | Some flows change state that a test must put back: the PIN, the lock after five wrong PINs, the SIM status | Without the reset path, a failed test leaves a user locked and later runs fail for an unrelated reason | Every such flow needs an API reset path for test users: a back-office unlock, a callback. Ask for one where it is missing (Q10) |
| F10 | Downstream timeouts turn into E611 only if the client has a timeout | A slow third party would otherwise hold a request thread until the load balancer's timeout | Test each third party with a delay stub longer than the service's timeout, and assert E611 within the timeout (the payment test asserts under 2.9 s for a 2 s timeout) |

## 5. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| No way for the pipeline to get test-user tokens (auth outside the repo, IdP not ours) | High | Blocks everything except health | Ask Q1 first. Interim: tokens as pipeline secrets (`env-token` mode), refreshed by a scheduled job. Fallback: a test-only IdP client limited to test users |
| Shared environment data changed by tests | Medium | Other teams see test data, or tests break their data | Start with `allowWrite: false`. Writes only on an agreed environment, only to pool users and `PWT` VINs, with a weekly purge by prefix (Q11) |
| Test users locked or changed by a failed run | Medium | Later runs fail for an unrelated reason | `afterEach` resets (unlock, PIN restore). A pre-run reset step through the back office. One user per worker, so damage stays with one worker |
| Third parties cannot be stubbed on shared environments | High | Fault tests (E610, E611) cannot run there | `@stub` tests run only where the third parties' URLs point to WireMock (an ephemeral or dedicated test environment). They are skipped elsewhere, not failed |
| The contract snapshot is wrong, or updated without review | Medium | Real breaking changes pass | Generate from MockMvc in the build, keep the snapshot in git, change it only through `contracts:update` in the same pull request as the code, and make the diff a review item |
| Flaky tests from asynchronous flows | Medium | The gate loses trust | Polling with deadlines, never sleeps. Test callbacks instead of waiting for real workflows. One retry in CI, and a retried test is reported as flaky. Measure for a week before the gate blocks (step 7) |
| The pipeline cannot reach an internal load balancer | Medium | The stage cannot run | CodeBuild in the VPC with a security group the ALB allows (Q16, P3) |
| Secrets leak through reports | Low | Credentials exposed | Masking of headers, secret fields and emails in every recorded call (tested in `framework.spec.ts`). Secrets only from the secret store. Reports kept as pipeline artifacts with access limited to the team |
| The suite reaches production by mistake | Low | Real users' data changed | `guard()` refuses any environment marked production or with "prod" in its name, whatever the flags (tested). The production URL is never in any environment file |
| Behaviour differs between the simulation and the real services | Certain | Specs need adapting | The framework is generic. The specs are patterns; their paths, codes and data come from the real services. Section 2 starts from the smoke suite only |
