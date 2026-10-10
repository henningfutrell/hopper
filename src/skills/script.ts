// `hopper-skill` (issue #582): the command a job runs to ask the hopper what it can set up, and to load one skill.
// Kept in the job's credentials dir beside its proxy token and `hopper-gh` (issue #563), run as `sh "$HOPPER_SKILL"`:
// POSIX sh, curl and awk, nothing else. The hopper answers in plain text, few tokens: the catalog, a skill, or a no. A
// request a person must answer first is waited on with --wait: the hopper pushes the answer on the job stream (issue
// #613), and the script reads it there, reconnecting with Last-Event-ID when the stream drops, until its deadline.

import { STREAM_PATH } from '../job-stream/wire.ts';

export const SKILL_SCRIPT_VARIABLE = 'HOPPER_SKILL';

/** The route on the hopper's URL a job's skill requests go to. */
export const SKILL_PATH = '/job/skill';

/** The file under the job's credentials dir. */
export const SKILL_SCRIPT_FILE = 'hopper/skill';

/**
 * Reads a saved job stream (the SSE text of one request): prints the last event id seen, then the request's ending
 * phase and the pointer's URL when its event is one; writes its payload to the file \`out\` names, a JSON string decoded.
 * No single quote: the script passes it in one.
 */
export const STREAM_AWK = String.raw`
function hexval(h,   i, n) { n = 0; for (i = 1; i <= 4; i++) n = n * 16 + index("0123456789abcdef", tolower(substr(h, i, 1))) - 1; return n }
function unjson(s,   o, i, c, n) {
  o = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c != "\\") { o = o c; continue }
    c = substr(s, ++i, 1)
    if (c == "n") o = o "\n"; else if (c == "t") o = o "\t"; else if (c == "r") o = o "\r"
    else if (c == "b") o = o "\b"; else if (c == "f") o = o "\f"
    else if (c == "u") { o = o sprintf("%c", hexval(substr(s, i + 1, 4))); i += 4 }
    else o = o c
  }
  return o
}
/^id: / { last = substr($0, 5) }
/^data: / {
  line = substr($0, 7); p = ""
  if (index(line, "\"phase\":\"done\"")) p = "done"
  else if (index(line, "\"phase\":\"failed\"")) p = "failed"
  else if (index(line, "\"phase\":\"expired\"")) p = "expired"
  if (p == "") next
  phase = p
  i = index(line, "\"ref\":{\"url\":\"")
  if (i) { r = substr(line, i + 14); ref = substr(r, 1, index(r, "\"") - 1); next }
  v = substr(line, index(line, "\"payload\":") + 10); v = substr(v, 1, length(v) - 1)
  if (substr(v, 1, 1) == "\"") v = unjson(substr(v, 2, length(v) - 2))
  printf "%s", v > out
}
END { print last, phase, ref }
`;

/** The script. The token goes to curl on stdin, never on a command line. */
export const SKILL_SCRIPT = `#!/bin/sh
# hopper-skill — what the hopper can set up for this box (issue #582). Written by the hopper at each job start.
#   sh "$HOPPER_SKILL"               the catalog: one line per skill
#   sh "$HOPPER_SKILL" NAME [ASSET]  load one skill (ASSET as the catalog says, e.g. cluster/prod)
#     --why TEXT         what the job needs it for: the user reads it when the hopper asks them for a credential
#     --credential TEXT  for a service the hopper has no skill for: the credential it takes (issue #583)
#     --wait             while the hopper waits for the user to give the credential (202), wait for the answer:
#                        the hopper pushes it on the job stream (issue #613)
#     --timeout SECONDS  how long --wait waits (the hopper's default: an hour)
# Exit 0: the answer; 1: a no, with why; 2: a bad call; 3: the user is asked, and --wait was not given;
#      4: --wait reached its deadline with no answer.
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
usage() { echo 'usage: sh "$HOPPER_SKILL" [NAME [ASSET] [--why TEXT] [--credential TEXT] [--wait [--timeout SECONDS]]]' >&2; exit 2; }
token() { printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")"; }
wait=; opt=; pos=0
for a in "$@"; do
  shift
  if [ -n "$opt" ]; then set -- "$@" --data-urlencode "$opt=$a"; opt=; continue; fi
  case $a in
    --wait) wait=1; set -- "$@" --data-urlencode wait=1 ;;
    --why) opt=why ;;
    --credential) opt=credential ;;
    --timeout) opt=timeout ;;
    -*) usage ;;
    *) case $pos in
         0) set -- "$@" --data-urlencode "name=$a" ;;
         1) set -- "$@" --data-urlencode "asset=$a" ;;
         *) usage ;;
       esac
       pos=$((pos + 1)) ;;
  esac
done
[ -z "$opt" ] || usage
out=$(token | curl -sS -H @- -X POST "$@" -w '\\n%{http_code}' "$HOPPER_URL${SKILL_PATH}") || exit 1
code=\${out##*
}
body=\${out%
*}
case $code in
  200) printf '%s' "$body"; exit 0 ;;
  202) [ -n "$wait" ] || { printf '%s' "$body"; exit 3; } ;;
  *) printf '%s' "$body"; exit 1 ;;
esac
printf '%s\\n' "$body" >&2
# The watch the hopper opened: its request id and how long it waits.
id=$(printf '%s\\n' "$body" | sed -n 's/^wait: \\([A-Za-z0-9_-]*\\) until .* (\\([0-9]*\\) s).*/\\1/p')
secs=$(printf '%s\\n' "$body" | sed -n 's/^wait: \\([A-Za-z0-9_-]*\\) until .* (\\([0-9]*\\) s).*/\\2/p')
[ -n "$id" ] && [ -n "$secs" ] || { echo 'no: the hopper opened no wait for this request' >&2; exit 1; }
ends=$(( $(date +%s) + secs + 5 ))
dir=$(mktemp -d "\${TMPDIR:-/tmp}/hopper-skill.XXXXXX") || exit 1
trap 'rm -rf "$dir"' EXIT
last=0
while :; do
  left=$(( ends - $(date +%s) ))
  if [ "$left" -le 0 ]; then echo 'expired: no answer came before the wait ended. Go on without it, or ask again to wait longer.'; exit 4; fi
  # The stream of this request alone: the hopper ends it after the request's last event.
  code=$( (token; printf 'last-event-id: %s\\naccept: text/event-stream\\n' "$last") | curl -sSN -H @- --max-time "$left" -o "$dir/s" -w '%{http_code}' "$HOPPER_URL${STREAM_PATH}?request=$id" 2>/dev/null)
  case $code in
    200) ;;
    401|403|404) cat "$dir/s"; exit 1 ;;
    *) sleep 1; continue ;;
  esac
  # The last event id seen, then the request's end: its phase, and its payload (into $dir/out) or a pointer to it.
  set -- $(awk -v out="$dir/out" -v last="$last" '${STREAM_AWK}' "$dir/s")
  [ -n "$1" ] && last=$1
  case $2 in
    '') sleep 1; continue ;;
    done) status=0 ;;
    expired) status=4 ;;
    *) status=1 ;;
  esac
  if [ -n "$3" ]; then
    token | curl -sS -H @- -H 'accept: text/plain' "$HOPPER_URL$3" > "$dir/out" || exit 1
  fi
  printf '%s' "$(cat "$dir/out")"
  exit "$status"
done
`;
