#!/usr/bin/env bash
# hopper-sse-e2e: an agent in a sandbox box gets an API credential from hopper's dynamic vault, is woken over the
# job stream (SSE, #613) when a person gives it, fetches it with hopper-secret and calls a WireMock "widgets"
# service that answers preset data only with that key. Everything is throwaway: its own podman network,
# Postgres (tmpfs), OpenFGA (memory), WireMock, hopper (from a checkout) and sandbox box; loopback ports only.
#
#   ./run.sh               # hopper from REF (default: dev)
#   REF=<sha|branch> ./run.sh
#   KEEP=1 ./run.sh        # leave the containers up for poking; ./run.sh clean removes them
#
# Exits 0 only when every check passes.
set -euo pipefail
REF=${REF:-dev}
# The wake is a push: well under the old 5 s poll. The limit has headroom for podman exec and the WireMock call.
MAX_WOKEN_MS=${MAX_WOKEN_MS:-1500}
HERE=$(cd "$(dirname "$0")" && pwd)
N=hsse
NET=$N-net
ROOT=${E2E_ROOT:-/tmp/hopper-sse-e2e}
RUN=$ROOT/run
SRC=$ROOT/src
BOX_IMAGE=${BOX_IMAGE:-ghcr.io/henningfutrell/hopper:box-claude-dev}
WIREMOCK_IMAGE=${WIREMOCK_IMAGE:-docker.io/wiremock/wiremock:3.13.1}
NODE_IMAGE=${NODE_IMAGE:-docker.io/library/node:24-bookworm-slim}
PG_IMAGE=${PG_IMAGE:-docker.io/library/postgres:17-alpine}
FGA_IMAGE=${FGA_IMAGE:-docker.io/openfga/openfga:v1.22.0}
FGA=${FGA:-real}
PORT_HOPPER=${PORT_HOPPER:-4799}; PORT_CTL=${PORT_CTL:-4798}; PORT_WM=${PORT_WM:-4796}
MACHINE=hopper-sandbox-widgets
ct() { TZ=America/Chicago date '+%-I:%M:%S %p CT'; }
say() { echo "[$(ct)] $*"; }

clean() {
  podman rm -f -t 2 $N-box $N-driver $N-wm $N-fga $N-pg >/dev/null 2>&1 || true
  podman volume rm -f $N-home >/dev/null 2>&1 || true
  podman network rm -f $NET >/dev/null 2>&1 || true
}
if [ "${1:-}" = clean ]; then clean; echo cleaned; exit 0; fi
trap '[ "${KEEP:-0}" = 1 ] || { say "cleanup: removing $N containers, volume, network"; clean; }' EXIT
clean
rm -rf "$RUN" && mkdir -p "$RUN" && chmod 700 "$RUN"

# ---- the hopper build under test
say "source: $REF -> $SRC"
[ -d "$SRC/.git" ] || git clone -q https://github.com/henningfutrell/hopper.git "$SRC"
git -C "$SRC" fetch -q origin dev
if [ "$REF" = dev ]; then git -C "$SRC" checkout -q --detach FETCH_HEAD
elif git -C "$SRC" rev-parse -q --verify "$REF^{commit}" >/dev/null; then git -C "$SRC" checkout -q --detach "$REF"
else git -C "$SRC" fetch -q origin "$REF" && git -C "$SRC" checkout -q --detach FETCH_HEAD; fi
SHA=$(git -C "$SRC" rev-parse --short HEAD); say "hopper at $SHA ($(git -C "$SRC" log -1 --format=%s | cut -c1-70))"
[ -f "$SRC/src/http/job-stream.ts" ] || { say "FAIL: $REF has no job stream (#613)"; exit 1; }
if [ ! -f "$SRC/node_modules/.e2e-$(sha1sum "$SRC/package-lock.json" | cut -c1-12)" ]; then
  say "npm ci (in $NODE_IMAGE)"
  podman run --rm -v "$SRC":/src:Z -w /src "$NODE_IMAGE" sh -c 'npm ci --no-audit --no-fund --ignore-scripts >/dev/null'
  touch "$SRC/node_modules/.e2e-$(sha1sum "$SRC/package-lock.json" | cut -c1-12)"
fi

