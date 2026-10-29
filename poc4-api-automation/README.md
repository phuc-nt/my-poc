# API Automation (PoC 4)

API test automation with Playwright Test for two Spring Boot REST services, worked out on a simulated environment that copies the real project's shape. That project has two services (A and B, Spring Boot 2.x, Java 11, MyBatis), the `RestApiResponse<T>` envelope, the `X-One-Time-Uuid` protocol headers, path prefixes per caller group (app, web, bo, internal, partner), user ids that contain `|`, asynchronous flows (CSV export through a queue, VIN registration through an external workflow), many third parties, no OpenAPI and no API tests in CI.

The simulation runs on Docker on one laptop. Everything built here (the test framework, the specs as patterns, the pipeline stage, the contract check) is meant to move to the real project. The parts that stay behind are the simulated services and their stubs.

Documents:
- [docs/01-strategy-and-findings.md](docs/01-strategy-and-findings.md): the test strategy, the first smoke suite step by step, what the experiments showed, and the risks.
- [docs/02-adoption-guide.md](docs/02-adoption-guide.md): how to apply this to the real project, with the questions and permissions to ask for.

This file is the quick reference.

## Layout

| Path | What it is |
|---|---|
| `sim/` | The simulated system: a Maven multi-module build (`common`, `service-a`, `service-b`) on Spring Boot 2.7, Java 11, MyBatis and PostgreSQL 16 |
| `sim/common/` | The envelope, the protocol headers filter, error codes, the exception handler, the security set-up per prefix, the custom constraints |
| `sim/service-a/` | Users, PIN, devices, consents, back-office search and unlock, the asynchronous CSV export, internal user status, push |
| `sim/service-b/` | VIN registration through an external workflow, ownership and subscriptions (calls service A and a payment provider), SIM activation, partner callbacks |
| `sim/db/init.sql` | Both databases, their tables and the seeded test data (test users, a locked user, 50 search users, 20 units) |
| `sim/mock-idp/server.mjs` | An OAuth2 token issuer with a JWKS endpoint, no dependencies: user tokens, a back-office client, expired tokens on request |
| `sim/wiremock/mappings/` | The third parties' default answers: workflow, payment, telecom, push, mail, events |
| `compose.yaml` | The whole environment, plus the `tests` service (profile `ci`) that runs the suite inside the network the way a pipeline would |
| `tests/` | The Playwright Test project: the part to copy to the real project |
| `tests/src/` | The framework: environment loading and guards, tokens, the API client, masking, the contract validator and diff, WireMock helpers, fixtures and matchers |
| `tests/specs/` | 64 tests in 11 files: smoke, security, framework, contract drift, then service A and service B by feature |
| `tests/envs/` | One JSON file per target environment. `integration.example.json` is the template for a real one |
| `tests/contracts/` | The reviewed OpenAPI contracts the responses are held to |
| `tests/scripts/pipeline.sh` | The pipeline's test stage: typecheck, framework, smoke, contract, full |
| `pipeline/buildspec.yml` | A reference AWS CodeBuild spec for the real project (not run here) |

## Run it

Needs Docker, JDK 11 or later with Maven, and Node.js 22.

```bash
cd sim && mvn -q verify && cd ..          # unit tests, the Postgres repository test, the OpenAPI files, the jars (about 17 s)
docker compose up -d --build --wait       # the environment (about 20 s once the images are pulled)
cd tests && npm ci
npm test                                  # all 64 tests (about 4 s)
npm run smoke                             # the read-only smoke suite (8 tests, under 1 s)
bash scripts/pipeline.sh                  # the pipeline stage, stage by stage
cd .. && docker compose --profile ci run --rm tests   # the pipeline stage inside the compose network
docker compose down -v                    # stop and forget all data
```

Other commands, from `tests/`:

| Command | What it does |
|---|---|
| `npm run framework` | The framework's own tests, no service needed |
| `npm run contract` | The services' published OpenAPI against `contracts/` (`CONTRACT_SOURCE=file` reads the build output instead) |
| `npm run contracts:update` | Refresh `contracts/` after an intended API change, from the build output (`-- --live` from the running services) |
| `npm run typecheck` | TypeScript check |
| `npm run report` | Open the last HTML report |
| `PW_ALLOW_WRITE=false PW_STUBS=false npm test` | The run a shared environment would get: read-only, no fault injection (30 tests) |
| `TEST_ENV=<name> npm test` | Another target, from `envs/<name>.json` |

## How the tests are built

- **One client per caller.** Fixtures give each test `userA`/`userB` (the worker's own test user), `boA`/`boB` (back office), `internalA`/`internalB` (API key), `partnerB` (partner key), `anonA`/`anonB` and `as(service, caller)` for anything else. Every call adds a fresh `X-One-Time-Uuid` and is recorded, masked, and attached to the report when the test fails.
- **Two matchers check the whole protocol.** `toBeOk(status)` and `toBeNg(status, code, field?)` check the status, the envelope, `X_RESULT_STATUS`, the uuid echo, `X_EVENT_TIME`, `X_ERROR_CODE` (it must equal the first error's code) and the response schema from the contract, with unknown fields refused.
- **Parallel without collisions.** Each worker owns one test user and one unit from the environment's pools. Tests create their own VINs (prefix `PWT`) and put back what they change (PIN, lock, unit status, devices).
- **Faults per test.** A test stubs a third party for its own request only: the stub matches the request's `X-One-Time-Uuid`, which the services forward downstream. The same uuid filters WireMock's journal, so a test reads exactly the downstream calls it caused.
- **What an environment allows.** `allowWrite: false` makes the client refuse every non-GET call and skips `@write` tests. `stubs: false` skips `@stub` tests. A production target is refused outright. The pipeline can narrow these flags (`PW_ALLOW_WRITE=false`, `PW_STUBS=false`), never widen them.

## Tags

| Tag | Meaning | Skipped when |
|---|---|---|
| `@smoke` | Read-only, one call per caller group and service; the pipeline gate | never |
| `@write` | Changes data (creates, then cleans up) | `allowWrite` is false |
| `@stub` | Needs fault injection on a third party | `stubs` is false |
| `@contract` | Compares the published OpenAPI with `contracts/` | live mode and `apiDocs` is false |
| `@framework` | Tests of the framework itself, no service | never (own stage) |

## Secrets

Every key and password in this folder is a dummy for the simulation (`local-only-*`, in `compose.yaml` and `tests/envs/local.env`). A real environment's URLs, keys, test users and tokens come from environment variables, filled by the pipeline's secret store or by an uncommitted `tests/envs/<name>.env`. Reports mask `Authorization`, the API keys, cookies, any field ending in pin, password, secret, token or signature, and email addresses.
