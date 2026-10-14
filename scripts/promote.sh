#!/usr/bin/env bash
# Promote a commit up one update channel (issue #423, docs/deploy.md "Update channels and promotion"):
#
#   bash scripts/promote.sh beta [commit]     # a commit of dev (default: its head) → beta
#   bash scripts/promote.sh canary [commit]   # a commit of beta (default: its head) → canary, the stable candidate
#   bash scripts/promote.sh stable [commit]   # a commit of canary (default: its head) → stable, by hand
#
# A candidate on canary reaches the installs that take stable releases early first; the hopper's landing batches move
# stable to it once its canary window passes with no bug report that names it (issue #1073 part 5). `stable` by hand
# skips the rest of that window: for a maintainer who read the reports.
# Run by a maintainer in a clone whose origin is the hopper's repository. Refuses unless the commit is on
# the branch one step below, the move is a fast-forward of the steadier branch, and the commit's image built
# on the branch below (.github/workflows/image.yml, asked of gh). The push is the maintainer's own, so it
# starts the image build of the steadier branch, and on stable the Pages site.
set -euo pipefail

fail() { printf 'promote: %s\n' "$*" >&2; exit 1; }

to="${1:-}"
case "$to" in
  beta) from=dev ;;
  canary) from=beta ;;
  stable) from=canary ;;
  *) fail "usage: promote.sh beta|canary|stable [commit] (dev → beta → canary → stable, one step at a time)" ;;
esac

# Every channel branch there is, so a commit of any of them is known and the refusal names the right reason. The
# canary branch is made by its first promotion.
branches="$(git ls-remote --heads origin dev beta canary stable | sed 's|.*refs/heads/||')"
git fetch --quiet origin $(for b in $branches; do printf '+refs/heads/%s:refs/remotes/origin/%s ' "$b" "$b"; done)
git rev-parse --verify --quiet "origin/$from" >/dev/null || fail "there is no $from branch yet: promote to $from first"
commit="$(git rev-parse --verify --quiet "${2:-origin/$from}^{commit}")" || fail "no such commit: ${2:-origin/$from}"

git merge-base --is-ancestor "$commit" "origin/$from" || fail "$commit is not on $from: $to takes only what $from already has"
# A new canary branch starts from stable: a candidate always has everything stable has.
base="origin/$to"
git rev-parse --verify --quiet "$base" >/dev/null || base=origin/stable
git merge-base --is-ancestor "$base" "$commit" \
  || fail "${base#origin/} has commits $commit lacks: not a fast-forward. A fix lands on dev and is promoted from there"
[ "$(git rev-parse "$base")" != "$commit" ] || { echo "$to is already at $commit"; exit 0; }

fragments="$(git ls-tree --name-only "$commit" whats-new/ | sed -n 's|^whats-new/\([0-9][0-9a-z-]*\.md\)$|\1|p' | tr '\n' ' ')"
[ -z "$fragments" ] \
  || fail "$commit has What's new fragments not in WHATS-NEW.md yet (${fragments% }): run node scripts/whats-new.ts assemble on dev, merge it, then promote"

conclusion="$(gh run list --workflow image.yml --branch "$from" --commit "$commit" --limit 1 --json conclusion --jq '.[0].conclusion // "none"')"
[ "$conclusion" = success ] || fail "the image of $commit on $from has not built (image run: $conclusion); wait for it, or fix it on dev"

echo "==> $to: $(git rev-parse --short "$base") → $(git rev-parse --short "$commit") ($(git rev-list --count "$base..$commit") commit(s) from $from)"
git push --quiet origin "$commit:refs/heads/$to"
