#!/usr/bin/env bash
# Build the hopper's image from this checkout (docs/deploy.md "An image from a checkout"), knowing what it is
# built from (issue #409): the checkout's origin, branch and commit go in as build arguments, so the image's
# install.json and its OCI labels name them, and Settings → Version history and the update check work as for an
# install. A bare `docker build .` cannot know them (the build context leaves out .git).
#
#   bash scripts/build-image.sh [engine build arguments ...]
#
# HOPPER_IMAGE: the tag (default localhost/hopper, the image compose.yaml runs with HOPPER_IMAGE=localhost/hopper).
# HOPPER_UPDATE_BRANCH: the branch the build follows (default stable, as scripts/install.sh).
# HOPPER_BUILDER: the engine (default docker when it answers, else podman).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${HOPPER_IMAGE:-localhost/hopper}"
BRANCH="${HOPPER_UPDATE_BRANCH:-stable}"

REPO="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null)" || {
  echo "$APP_DIR has no origin: the image would not know its repository. Add one: git -C $APP_DIR remote add origin <url>" >&2
  exit 1
}
# The image holds no ssh key: a GitHub repository is read over https, which a public one needs nothing for.
case "$REPO" in
  git@github.com:*) REPO="https://github.com/${REPO#git@github.com:}" ;;
  ssh://git@github.com/*) REPO="https://github.com/${REPO#ssh://git@github.com/}" ;;
esac
COMMIT="$(git -C "$APP_DIR" rev-parse HEAD)"
if [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ]; then
  echo "warning: $APP_DIR has uncommitted changes; the image names $COMMIT, which they are not part of" >&2
fi

if [ -n "${HOPPER_BUILDER:-}" ]; then ENGINE="$HOPPER_BUILDER"
elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then ENGINE=docker
else ENGINE=podman; fi

echo "==> $ENGINE build $TAG from $REPO $BRANCH at $COMMIT" >&2
exec "$ENGINE" build \
  --build-arg "HOPPER_REPO=$REPO" --build-arg "HOPPER_BRANCH=$BRANCH" --build-arg "HOPPER_COMMIT=$COMMIT" \
  -t "$TAG" "$@" "$APP_DIR"
