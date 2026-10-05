#!/usr/bin/env bash
# One-click GitHub App creation via the manifest flow (docs/design.md "The manifest-flow helper").
#
#   bash ~/.local/lib/hopper/scripts/create-github-app.sh [--name <app-name>] [--owner <login>]
#        [--org <org>] [--no-webhook] [--force] [--no-open]
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$dir/create-github-app.ts" "$@"
