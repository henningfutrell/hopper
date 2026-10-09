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
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
case $# in
  0) ;;
  1) set -- --data-urlencode "name=$1" ;;
  2) set -- --data-urlencode "name=$1" --data-urlencode "asset=$2" ;;
  *) echo 'usage: sh "$HOPPER_SKILL" [NAME [ASSET]]' >&2; exit 2 ;;
esac
printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")" | curl -sS --fail-with-body -H @- -X POST "$@" "$HOPPER_URL${SKILL_PATH}" || exit 1
`;