# ---- dummy keys (never real): one per scenario. Kept only in $RUN (0700), for the leak checks.
KEY1="dummy-widgets-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
KEY2="dummy-widgets-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s\n%s\n' "$KEY1" "$KEY2" > "$RUN/keys"; chmod 600 "$RUN/keys"
mkdir -p "$RUN/mappings"
sed -e "s/__KEY1__/$KEY1/" -e "s/__KEY2__/$KEY2/" "$HERE/wiremock/widgets.tmpl.json" > "$RUN/mappings/widgets.json"
FGAKEY=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')

# ---- throwaway stack
podman network create $NET >/dev/null
SUBNET=$(podman network inspect $NET --format '{{range .Subnets}}{{.Subnet}}{{end}}')
say "network $NET ($SUBNET)"
podman run -d --name $N-pg --network $NET --network-alias pg --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=hopper -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=hopper "$PG_IMAGE" >/dev/null
podman run -d --name $N-fga --network $NET --network-alias openfga "$FGA_IMAGE" run \
  --authn-method=preshared --authn-preshared-keys="$FGAKEY" --playground-enabled=false >/dev/null
podman run -d --name $N-wm --network $NET --network-alias widgets -p 127.0.0.1:$PORT_WM:8080 \
  -v "$RUN/mappings":/home/wiremock/mappings:ro,Z "$WIREMOCK_IMAGE" --disable-banner >/dev/null
until podman exec $N-pg pg_isready -q -U hopper -d hopper 2>/dev/null; do sleep 0.5; done
podman run -d --name $N-driver --network $NET --network-alias hopper \
  -p 127.0.0.1:$PORT_HOPPER:4799 -p 127.0.0.1:$PORT_CTL:4798 \
  -v "$SRC":/src:Z -v "$HERE/driver.ts":/src/e2e-driver.ts:ro,Z --tmpfs /data -w /src \
  -e HOPPER_TEST_POSTGRES_URL=postgres://hopper:e2e@pg:5432/hopper -e E2E_PEERS="$SUBNET" \
  -e FGA="$FGA" -e E2E_OPENFGA_URL=http://openfga:8080 -e E2E_OPENFGA_KEY="$FGAKEY" \
  "$NODE_IMAGE" node e2e-driver.ts >/dev/null
CTL=http://127.0.0.1:$PORT_CTL
ctl() { local m=$1 p=$2; shift 2; curl -sS --max-time 180 -X "$m" -H 'content-type: application/json' "$CTL$p" "$@"; }
for i in $(seq 1 120); do curl -s -o /dev/null "$CTL/calls" && break; sleep 1; [ "$i" = 120 ] && { podman logs $N-driver | tail -40; exit 1; }; done
until curl -s -o /dev/null "http://127.0.0.1:$PORT_WM/__admin/health"; do sleep 0.5; done
say "hopper $SHA up on 127.0.0.1:$PORT_HOPPER, WireMock on 127.0.0.1:$PORT_WM"

# ---- template, approval, sandbox box (#308) joined with the template's join line, one lane
SETUP=$(ctl POST /setup -d "{\"image\":\"$BOX_IMAGE\"}"); echo "$SETUP" > "$RUN/setup.json"
LINE=$(jq -r .line <<<"$SETUP"); say "template $(jq -r .template <<<"$SETUP") saved=$(jq .saved <<<"$SETUP") approved=$(jq .approved <<<"$SETUP")"
podman run -d --name $N-box --network $NET --cap-drop=all --security-opt no-new-privileges --read-only --tmpfs /tmp \
  -v $N-home:/home/agent -e HOPPER_JOIN="$LINE" -e HOPPER_CLIENT_NAME=$MACHINE "$BOX_IMAGE" >/dev/null
JOB=$(ctl POST /job -d "{\"machine\":\"$MACHINE\"}")
jq -e .job <<<"$JOB" >/dev/null || { echo "$JOB"; podman logs $N-driver | tail -30; exit 1; }
JOBID=$(jq -r .job <<<"$JOB"); HELPER=$(jq -r .helper <<<"$JOB"); SSE=$(jq -r .sse <<<"$JOB")
if [ "$HELPER" = null ] || [ -z "$HELPER" ]; then
  # /api/machines does not show the client's vault helper: find the file the client wrote (src/client/vault.ts).
  HELPER=/home/agent/.config/hopper-client/hopper-secret
  for i in $(seq 1 60); do podman exec $N-box test -x $HELPER && break; sleep 0.5; done
  podman exec $N-box test -x $HELPER || { say "no vault helper in the box"; exit 1; }
