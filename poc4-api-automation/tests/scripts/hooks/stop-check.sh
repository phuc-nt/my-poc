#!/usr/bin/env bash
# Claude Code Stop hook (.claude/settings.json): an agent cannot finish while the case catalogue is out of step
# with the tests. Runs only when specs/, cases/, src/ or kit.config.json have uncommitted changes; exit 2 sends
# the check's output back to the agent.
set -uo pipefail
cd "$(dirname "$0")/../.."

input=$(cat)
# The agent is already fixing what a previous run of this hook reported: let it stop rather than loop.
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then exit 0; fi

changed=$(git status --porcelain -- specs cases src kit.config.json 2>/dev/null)
[ -z "$changed" ] && exit 0

if ! out=$(node scripts/cases.mjs check 2>&1); then
  {
    echo "The test-case catalogue is out of step with the tests (npm run cases:check):"
    printf '%s\n' "$out" | grep -E '^(ERROR|warn)' | head -40
    echo "Fix the cases or the tags (see cases/README.md), run npm run cases:matrix, then finish."
  } >&2
  exit 2
fi
exit 0
