# Adoption guide: from the simulation to services A and B

How to take what PoC 4 built and use it on the real project. It covers:
- what to copy and what to change;
- the questions to ask, and the permissions to request;
- a four-week plan.

The strategy and the reasons behind it are in [01-strategy-and-findings.md](01-strategy-and-findings.md).

## 1. What to copy, what to adapt, what to leave

### Copy as is

| From this PoC | What it gives the real project |
|---|---|
| `tests/src/env.ts` | Environment files with `${VAR}` placeholders. The production guard. The pipeline can narrow `allowWrite` and `stubs`, never widen them |
| `tests/src/mask.ts` | Masking of tokens, keys, cookies, PINs, passwords, signatures and emails in every recorded call |
| `tests/src/api-client.ts` | Path templates with encoding, uuid per call, the write guard, the recorded conversation for failure reports |
| `tests/src/contract.ts`, `contract-diff.ts` | Response validation against the OpenAPI with unknown fields refused, and the breaking-change diff |
| `tests/src/wiremock.ts` | Per-request fault stubs and journal reads keyed on the uuid (where a WireMock exists) |
| `tests/src/global-setup.ts` | A fast, clear failure when the target is down |
| `tests/playwright.config.ts` | Workers capped by the account pool, tag filtering from the environment flags, the three reporters |
| `tests/scripts/pipeline.sh` | The staged run: typecheck, framework, smoke, contract, full |
| `tests/scripts/update-contracts.mjs` | The only way the contract snapshot changes (change the build-output path to the real modules) |
| `tests/specs/framework.spec.ts` | Proof that the guards work, with no service needed |
| `tests/specs/contract-drift.spec.ts` | The build-time and live contract check |

### Adapt to the real services

| Item | What to check against the real code |
|---|---|
| `toBeOk` / `toBeNg` in `src/fixtures.ts` | The exact response header names (`X_RESULT_STATUS`, `X_ERROR_CODE`, `X_EVENT_TIME`, `X_ONE_TIME_UUID`), their values (OK/NG), and whether the uuid is echoed or generated when missing |
| `ERROR_ENVELOPE` in `src/contract.ts` | The real `RestApiResponse<T>` error shape: the field names, whether `field` exists, the `messageId` pattern (`E.<sys>.<num>`: set the system code and the digit count) |
| `src/auth.ts` | The real IdP's token call (Q1). The `env-token` mode works without code changes until then |
| `Caller` in `src/fixtures.ts` | The real caller groups and their credentials (header names of the two keys) |
| `envs/<env>.json` | One per environment, from `integration.example.json` |
| `src/data.ts` | The real VIN rules, the seeded data the search and export tests rely on |
| The specs | Patterns only: same structure, real paths, codes, fields and data |

### Add to the services (Java)

| Item | From | Purpose |
|---|---|---|
| `springdoc-openapi-ui` 1.8.x (the line for Spring Boot 2.x) | `sim/pom.xml`, `sim/common/pom.xml` | Generates the OpenAPI document from the existing controllers and Bean Validation annotations |
| `OpenApiSnapshotTest` (one per service) | `sim/service-*/src/test/.../OpenApiSnapshotTest.java` | Writes `target/openapi/service-x.json` during `mvn test`. No server, no open endpoint |
| `springdoc.api-docs.enabled=${API_DOCS_ENABLED:false}` | `sim/service-*/src/main/resources/application.yml` | The endpoint is closed unless an environment turns it on (F4) |
| Testcontainers BOM and one `@MybatisTest` IT per mapper with engine-specific SQL | `sim/pom.xml`, `ExportRepositoryIT.java` | Catches SQL that H2 accepts but the real engine runs differently (F3) |
| `@ConditionalOnProperty` on scheduled or queue workers | `ExportWorker.java` | Keeps background work out of test contexts (F8) |

### Leave behind

`sim/` (the simulated services, mock IdP, stubs and seed data) and `compose.yaml`. They are worth keeping only as a sandbox for trying a new test pattern before using it on a shared environment.

## 2. Questions for the project

