// `hopper-gh` (issue #563): the command a job runs to ask the hopper for a GitHub operation. Kept in the job's
// credentials dir on its machine beside its proxy token, run as `sh "$HOPPER_GH" …`: POSIX sh and curl, nothing
// else, so it works on any machine a job runs on. Its help is the whole manual, read only when a job needs it.

/** The variables a job asks through: the script, its token file, and the hopper's URL as its machine reaches it. */
export const PROXY_SCRIPT_VARIABLE = 'HOPPER_GH';
export const PROXY_TOKEN_VARIABLE = 'HOPPER_TOKEN_FILE';
export const PROXY_URL_VARIABLE = 'HOPPER_URL';

/** The route on the hopper's URL a job's requests go to. */
export const PROXY_PATH = '/job/github';

/** The files under the job's credentials dir. */
export const PROXY_SCRIPT_FILE = 'hopper/gh';
export const PROXY_TOKEN_FILE = 'hopper/token';

export const PROXY_HELP = `hopper-gh: GitHub through the hopper. The hopper acts with its own GitHub connection;
this machine needs no GitHub login. Never run gh auth login or start a device login.

  sh "$HOPPER_GH" issue create   --repo OWNER/NAME --title TITLE (--body TEXT | --body-file FILE)
  sh "$HOPPER_GH" issue comment N --repo OWNER/NAME (--body TEXT | --body-file FILE)
  sh "$HOPPER_GH" issue view N    --repo OWNER/NAME
  sh "$HOPPER_GH" pr create      --repo OWNER/NAME --head BRANCH [--base BRANCH] --title TITLE (--body TEXT | --body-file FILE)
  sh "$HOPPER_GH" pr view N       --repo OWNER/NAME

Prints the answer as JSON, with the url. A refusal prints why and exits 1: do not try another way around it.
An issue filed this way gets no labels or assignees and says the hopper filed it; a person triages it.
A pull request: push the branch first (git push), on this job's own repository.`;

/** The script. Arguments become form fields, rebuilt in place (no eval); a body file is read by curl itself, the token from stdin. */
export const PROXY_SCRIPT = `#!/bin/sh
# hopper-gh — GitHub through the hopper (issue #563). Written by the hopper at each job start.
help() { cat <<'HOPPER_GH_HELP'
${PROXY_HELP}
HOPPER_GH_HELP
}
case "$1 $2" in
  'issue create'|'issue comment'|'issue view'|'pr create'|'pr view') op="$1.$2"; shift 2 ;;
  'help '*|' ') help; exit 0 ;;
  *) help >&2; exit 2 ;;
esac
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
n=$#; i=0
while [ "$i" -lt "$n" ]; do
  a=$1; shift; i=$((i + 1))
  case "$a" in
    --repo|--title|--body|--head|--base|--body-file)
      [ "$i" -lt "$n" ] || { echo "hopper-gh: $a needs a value" >&2; exit 2; }
      v=$1; shift; i=$((i + 1))
      if [ "$a" = --body-file ]; then
        [ -r "$v" ] || { echo "hopper-gh: cannot read $v" >&2; exit 2; }
        set -- "$@" --data-urlencode "body@$v"
      else
        set -- "$@" --data-urlencode "\${a#--}=$v"
      fi ;;
    ''|*[!0-9]*) echo "hopper-gh: unknown argument $a (sh \\"\\$HOPPER_GH\\" help)" >&2; exit 2 ;;
    *) set -- "$@" --data-urlencode "number=$a" ;;
  esac
done
printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")" | curl -sS --fail-with-body -H @- --data-urlencode "op=$op" "$@" "$HOPPER_URL${PROXY_PATH}"
code=$?
echo
[ "$code" -eq 0 ] || exit 1
`;
