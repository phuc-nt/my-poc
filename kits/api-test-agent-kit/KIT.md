# API test agent kit

A Playwright Test project that tests REST services through their APIs. It is packaged with what a coding agent needs to maintain it: rules, skills, a plain-language test-case catalogue, and tooling that keeps the catalogue, the tests and the product's source in step.

The kit comes from PoC 4, where it was built and measured on a simulation of two Spring Boot services. The docs in `docs/` cover three things:
- the strategy (01);
- how to adopt the kit (02);
- how the agent kit works (03).

The version is in `VERSION`, and what changed is in `CHANGELOG.md`.

## Contents

| Path | What it is | Owned by |
|---|---|---|
| `tests/AGENTS.md`, `tests/CLAUDE.md` | The rules every agent change follows, and the commands | Kit (adapt the wording to your product) |
| `tests/.claude/skills/` | `api-test-env`, `api-test-write`, `api-test-maintain`, `api-test-sync` | Kit |
| `tests/.claude/settings.json`, `tests/scripts/hooks/` | The Stop hook: an agent cannot finish while a test has no case | Kit |
| `tests/scripts/cases.mjs`, `tests/cases/README.md`, `tests/cases/_template.md` | The catalogue's tooling, format and template | Kit |
| `tests/src/` | The test framework: environments and guards, tokens, the API client, masking, contracts, fixtures and matchers | Kit (adapt the protocol checks, see doc 02) |
| `tests/scripts/pipeline.sh`, `tests/scripts/update-contracts.mjs`, `tests/playwright.config.ts` | The pipeline stage, the contract refresh and the runner settings | Kit |
| `tests/kit.config.json` | Where your product's source and build-output contracts are | Your project |
| `tests/cases/<area>/`, `tests/specs/`, `tests/contracts/`, `tests/envs/` | Cases, tests, reviewed contracts and environments | Your project. The ones shipped here are PoC 4 examples |

## Requirements

- Node.js 22.18 or later, npm and git. `cases.mjs` needs that Node version because it loads the TypeScript contract diff through Node's type stripping.
- The product's services, reachable from where the tests run.
- For the contract check, the services' OpenAPI documents. Doc 02, section 1, shows how to generate them with springdoc.
- Claude Code, to use the skills and the hook as they are. Other agents read `AGENTS.md`; point them at the skill files.

## Install into a project

1. Copy `tests/` into the product's repository, or into a test repository next to it. Run `npm ci` there.
2. Remove the PoC 4 examples:
   - the case files under `tests/cases/`, with `TRACEABILITY.md` and `review.lock.json` (keep `README.md` and `_template.md`);
   - the specs under `tests/specs/` (keep `framework.spec.ts`, and `contract-drift.spec.ts` if you use contracts);
   - `tests/contracts/*`;
   - `envs/local.*` and `envs/compose.json`.
3. Adapt the framework to your services' protocol. Doc 02, section 1, "Adapt to the real services", lists what to change.
4. Edit `tests/kit.config.json`:
   - `roots`: your modules, relative to `tests/`;
   - `sourceScope`: their `src/main/**`;
   - `contracts`: their build-output OpenAPI and base-URL variables.
5. Create an environment from `envs/integration.example.json`, using the skill `api-test-env`. Real values go in `envs/<name>.env`, which `tests/.gitignore` keeps out of git, or in the pipeline's secret store.
6. Run `npm run framework`, then `npm run cases:check`.
7. Ask the agent to write the first cases and tests with the skill `api-test-write`, starting with the smoke suite. Then work through `npm run cases:check -- --strict` until no product source is left unmapped.

## Upgrade to a newer kit version

1. Replace the files marked "Kit" in the table above, keeping your changes to `AGENTS.md` and `src/`. Never overwrite the files marked "Your project".
2. Read `CHANGELOG.md`. For a major version, it says what to change in your cases or config.
3. Run `npm run typecheck`, `npm run framework` and `npm run cases:check`.

`tests/KIT_VERSION` records which version a project copied.
