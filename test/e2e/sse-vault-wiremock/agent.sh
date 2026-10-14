#!/bin/sh
# The "agent" a job runs, inside the sandbox box, with the env hopper gives a job's pane:
# HOPPER_URL, HOPPER_TOKEN_FILE, HOPPER_SKILL, HOPPER_SECRET. $1 = service name, $2 = mock base URL.
# It never prints the key: the key lives only inside the one curl command that needs it.
set -u
svc=$1; base=$2
echo "agent: asking hopper for a credential for $svc"
sh "$HOPPER_SKILL" "$svc" --credential "a $svc API key (Bearer)" --why "read the preset widgets" --wait
code=$?
echo "agent: hopper-skill exit $code"
[ "$code" = 0 ] || { echo "agent: RESULT=FAIL no credential"; exit 10; }
echo "agent: calling $base/api/widgets with the key from hopper-secret"
out=$(curl -sS -w '\nHTTP %{http_code}' -H "Authorization: Bearer $("$HOPPER_SECRET" get "$svc")" "$base/api/widgets")
echo "$out"
case $out in *"HTTP 200"*) echo "agent: RESULT=OK" ;; *) echo "agent: RESULT=FAIL"; exit 11 ;; esac
