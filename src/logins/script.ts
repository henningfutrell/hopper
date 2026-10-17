// `hopper-login` (issue #1110): the command a job runs to say what came of a login it asked for. Only the requester
// knows whether a login worked: it says so, and the hopper ends the login, or opens it again, with no person. Kept in
// the job's credentials dir beside its proxy token and `hopper-gh` (issue #563), run as `sh "$HOPPER_LOGIN"`: POSIX sh
// and curl, nothing else.
import { HCURL_SH, TRACE_HEADER_SH } from '../github-proxy/retry-after.ts';

export const LOGIN_SCRIPT_VARIABLE = 'HOPPER_LOGIN';

/** The route on the hopper's URL a job's login outcomes go to. */
export const LOGIN_PATH = '/job/login';

/** The file under the job's credentials dir. */
export const LOGIN_SCRIPT_FILE = 'hopper/login';

/** The script. The token goes to curl on stdin, never on a command line. */
export const LOGIN_SCRIPT = `#!/bin/sh
# hopper-login — say what came of a login this job asked for (issue #1110). Written by the hopper at each job start.
#   sh "$HOPPER_LOGIN" completed [TOOL]            the login went through
#   sh "$HOPPER_LOGIN" failed [TOOL] --reason TEXT  it did not, or a check after it says it does not work
# TOOL: the tool: line of its HOPPER_AUTH_PENDING; left out, the job's latest login.
# Exit 0: the hopper took it; 1: a no, with why; 2: a bad call.
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
usage() { echo 'usage: sh "$HOPPER_LOGIN" completed|failed [TOOL] [--reason TEXT]' >&2; exit 2; }
${TRACE_HEADER_SH}
token() { printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")"; trace_header; }
${HCURL_SH}
case \${1:-} in completed|failed) ;; *) usage ;; esac
outcome=$1; shift
tool=; reason=
while [ $# -gt 0 ]; do
  case $1 in
    --reason) [ $# -ge 2 ] || usage; reason=$2; shift 2 ;;
    -*) usage ;;
    *) [ -z "$tool" ] || usage; tool=$1; shift ;;
  esac
done
[ "$outcome" = completed ] || [ -n "$reason" ] || usage
out=$(hcurl -sS -H @- -X POST --data-urlencode "outcome=$outcome" --data-urlencode "tool=$tool" --data-urlencode "reason=$reason" -w '\\n%{http_code}' "$HOPPER_URL${LOGIN_PATH}") || exit 1
code=\${out##*
}
printf '%s' "\${out%
*}"
[ "$code" = 200 ]
`;
