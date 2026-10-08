#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
export ARA_CI_FIXTURE=isolated-container
export CI=true
mkdir -p /workspace/work/repo /workspace/outputs/ARA-CASE-001R2-audit /workspace/outputs/ARA-CASE-001R3-audit /tmp/ara-ci-fixture
# Materialize the Git index, including staged repairs, with Linux checkout rules.
# The read-only source worktree and ignored .env/node_modules are never copied.
cp -a /source/.git /workspace/work/repo/.git
cd /workspace/work/repo
git config --local core.autocrlf false
git checkout-index --all --force
ln -s /opt/ara-ci/node_modules node_modules
pids=()
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  if [[ -f /tmp/ara-ci-fixture/pg-data/postmaster.pid ]]; then
    runuser -u postgres -- pg_ctl -D /tmp/ara-ci-fixture/pg-data -m immediate -w stop
  fi
  printf 'exit_code=%s\nfixture_processes_stopped=true\n' "$rc" > /workspace/outputs/CLEANUP.txt
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ $(node --version) == v22.* ]]
[[ $(git rev-parse --is-shallow-repository) == false ]]
git cat-file -e cac44214dba8f273377ab66fc95b2aad7e4fc38d^{commit}
{ cat /etc/os-release; node --version; pnpm --version; postgres --version; postgrest --version; git rev-parse HEAD HEAD^{tree}; git write-tree; } > /workspace/outputs/RUNTIME.txt
[[ $(wc -l < /proc/net/route) -eq 1 ]]
chown postgres:postgres /tmp/ara-ci-fixture
runuser -u postgres -- initdb -D /tmp/ara-ci-fixture/pg-data -U fixture_admin -A trust --encoding=UTF8 --locale=C
runuser -u postgres -- pg_ctl -D /tmp/ara-ci-fixture/pg-data -l /tmp/ara-ci-fixture/postgres.log -o '-h 127.0.0.1 -p 55437' -w start
for mode in --final --guards --legacy --r3; do
  python3 tests/start-ara-case-postgres.py --ci "$mode"
done
for config in /tmp/ara-ci-fixture/postgrest-{final,guards,legacy,r3}.conf; do
  postgrest "$config" > "/workspace/outputs/$(basename "$config").log" 2>&1 &
  pids+=("$!")
done
wait_url() {
  for attempt in {1..60}; do
    if curl --silent --fail "$1" > /dev/null; then return 0; fi
    sleep 1
  done
  echo "Fixture readiness failed: $1" >&2
  return 1
}
for port in 55442 55443 55439 55444; do wait_url "http://127.0.0.1:$port/"; done
node tests/ara-case-r2-local-preview.cjs > /workspace/outputs/R2_SERVER.log 2>&1 &
pids+=("$!")
node tests/ara-case-r3-server.cjs > /workspace/outputs/R3_SERVER.log 2>&1 &
pids+=("$!")
wait_url http://127.0.0.1:8872/fixture-info
wait_url 'http://127.0.0.1:8875/api/pa-inquiry?general_config=1'
printf 'postgresql=ready\npostgrest4=ready\nhttp_fixture2=ready\nnetwork=none\n' > /workspace/outputs/FIXTURE_READY.txt
node tests/ci/validate-security-checks.cjs
