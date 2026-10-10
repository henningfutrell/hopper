// `hopper-skill` (issue #582): the command a job runs to ask the hopper what it can set up, and to load one skill.
// Kept in the job's credentials dir beside its proxy token and `hopper-gh` (issue #563), run as `sh "$HOPPER_SKILL"`:
// POSIX sh and curl, nothing else. The hopper answers in plain text, few tokens: the catalog, a skill, or a no.

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
#     --why TEXT         what the job needs it for: the user reads it when the hopper asks them for a credential
#     --credential TEXT  for a service the hopper has no skill for: the credential it takes (issue #583)
#     --wait             while the hopper waits for the user to give the credential (202), ask again every few seconds
# Exit 0: the answer; 1: a no, with why; 2: a bad call; 3: the user is asked, and --wait was not given.
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
usage() { echo 'usage: sh "$HOPPER_SKILL" [NAME [ASSET] [--why TEXT] [--credential TEXT] [--wait]]' >&2; exit 2; }
wait=; opt=; pos=0
for a in "$@"; do
  shift
  if [ -n "$opt" ]; then set -- "$@" --data-urlencode "$opt=$a"; opt=; continue; fi
  case $a in
    --wait) wait=1 ;;
    --why) opt=why ;;
    --credential) opt=credential ;;
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
told=
while :; do
  out=$(printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")" | curl -sS -H @- -X POST "$@" -w '\\n%{http_code}' "$HOPPER_URL${SKILL_PATH}") || exit 1
  code=\${out##*
}
  body=\${out%
*}
  case $code in
    200) printf '%s' "$body"; exit 0 ;;
    202) if [ -z "$wait" ]; then printf '%s' "$body"; exit 3; fi
         [ -n "$told" ] || printf '%s' "$body" >&2; told=1; sleep "\${HOPPER_SKILL_POLL:-5}" ;;
    *) printf '%s' "$body"; exit 1 ;;
  esac
done
`;