Ask these in the first week. Q1 to Q8 block the smoke suite; the rest shape the later stages. The finding numbers (F*n*) refer to [01-strategy-and-findings.md](01-strategy-and-findings.md#4-findings-that-apply-to-the-real-project).

### Access and environments (block the smoke suite)

| # | Question | Why it is needed |
|---|---|---|
| Q1 | How can the pipeline get access tokens for test users and for a back-office caller? Which IdP and which grants does it allow (client credentials, a test-only connection)? How long does a token live? | Every `/app`, `/web` and `/bo` call needs one; auth is outside the repository |
| Q2 | Which environments exist (dev, integration, staging), what are A's and B's base URLs on each, and which may the API tests target? | The environment files |
| Q3 | Where are the internal API key and the partner key kept per environment, and can the pipeline's role read them? How are they rotated? | `/internal` and `/partner` tests, and the secret store set-up |
| Q4 | Can we have dedicated test users per environment (at least 2, ideally 4 to 8), plus one we may lock? | The account pool sets how many tests run in parallel without colliding |
| Q5 | On which environment may tests create and change data, and which kinds of data? | `allowWrite` per environment |
| Q6 | Is there seeded reference data, or may we seed it (users with known creation dates, units)? | Search, paging and export tests check counts |
| Q7 | Which third parties does each environment call, and can their base URLs be pointed at a stub server on a test environment? | `stubs` per environment; fault tests |
| Q8 | Which CI system runs the deploy, who owns it, and where can a test stage go after the deploy? | The pipeline stage |

### Behaviour and code (shape the later stages)

| # | Question | Why it is needed |
|---|---|---|
| Q9 | May we add springdoc and one MockMvc test per service, with the endpoint off on deployed environments? | The contract and its build-time check (F1, F4) |
| Q10 | For each state a test changes (PIN, lock, SIM status, registrations), is there an API to restore it for test users? | Clean-up after tests; without it, failed runs leave locked users (F9) |
| Q11 | Who purges test records on shared environments (VINs with prefix `PWT`, test-user ownerships, exports), and how often? | Data that the API cannot delete grows by about 14 records per full run |
| Q12 | Do A and B forward `X-One-Time-Uuid` on calls to each other, to third parties, and into queue messages? | Per-test fault stubs and downstream assertions depend on it (F7) |
| Q13 | Which database engine and version run in each environment? Which mappers use engine-specific SQL? | The Testcontainers image and which repository tests to write (F3) |
| Q14 | What is the agreed rule when a caller is authenticated but not allowed (valid token on `/internal`, user token on `/bo`): 401 or 403, and which code? | The security tests assert one rule (F5) |
| Q15 | How do the mobile and web clients send user ids containing `\|`: raw or percent-encoded? Do the services set Tomcat's relaxed characters, and does the load balancer pass a raw `\|`? | A raw `\|` can be rejected outside the envelope (F6) |
| Q16 | Is the load balancer internal? Can the CI build run inside the VPC? Are there WAF or IP rules the test runner must pass? | Network path from the pipeline to the services |
| Q17 | For the export queue and the VIN workflow: which services carry them, how long does a run take on a test environment, and can a test send the workflow's callback itself? | Polling deadlines and callback tests |
| Q18 | Exact Spring Boot, Java and Tomcat versions of both services? | springdoc and Testcontainers versions |
| Q19 | Are there rate limits on the test environments? | Parallel workers could trip them |
| Q20 | Who looks at a failed API test stage first: QA or the service's developers? | A gate nobody triages gets switched off |

## 3. Permissions to request

| # | Permission | For | Scope |
|---|---|---|---|
| P1 | Read access to both service repositories, and permission to add a test module or a test repository | The suite and the Java additions | The two repositories |
| P2 | One secret per environment in the secret store (URLs, the two keys, test user ids, IdP client for tests), readable only by the pipeline's test role | Running the suite without secrets in code | Per environment, read-only for the test role |
| P3 | A CI build project inside the VPC (subnets, a security group the load balancer accepts), with a role that can read P2's secret, write its logs and publish test reports | The pipeline stage | Test environments only; no production access |
| P4 | A test client or connection in the IdP that can issue tokens for the test users only | Q1 | Test users only |
| P5 | A back-office test identity with the back-office scope | `/bo` tests | Test environments only |
| P6 | Read access to the services' logs on test environments | Following a failed call by its `X-One-Time-Uuid` | Test environments, read-only |
| P7 | A change to point third-party URLs at a stub server on one dedicated test environment | `@stub` tests | That environment only |
| P8 | A scheduled purge of test-prefixed records, owned by the service team | Q11 | Shared test environments |

## 4. Plan

| Week | Work | Done when |
|---|---|---|
| 1 | Get answers to Q1 to Q8, and P1 to P5. Copy `tests/`, run `npm run framework`. Adapt the matchers and the error envelope to the real `RestApiResponse<T>`. Write the real smoke tests (one read-only call per caller group and service) | `npm run smoke` passes from a laptop against the integration environment |
| 2 | Add the pipeline stage after the deploy, non-blocking. Add springdoc and the MockMvc snapshot test to both services; review and commit the first contract snapshot. Run `CONTRACT_SOURCE=file npm run contract` in pull-request builds | Smoke runs on every deploy; a pull request that removes a response field fails its build |
| 3 | Security and validation tests (read-only). One Testcontainers repository test for each mapper with engine-specific SQL | The security matrix of section 1.4 in doc 01 is covered |
| 4 | Write flows on the environment agreed in Q5, with clean-up and the purge in place. Make the smoke stage blocking if the week's flaky rate is under 1% | The stage gates promotion to the next environment |
| Later | A dedicated environment, or a service-level compose run in the pipeline like this PoC's, with stubs for third parties: `@stub` tests run there | Fault behaviour (E610, E611, timeouts) is tested on every change |

### A note on the "service-level environment"

This PoC ran the full API suite against both services, their database and stubbed third parties, all inside one compose network, in 23 s including `npm ci`. The same can be done for A and B in a pipeline: build the jars, start them with a database container and WireMock, and run the suite with `allowWrite: true` and `stubs: true`. Nothing is shared, so nothing needs a purge. Every fault test runs.

The limit is the AWS services A and B use directly (queues, storage, mail). Each needs a local stand-in, or a test account resource, before this works. That is worth assessing once Q7 and Q17 are answered.
