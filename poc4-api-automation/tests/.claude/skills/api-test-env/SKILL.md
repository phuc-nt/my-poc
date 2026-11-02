---
name: api-test-env
description: Set up, check or repair where the API tests run - a new target environment (envs/<name>.json and its variables), the local Docker simulation, the pipeline stage, or the kit's links to the product source (kit.config.json). Use when asked to "add an environment", "run the tests against X", "the tests can't reach the service", or when moving this suite to a new product repository.
---

# Set up a test environment

Read `AGENTS.md` first. Never write a real URL, key, token or user id into a committed file or into your answer.

## A. A new target environment

1. Copy `envs/integration.example.json` to `envs/<name>.json`. Keep every value a `${VAR}` placeholder; choose variable names with the `PW_` prefix.
2. Set the flags from what the environment owner allows, never more:
   - `allowWrite`: true only where tests may create and change data;
   - `stubs`: true only where the third parties point at a WireMock you control (then set `wiremockUrl`);
   - `apiDocs`: true only where `/v3/api-docs` is open;
   - `production` stays false. `src/env.ts` refuses a production target, whatever the flags say.
3. `accounts.pool` lists one test user per parallel worker (the run uses at most that many workers). `tcuPool`, if the environment has units, needs one per worker too.
4. `auth.kind`: `env-token` reads ready-made tokens from variables (`<userTokenEnvPrefix><n>` per pooled user, `backofficeTokenEnv`); `oauth-mock` asks the simulation's IdP. A real IdP that issues tokens to the pipeline needs a new kind in `src/auth.ts` and `src/env.ts` (a framework change, with a test in `framework.spec.ts`).
5. Write `envs/<name>.env` with the real values for laptop runs, or have them put in the pipeline's secret store. Check that git ignores it: `git check-ignore -v envs/<name>.env` must print a rule. Never print its contents.
6. Prove it, in this order, stopping at the first failure:
   ```bash
   npm run framework                       # no service needed
   TEST_ENV=<name> npm run smoke           # read-only, one call per caller group
   TEST_ENV=<name> npm run contract        # skipped when apiDocs is false
   TEST_ENV=<name> npm test                # what the environment allows
   ```
7. Report how many tests ran, passed and were skipped, and why tests were skipped (the flags).

## B. The local simulation (this PoC only)

From the folder above `tests/`:
```bash
cd sim && mvn -q verify && cd ..        # the services, their unit tests and build-output OpenAPI
docker compose up -d --build --wait      # services, database, mock IdP, WireMock
cd tests && npm ci && npm test
docker compose down -v                   # when done: stop it and forget the data
```
Leave the stack stopped when you finish unless asked otherwise.

## C. The pipeline stage

`scripts/pipeline.sh` is the stage: typecheck, the case catalogue check, framework, smoke, contract, then the rest. Run it with `TEST_ENV=<name> bash scripts/pipeline.sh`. In a pipeline, the environment's variables come from the secret store, and `PW_ALLOW_WRITE=false` / `PW_STUBS=false` may narrow (never widen) the flags. `pipeline/buildspec.yml` in the folder above is a reference for AWS CodeBuild.

## D. Linking the kit to a product repository

`kit.config.json` tells `scripts/cases.mjs` where the product is:
- `roots`: a name for each source folder, relative to `tests/` (`"service-a": "../service-a"`), plus `"tests": "."`;
- `sourceScope`: the globs that count as product code (`service-a:src/main/**`); `sourceIgnore`: files no case needs (the application's `main` class);
- `contracts`: per service, the reviewed file in `contracts/`, the build-output OpenAPI path, and the variable and default of its base URL for `--live`.

After changing it, run `npm run cases:check -- --strict`: it lists any source in scope that no feature maps. Map each to a feature (see the api-test-sync skill) or add it to `sourceIgnore` with a reason.

## When something fails

| Symptom | Likely cause |
|---|---|
| global setup: "a, b not healthy" | Wrong base URL, the service is down, or the runner is outside the network |
| Every call 401 E101 | Tokens missing, expired or for the wrong IdP; the key variables are empty |
| "Worker N has no test account" | More workers than `accounts.pool` entries; add users or set `PW_WORKERS` |
| WriteBlockedError | A test without `@write` sends a write: fix the test's tags (api-test-maintain) |
| Contract tests skipped | `apiDocs` false; use `CONTRACT_SOURCE=file npm run contract` with the build output |
