#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
root=$(git rev-parse --show-toplevel)
cd "$root"
# Local runs test the staged candidate; reject unstaged edits instead of omitting them.
git diff --exit-code
[[ -z $(git ls-files --others --exclude-standard) ]]
# Only resources created by this invocation are managed here.
run_id="ara-ci-$(date +%s)-$$"
image="$run_id"
container="$run_id"
audit=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ara-ci-audit.XXXXXX")
echo "CI_AUDIT_DIR=$audit"
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  docker inspect "$container" > "$audit/container-inspect.json" 2>/dev/null || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  echo "CI_EXIT_CODE=$rc; CI_AUDIT_DIR=$audit"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker build --file tests/ci/Dockerfile --tag "$image" .
# Downloads finish before tests. No external network or host secret is inherited.
docker run --name "$container" --network none --init --ipc=private --shm-size=1g \
  --env "ARA_CI_DEDICATED=${ARA_CI_DEDICATED:-node tests/validate-ara-20260724-010.cjs}" \
  --env "ARA_CI_VALIDATORS=${ARA_CI_VALIDATORS:-tests/validate-ara-*.cjs}" \
  --env "ARA_CI_SYNTAX=${ARA_CI_SYNTAX:-node --check}" \
  --env "ARA_CI_WHITESPACE=${ARA_CI_WHITESPACE:-git diff --check HEAD}" \
  --env "GITHUB_ACTIONS=${GITHUB_ACTIONS:-false}" \
  --mount "type=bind,src=$root,dst=/source,readonly" \
  --mount "type=bind,src=$audit,dst=/workspace/outputs" \
  "$image" bash /source/tests/ci/container-checks.sh
