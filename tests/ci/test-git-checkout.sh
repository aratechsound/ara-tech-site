#!/usr/bin/env bash
set -euo pipefail
helper=$(realpath "$(dirname "$0")/materialize-git-checkout.sh")
tmp=$(mktemp -d)
# This script creates only isolated fake repositories. Container disposal owns cleanup.
git -c init.defaultBranch=main init "$tmp/source"
cd "$tmp/source"
git config user.name CI-fixture
git config user.email ci-fixture@example.invalid
printf 'base\n' > example.txt
git add example.txt
git commit -m base
base=$(git rev-parse HEAD)
git checkout -b feature
printf 'feature\n' > feature.txt
git add feature.txt
git commit -m feature
feature=$(git rev-parse HEAD)
git checkout main
printf 'main\n' > main.txt
git add main.txt
git commit -m main
main=$(git rev-parse HEAD)
git merge --no-ff feature -m synthetic-merge
head=$(git rev-parse HEAD)
tree=$(git rev-parse HEAD^{tree})
history=$(git rev-list --count HEAD)
git bundle create "$tmp/source.bundle" HEAD --all
# Reproduce the runner/container UID boundary without relaxing Git trust.
chown 1001:1001 "$tmp/source.bundle"
bash "$helper" "$tmp/source.bundle" "$tmp/normal" "$head" "$tree" "$history"
[[ $(git -C "$tmp/normal" show -s --format=%P HEAD) == "$main $feature" ]]
git -C "$tmp/normal" cat-file -e "$base^{commit}"
git -C "$tmp/normal" diff --check "$base" HEAD --
printf 'NORMAL_SYNTHETIC_HEAD_TREE_HISTORY_WHITESPACE=PASS\n'
tests=1
reject() {
  local name=$1
  shift
  if bash "$helper" "$@" > "$tmp/$name.log" 2>&1; then
    echo "Expected rejection did not occur: $name" >&2
    exit 1
  fi
  tests=$((tests + 1))
  printf '%s=EXPECTED_FAIL\n' "$name"
}
reject missing-bundle "$tmp/missing.bundle" "$tmp/missing" "$head" "$tree" "$history"
printf 'not a bundle\n' > "$tmp/invalid.bundle"
reject invalid-bundle "$tmp/invalid.bundle" "$tmp/invalid" "$head" "$tree" "$history"
reject invalid-sha "$tmp/source.bundle" "$tmp/invalid-sha" not-a-sha "$tree" "$history"
reject wrong-tree "$tmp/source.bundle" "$tmp/wrong-tree" "$head" "$(git rev-parse "$base^{tree}")" "$history"
reject missing-commit "$tmp/source.bundle" "$tmp/missing-commit" 1111111111111111111111111111111111111111 "$tree" "$history"
reject lost-history "$tmp/source.bundle" "$tmp/lost-history" "$head" "$tree" 1
reject existing-repository "$tmp/source.bundle" "$tmp/normal" "$head" "$tree" "$history"
printf 'GIT_INITIALIZATION_TESTS=PASS; cases=%s\n' "$tests"
