#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
root=$(git rev-parse --show-toplevel)
cd "$root"
# Range checks test committed HEAD; reject staged or unstaged changes.
git diff --exit-code HEAD
[[ -z $(git ls-files --others --exclude-standard) ]]
event_args=()
if [[ ${GITHUB_ACTIONS:-false} == true ]]; then
  [[ -f ${GITHUB_EVENT_PATH:-} ]]
  event_args+=(--mount "type=bind,src=$GITHUB_EVENT_PATH,dst=/ci-event.json,readonly")
  event_args+=(--env GITHUB_EVENT_PATH=/ci-event.json)
  event_args+=(--env "GITHUB_EVENT_NAME=${GITHUB_EVENT_NAME:-}" --env "GITHUB_SHA=${GITHUB_SHA:-}")
else
  # No implicit HEAD/parent/main fallback, including local runs.
  [[ -n ${ARA_CI_BASE_SHA:-} ]]
fi
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
  --env "ARA_CI_WHITESPACE=${ARA_CI_WHITESPACE:-git diff --check}" \
  --env "ARA_CI_BASE_SHA=${ARA_CI_BASE_SHA:-}" \
  --env "GITHUB_ACTIONS=${GITHUB_ACTIONS:-false}" \
  "${event_args[@]}" \
  --mount "type=bind,src=$root,dst=/source,readonly" \
  --mount "type=bind,src=$audit,dst=/workspace/outputs" \
  "$image" bash /source/tests/ci/container-checks.sh
