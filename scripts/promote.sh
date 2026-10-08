#!/usr/bin/env bash
# Promote a commit up one update channel (issue #423, docs/deploy.md "Update channels and promotion"):
#
#   bash scripts/promote.sh beta [commit]     # a commit of dev (default: its head) → beta
#   bash scripts/promote.sh stable [commit]   # a commit of beta (default: its head) → stable
#
# Run by a maintainer in a clone whose origin is the hopper's repository. Refuses unless the commit is on
# the branch one step below, the move is a fast-forward of the steadier branch, and the commit's image built
# on the branch below (.github/workflows/image.yml, asked of gh). The push is the maintainer's own, so it
# starts the image build of the steadier branch, and on stable the Pages site.
set -euo pipefail

fail() { printf 'promote: %s\n' "$*" >&2; exit 1; }

to="${1:-}"
case "$to" in
  beta) from=dev ;;
  stable) from=beta ;;
  *) fail "usage: promote.sh beta|stable [commit] (dev → beta → stable, one step at a time)" ;;
esac

# Every channel branch, so a commit of any of them is known and the refusal names the right reason.
git fetch --quiet origin $(printf '+refs/heads/%s:refs/remotes/origin/%s ' dev dev beta beta stable stable)
commit="$(git rev-parse --verify --quiet "${2:-origin/$from}^{commit}")" || fail "no such commit: ${2:-origin/$from}"

git merge-base --is-ancestor "$commit" "origin/$from" || fail "$commit is not on $from: $to takes only what $from already has"
git merge-base --is-ancestor "origin/$to" "$commit" \
  || fail "$to has commits $commit lacks: not a fast-forward. A fix lands on dev and is promoted from there"
[ "$(git rev-parse "origin/$to")" != "$commit" ] || { echo "$to is already at $commit"; exit 0; }

conclusion="$(gh run list --workflow image.yml --branch "$from" --commit "$commit" --limit 1 --json conclusion --jq '.[0].conclusion // "none"')"
[ "$conclusion" = success ] || fail "the image of $commit on $from has not built (image run: $conclusion); wait for it, or fix it on dev"

echo "==> $to: $(git rev-parse --short "origin/$to") → $(git rev-parse --short "$commit") ($(git rev-list --count "origin/$to..$commit") commit(s) from $from)"
git push --quiet origin "$commit:refs/heads/$to"