fi
say "job $JOBID running on $(jq -r .lane <<<"$JOB"); hopper-skill uses the job stream: $SSE; helper: $HELPER"
CREDS=/home/agent/work/.hopper-scratch/$JOBID/credentials
podman exec $N-box mkdir -p "$CREDS"
jq -r .token <<<"$JOB" | podman exec -i $N-box sh -c "umask 077; cat > $CREDS/token"
jq -r .skill <<<"$JOB" | podman exec -i $N-box sh -c "umask 077; cat > $CREDS/skill"
TOKEN=$(jq -r .token <<<"$JOB")
agent() { # $1 service, $2 output file: runs agent.sh in the box with a job pane's env
  podman exec -i -e HOPPER_URL=http://hopper:4797 -e HOPPER_TOKEN_FILE=$CREDS/token -e HOPPER_SKILL=$CREDS/skill \
    -e HOPPER_SECRET="$HELPER" $N-box sh -s -- "$1" http://widgets:8080 < "$HERE/agent.sh" > "$2" 2>&1
}
ms() { date +%s%3N; }
calls_of() { ctl GET /calls | jq "[.[] | select(.path==\"$1\")] | length"; }

# ---- scenario 1: wait -> person gives the key -> woken -> hopper-secret -> WireMock -> preset data
say "S1: agent asks for 'widgets' and waits"
SK0=$(calls_of /job/skill)
agent widgets "$RUN/s1.out" & A1=$!
until ctl GET /requests | jq -e '.[] | select(.skill=="widgets")' >/dev/null; do sleep 0.5; done
sleep 4
say "S1: person gives the key through hopper's UI vault API"
T_GIVE=$(ms); GIVE1=$(printf '{"service":"widgets","value":"%s"}' "$KEY1" | ctl POST /give -d @-); echo "$GIVE1" > "$RUN/give1.json"
S1=0; wait $A1 || S1=$?; T_DONE=$(ms)
S1_SKILL=$(( $(calls_of /job/skill) - SK0 ))
say "S1: agent exit $S1, woken $((T_DONE - T_GIVE)) ms after the give; POST /job/skill calls: $S1_SKILL"
REQ1=$(sed -n 's/^wait: \([^ ]*\) .*/\1/p' "$RUN/s1.out" | head -1)
ctl GET "/stream?request=$REQ1&token=$TOKEN" > "$RUN/s1-stream.json"

# ---- scenario 2: a hopper restart in the middle of the wait
say "S2: agent asks for 'widgets-r' and waits; hopper restarts mid-wait (down >= 6 s)"
SK0=$(calls_of /job/skill); ST0=$(calls_of /job/stream)
agent widgets-r "$RUN/s2.out" & A2=$!
until ctl GET /requests | jq -e '.[] | select(.skill=="widgets-r")' >/dev/null; do sleep 0.5; done
sleep 2
ctl POST /restart -d "{\"machine\":\"$MACHINE\",\"downMs\":6000}" > "$RUN/restart.json"; say "S2: hopper back: $(jq -c '{restarted, status: .job.status}' "$RUN/restart.json")"
S2_ALIVE=1; kill -0 $A2 2>/dev/null || S2_ALIVE=0
say "S2: agent still waiting after the restart: $S2_ALIVE"
GIVE2=$(printf '{"service":"widgets-r","value":"%s"}' "$KEY2" | ctl POST /give -d @-); echo "$GIVE2" > "$RUN/give2.json"
S2=0; ( sleep 90; kill $A2 2>/dev/null ) & W=$!; wait $A2 || S2=$?; kill $W 2>/dev/null || true
S2_SKILL=$(( $(calls_of /job/skill) - SK0 )); S2_RECONNECT=$(ctl GET /calls | jq '[.[] | select(.path=="/job/stream" and .lastEventId != null and .lastEventId != "0")] | length')
say "S2: agent exit $S2; POST /job/skill calls: $S2_SKILL; stream reconnects with Last-Event-ID: $S2_RECONNECT"

