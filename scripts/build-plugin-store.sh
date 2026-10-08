#!/usr/bin/env bash
# Build the default plugin store (issue #445, docs/design.md "Plugin store"): a bare git repository holding
# a checkout's plugin-store.yaml and examples/plugins/, laid out as in the checkout, for the Pages site.
# `git fetch` reads a repository served as plain files (git's "dumb" HTTP), so the site serves it as it is:
#
#   bash scripts/build-plugin-store.sh <checkout> <out dir> [<published store URL>]
#
# With the URL, the history already published there is fetched and the new content committed on top of it,
# so a store install's tree stays in the plugin store after its plugin changes and still restores on a fresh
# work dir. Content unchanged: no new commit. The URL unreachable (the first build): a new history.
set -euo pipefail

fail() { printf 'build-plugin-store: %s\n' "$*" >&2; exit 1; }

src="${1:-}"; out="${2:-}"; previous="${3:-}"
[ -n "$src" ] && [ -n "$out" ] || fail "usage: build-plugin-store.sh <checkout> <out dir> [<published store URL>]"
[ -f "$src/plugin-store.yaml" ] || fail "$src/plugin-store.yaml: no store catalogue"

rm -rf "$out"
git init --bare --quiet "$out"
rm -rf "$out/hooks"
g() { GIT_TERMINAL_PROMPT=0 git --git-dir "$out" "$@"; }
g symbolic-ref HEAD refs/heads/main

parent=
if [ -n "$previous" ] && g fetch --quiet --no-tags "$previous" '+HEAD:refs/heads/main' 2>/dev/null; then
  parent="$(g rev-parse refs/heads/main)"
fi

index="$out/build-index"
GIT_INDEX_FILE="$index" g --work-tree "$src" add -- plugin-store.yaml examples/plugins
tree="$(GIT_INDEX_FILE="$index" g write-tree)"
rm -f "$index"

if [ -n "$parent" ] && [ "$(g rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "build-plugin-store: unchanged at $parent"
else
  from="$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  commit="$(GIT_AUTHOR_NAME=hopper GIT_AUTHOR_EMAIL=plugin-store@hopper.invalid \
    GIT_COMMITTER_NAME=hopper GIT_COMMITTER_EMAIL=plugin-store@hopper.invalid \
    g commit-tree "$tree" ${parent:+-p "$parent"} -m "plugin store from $from")"
  g update-ref refs/heads/main "$commit"
  echo "build-plugin-store: $commit"
fi
g update-server-info
