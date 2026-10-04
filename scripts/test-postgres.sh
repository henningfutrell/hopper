#!/usr/bin/env bash
# Run the test suite against a real Postgres (docs/design.md "Database"): a throwaway container on a
# loopback port, removed afterwards. Every test that opens a store gets its own schema in it.
#
#   bash scripts/test-postgres.sh [vitest args…]
#
# Needs docker. POSTGRES_IMAGE overrides the image (default postgres:17-alpine).
set -euo pipefail
image="${POSTGRES_IMAGE:-postgres:17-alpine}"
name="job-hopper-test-pg-$$"
password="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
echo "test-postgres: starting $image as $name"
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD="$password" -p 127.0.0.1::5432 "$image" >/dev/null
trap 'docker stop "$name" >/dev/null 2>&1 || true' EXIT
port="$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 0.5
done
docker exec "$name" pg_isready -U postgres -h 127.0.0.1 >/dev/null || { echo "test-postgres: postgres did not come up in 30 s" >&2; exit 1; }
echo "test-postgres: postgres on 127.0.0.1:$port"
JOB_HOPPER_TEST_POSTGRES_URL="postgres://postgres:${password}@127.0.0.1:${port}/postgres" npx vitest run "$@"
