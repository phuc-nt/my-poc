#!/usr/bin/env bash
# The pipeline's test stage, the same locally, in the compose "tests" container and in CodeBuild.
#
#   TEST_ENV=<env> bash scripts/pipeline.sh
#
# Stages, each with its own JUnit file under results/<stage>/:
#   1. framework  the suite's own guards, no service needed
#   2. smoke      read-only health of every caller group; when it fails nothing else runs
#   3. contract   the published OpenAPI against the reviewed contract (skipped where /v3/api-docs is closed)
#   4. full       everything the environment allows (allowWrite and stubs decide what is skipped)
set -euo pipefail
cd "$(dirname "$0")/.."

stage() {
  local name=$1; shift
  echo "::: ${name}"
  local started=$SECONDS
  PW_STAGE=$name npx playwright test "$@"
  echo "::: ${name} passed in $((SECONDS - started)) s"
}

[ -d node_modules ] && [ package-lock.json -ot node_modules/.package-lock.json ] || npm ci --no-audit --no-fund
npx tsc --noEmit
PW_ONLY_FRAMEWORK=1 stage framework --grep @framework
stage smoke --grep @smoke
stage contract --grep @contract
stage full --grep-invert '@framework|@smoke|@contract'
