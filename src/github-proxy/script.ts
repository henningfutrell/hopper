// `hopper-gh` (issue #563): the command a job runs to ask the hopper for a GitHub operation. Kept in the job's
// credentials dir on its machine beside its proxy token, run as `sh "$HOPPER_GH" …`: POSIX sh and curl, nothing
// else, so it works on any machine a job runs on. Its help is the whole manual, read only when a job needs it. A 503
// with Retry-After (the client door while the hopper is out of reach, issue #752) is waited out: `hcurl`.

import { HCURL_SH } from './retry-after.ts';

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

  sh "$HOPPER_GH" issue create   --repo OWNER/NAME --title TITLE (--body TEXT | --body-file FILE) [--required]
  sh "$HOPPER_GH" issue comment N --repo OWNER/NAME (--body TEXT | --body-file FILE)
  sh "$HOPPER_GH" issue view N    --repo OWNER/NAME
  sh "$HOPPER_GH" issue close N   --repo OWNER/NAME      (this job's own issue only, as completed)
  sh "$HOPPER_GH" pr create      --repo OWNER/NAME --head [LOGIN:]BRANCH [--base BRANCH] --title TITLE (--body TEXT | --body-file FILE)
  sh "$HOPPER_GH" pr view N       --repo OWNER/NAME
  sh "$HOPPER_GH" pr ready N      --repo OWNER/NAME      (mark a draft ready for review)
  sh "$HOPPER_GH" repo view      --repo OWNER/NAME      (canPush: whether your user can push to it; hasIssues)
  sh "$HOPPER_GH" repo fork      --repo OWNER/NAME      (this job's own repository only, when your user cannot push to it)
  sh "$HOPPER_GH" report bug --title TITLE (--body TEXT | --body-file FILE) [--comment-on N] [--force]
                                                         (report a bug in the hopper itself)

Prints the answer as JSON, with the url. A refusal prints why and exits 1: do not try another way around it.
An issue filed this way gets no labels or assignees and says the hopper filed it; a person triages it.
It is a child of this job's issue: its text names that issue as its parent, as a follow-up. With --required it is a
required child: the hopper links it as a sub-issue of this job's issue, which is not done while it is open. Use
--required only when this job's issue cannot be complete without it; a nice-to-have is a follow-up.
git fetch and git push to GitHub go through the hopper too: this machine holds no GitHub token for them. A job
pushes only to a new branch of its own work on this job's own repository, never to its default or a release branch.
A pull request: push the branch first (git push), on this job's own repository.
Contributing to a repository your user cannot push to (repo view says canPush false; a push there is refused so):
work through a fork. repo fork forks this job's repository into your user's account, or answers the fork it has, and
says what to do next: clone the fork, read the repository's contributing rules (CONTRIBUTING.md, the pull request
template, the code of conduct, a CLA) and follow them, push your branch to the fork, and open the pull request on this
job's repository with --head LOGIN:BRANCH. When the repository takes no issues, file your issue on the fork. Only while
a person turned Contribution on in the hopper's Settings; else it is refused, and says so.
A bug report goes to the hopper's own issues (henningfutrell/hopper), filed with your user's GitHub connection and
labelled user-report. Never file one with issue create. The hopper adds this job's context (version, install, state,
last log lines) and masks tokens, keys, host names and IP addresses. Say what happened in the body; never put text from
a private repository in it. When open reports look similar, nothing is filed: it prints them and exits 1. Then add yours
to one with --comment-on N, or file a new one with --force. When GitHub cannot take it now, the hopper keeps it and
sends it later: it prints kind kept; do not send it again. At most 3 reports per job a day. A report never starts a job.`;

/** The script. Arguments become form fields, rebuilt in place (no eval); a body file is read by curl itself, the token from stdin. */
export const PROXY_SCRIPT = `#!/bin/sh
# hopper-gh — GitHub through the hopper (issue #563). Written by the hopper at each job start.
help() { cat <<'HOPPER_GH_HELP'
${PROXY_HELP}
HOPPER_GH_HELP
}
case "$1 $2" in
  'issue create'|'issue comment'|'issue view'|'issue close'|'pr create'|'pr view'|'pr ready'|'repo view'|'repo fork'|'report bug') op="$1.$2"; shift 2 ;;
  'help '*|' ') help; exit 0 ;;
  *) help >&2; exit 2 ;;
esac
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
n=$#; i=0
while [ "$i" -lt "$n" ]; do
  a=$1; shift; i=$((i + 1))
  case "$a" in
    --force) set -- "$@" --data-urlencode "force=true" ;;
    --required) set -- "$@" --data-urlencode "required=true" ;;
    --repo|--title|--body|--head|--base|--body-file|--comment-on)
      [ "$i" -lt "$n" ] || { echo "hopper-gh: $a needs a value" >&2; exit 2; }
      v=$1; shift; i=$((i + 1))
      if [ "$a" = --body-file ]; then
        [ -r "$v" ] || { echo "hopper-gh: cannot read $v" >&2; exit 2; }
        set -- "$@" --data-urlencode "body@$v"
      elif [ "$a" = --comment-on ]; then
        set -- "$@" --data-urlencode "commentOn=$v"
      else
        set -- "$@" --data-urlencode "\${a#--}=$v"
      fi ;;
    ''|*[!0-9]*) echo "hopper-gh: unknown argument $a (sh \\"\\$HOPPER_GH\\" help)" >&2; exit 2 ;;
    *) set -- "$@" --data-urlencode "number=$a" ;;
  esac
done
token() { printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")"; }
${HCURL_SH}
hcurl -sS --fail-with-body -H @- --data-urlencode "op=$op" "$@" "$HOPPER_URL${PROXY_PATH}"
code=$?
echo
[ "$code" -eq 0 ] || exit 1
`;