# ---- checks
ctl GET /events > "$RUN/events.json"; ctl GET /calls > "$RUN/calls.json"
podman logs $N-driver > "$RUN/hopper.log" 2>&1
podman logs $N-box > "$RUN/box.log" 2>&1
curl -s "http://127.0.0.1:$PORT_WM/__admin/requests" > "$RUN/wiremock-requests.json"
WM_OK=$(jq '[.requests[] | select(.request.url=="/api/widgets" and .responseDefinition.status==200)] | length' "$RUN/wiremock-requests.json")
WM_ALL=$(jq '[.requests[] | select(.request.url=="/api/widgets")] | length' "$RUN/wiremock-requests.json")
leak() { # $1 label; stdin: the haystack; prints yes/no without printing the key
  if grep -qF -f "$RUN/keys"; then echo yes; else echo no; fi; }
L_ENV=$(podman exec $N-box sh -c 'for p in /proc/[0-9]*; do cat $p/environ 2>/dev/null; echo; done' | tr '\0' '\n' | leak env)
L_DISK=$(podman exec -i $N-box sh -c 'grep -rlF -f - /home/agent /tmp 2>/dev/null || true' < "$RUN/keys" | grep -c . || true)
L_LOG=$(cat "$RUN/hopper.log" "$RUN/box.log" | leak logs)
L_EVENTS=$(leak events < "$RUN/events.json")
L_STREAM=$(leak stream < "$RUN/s1-stream.json")
L_OUT=$(cat "$RUN/s1.out" "$RUN/s2.out" | leak agent-output)
L_DB=$(podman exec $N-pg pg_dump -U hopper hopper | leak db)
DATA1=$(grep -c '"Sprocket"' "$RUN/s1.out" || true); DATA2=$(grep -c '"Sprocket"' "$RUN/s2.out" || true)
STREAM_TYPES=$(jq -r .text "$RUN/s1-stream.json" | sed -n 's/^data: //p' | jq -r '.type' 2>/dev/null | paste -sd, - || true)

pf() { [ "$1" = "$2" ] && echo PASS || echo FAIL; }
{
  echo "hopper-sse-e2e  REF=$REF  hopper=$SHA  fga=$FGA  finished $(ct)"
  echo "S1 agent got preset data (exit 0, Sprocket in output)   $( [ "$S1" = 0 ] && [ "$DATA1" -ge 1 ] && echo PASS || echo FAIL)  exit=$S1"
  echo "S1 one ask, no polling (POST /job/skill == 1)            $(pf "$S1_SKILL" 1)  calls=$S1_SKILL"
  echo "S1 job stream events                                     $(pf "$STREAM_TYPES" skill.waiting,skill.loaded)  $STREAM_TYPES"
  echo "S1 woken under ~1 s after the give (< $MAX_WOKEN_MS ms)      $( [ $(( T_DONE - T_GIVE )) -lt "$MAX_WOKEN_MS" ] && echo PASS || echo FAIL)  $(( T_DONE - T_GIVE )) ms"
  echo "WireMock authorized calls (200) / all                    $( [ "$WM_OK" -ge 1 ] && echo PASS || echo FAIL)  $WM_OK/$WM_ALL"
  echo "key in sandbox process env                               $(pf "$L_ENV" no)  $L_ENV"
  echo "key on sandbox disk (/home/agent, /tmp)                  $(pf "$L_DISK" 0)  files=$L_DISK"
  echo "key in hopper/box logs                                   $(pf "$L_LOG" no)  $L_LOG"
  echo "key in hopper events / job                               $(pf "$L_EVENTS" no)  $L_EVENTS"
  echo "key in job stream                                        $(pf "$L_STREAM" no)  $L_STREAM"
  echo "key in agent output                                      $(pf "$L_OUT" no)  $L_OUT"
  echo "key in plaintext in hopper's DB dump                     $(pf "$L_DB" no)  $L_DB"
  echo "S2 restart mid-wait: agent survived the restart          $(pf "$S2_ALIVE" 1)"
  echo "S2 restart mid-wait: agent got preset data               $( [ "$S2" = 0 ] && [ "$DATA2" -ge 1 ] && echo PASS || echo FAIL)  exit=$S2 skill-calls=$S2_SKILL"
  echo "S2 stream reconnected with Last-Event-ID                 $( [ "$S2_RECONNECT" -ge 1 ] && echo PASS || echo FAIL)  reconnects=$S2_RECONNECT"
} | tee "$RUN/summary.txt"
say "artifacts in $RUN (keys file is 0600; WireMock's stub holds the dummy keys by design)"
if grep -q FAIL "$RUN/summary.txt"; then say "RESULT: FAIL"; exit 1; fi
say "RESULT: PASS"
