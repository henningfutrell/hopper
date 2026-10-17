// `hopper-skill` (issue #582): the command a job runs to ask the hopper what it can set up, and to load one skill.
// Kept in the job's credentials dir beside its proxy token and `hopper-gh` (issue #563), run as `sh "$HOPPER_SKILL"`:
// POSIX sh, curl and awk, nothing else. The hopper answers in plain text, few tokens: the catalog, a skill, or a no. A
// request a person must answer first is waited on with --wait: the hopper pushes the answer on the job stream (issue
// #613), and the script reads it there, reconnecting with Last-Event-ID when the stream drops, until its deadline.

import { HCURL_SH, TRACE_HEADER_SH } from '../github-proxy/retry-after.ts';
import { STREAM_WAIT_SH } from '../job-stream/script.ts';

export const SKILL_SCRIPT_VARIABLE = 'HOPPER_SKILL';

/** The route on the hopper's URL a job's skill requests go to. */
export const SKILL_PATH = '/job/skill';

/** The file under the job's credentials dir. */
export const SKILL_SCRIPT_FILE = 'hopper/skill';

/** The script. The token goes to curl on stdin, never on a command line. */
export const SKILL_SCRIPT = `#!/bin/sh
# hopper-skill — what the hopper can set up for this box (issue #582). Written by the hopper at each job start.
#   sh "$HOPPER_SKILL"               the catalog: one line per skill
#   sh "$HOPPER_SKILL" NAME [ASSET]  load one skill (ASSET as the catalog says, e.g. cluster/prod)
#     --why TEXT         what the job needs it for: the user reads it when the hopper asks them for a credential;
#                        required for sandbox and sandbox-template (issue #1001)
#     --plan TEXT        for sandbox and sandbox-template, required when a need changes an asset: what the box will
#                        do, and for each change what it changes and whether it can be undone (issue #1001)
#     --credential TEXT  for a service the hopper has no skill for: the credential it takes (issue #583)
#     --needs TEXT       for sandbox and sandbox-template: what the work needs, as <operation>/<kind>/<asset> ...
#                        (issues #716, #991)
#     --template NAME    for sandbox, in place of --needs: a template the user has, as a brief names it (issue #1471)
#     --wait             while the hopper waits for the user to give the credential (202), wait for the answer:
#                        the hopper pushes it on the job stream (issue #613)
#     --timeout SECONDS  how long --wait waits (the hopper's default: an hour)
# Exit 0: the answer; 1: a no, with why; 2: a bad call; 3: the user is asked, and --wait was not given;
#      4: --wait reached its deadline with no answer.
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
usage() { echo 'usage: sh "$HOPPER_SKILL" [NAME [ASSET] [--why TEXT] [--plan TEXT] [--credential TEXT] [--needs TEXT] [--template NAME] [--wait [--timeout SECONDS]]]' >&2; exit 2; }
${TRACE_HEADER_SH}
token() { printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")"; trace_header; }
${HCURL_SH}
${STREAM_WAIT_SH}
wait=; opt=; pos=0
for a in "$@"; do
  shift
  if [ -n "$opt" ]; then set -- "$@" --data-urlencode "$opt=$a"; opt=; continue; fi
  case $a in
    --wait) wait=1; set -- "$@" --data-urlencode wait=1 ;;
    --why) opt=why ;;
    --plan) opt=plan ;;
    --credential) opt=credential ;;
    --needs) opt=needs ;;
    --template) opt=template ;;
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
out=$(hcurl -sS -H @- -X POST "$@" -w '\\n%{http_code}' "$HOPPER_URL${SKILL_PATH}") || exit 1
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
stream_wait "$id" "$secs"
exit $?
`;
