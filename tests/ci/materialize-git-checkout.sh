#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 5 ]] || { echo 'Git checkout requires bundle, destination, HEAD, TREE, history count' >&2; exit 1; }
bundle=$1
target=$2
head=$3
tree=$4
history=$5
[[ -f $bundle && ! -e $target/.git ]]
[[ $head =~ ^[0-9a-f]{40}$ && ! $head =~ ^0+$ ]]
[[ $tree =~ ^[0-9a-f]{40}$ && ! $tree =~ ^0+$ ]]
[[ $history =~ ^[1-9][0-9]*$ ]]
# A bundle carries Git objects and refs, not host config or ownership metadata.
# clone creates a repository owned by this process; no safe.directory waiver.
git clone --no-checkout "$bundle" "$target"
cd "$target"
[[ $(git rev-parse --is-inside-work-tree) == true ]]
[[ $(git rev-parse --is-shallow-repository) == false ]]
git fsck --connectivity-only --no-dangling
[[ $(git cat-file -t "$head") == commit ]]
[[ $(git cat-file -t "$tree") == tree ]]
[[ $(git rev-parse "$head^{tree}") == "$tree" ]]
[[ $(git rev-list --count "$head") == "$history" ]]
git config --local core.autocrlf false
git checkout --detach "$head"
[[ $(git rev-parse HEAD) == "$head" ]]
[[ $(git write-tree) == "$tree" ]]
git diff --exit-code HEAD --
printf 'GIT_REPOSITORY_INITIALIZATION=PASS\nhead=%s\ntree=%s\nhistory_count=%s\n' "$head" "$tree" "$history"
