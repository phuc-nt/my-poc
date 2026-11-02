# Changelog: api-test-agent-kit

The version follows [Semantic Versioning](https://semver.org/):
- **major**: a change that needs work in a project that uses the kit, such as a renamed command, a changed case-file format or a removed fixture;
- **minor**: a new skill, command or check that existing projects can ignore;
- **patch**: fixes.

## 1.0.0 (2026-11-02)

First release, from PoC 4.

- **Test framework** (`tests/src/`):
  - environment files with `${VAR}` placeholders, a production guard and a write guard;
  - fixtures per caller group, and the `toBeOk` / `toBeNg` protocol matchers;
  - masking of credentials and personal data in reports;
  - a contract validator and a breaking-change diff;
  - per-request WireMock faults.
- **Agent rules** in `tests/AGENTS.md`, imported by `tests/CLAUDE.md`.
- **Four Claude Code skills:** `api-test-env`, `api-test-write`, `api-test-maintain` and `api-test-sync`.
- **Test-case catalogue** (`tests/cases/`): one plain-language file per feature, with a format spec (`README.md`) and a template.
- **Catalogue tooling:** `tests/scripts/cases.mjs`, run as `npm run cases:*` and configured in `tests/kit.config.json`. Commands: `check [--strict]`, `impact [--base <ref>] [--json]`, `stamp`, `matrix` and `next-id`.
- **Guards:**
  - a Claude Code Stop hook (`tests/.claude/settings.json`, `tests/scripts/hooks/stop-check.sh`);
  - the catalogue check in the pipeline stage (`tests/scripts/pipeline.sh`).
- **Worked examples** from the PoC 4 simulation: 64 tests in 11 specs, documented by 64 cases in 14 features.
