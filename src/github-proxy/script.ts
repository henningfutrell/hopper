// `hopper-gh` (issue #563): the command a job runs to ask the hopper for a GitHub operation. Kept in the job's
// credentials dir on its machine beside its proxy token, run as `sh "$HOPPER_GH" …`: POSIX sh and curl, nothing
// else, so it works on any machine a job runs on. Its help is the whole manual, read only when a job needs it. A 503
// with Retry-After (the client door while the hopper is out of reach, issue #752) is waited out: `hcurl`. `pr wait`
// (issue #1072 part 2) reads the job stream (issue #613) when the hopper opens a watch: `stream_wait`, as `hopper-skill`.

import { STREAM_WAIT_SH } from '../job-stream/script.ts';
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
  sh "$HOPPER_GH" issue comments N --repo OWNER/NAME     (an issue's or a pull request's comments)
  sh "$HOPPER_GH" issue close N   --repo OWNER/NAME      (this job's own issue only, as completed)
  sh "$HOPPER_GH" pr create      --repo OWNER/NAME --head [LOGIN:]BRANCH [--base BRANCH] --title TITLE (--body TEXT | --body-file FILE)
  sh "$HOPPER_GH" pr view N       --repo OWNER/NAME
  sh "$HOPPER_GH" pr diff N       --repo OWNER/NAME      (its changed files and their diff)
  sh "$HOPPER_GH" pr commits N    --repo OWNER/NAME
  sh "$HOPPER_GH" pr checks N     --repo OWNER/NAME      (the check runs and statuses of its head commit)
  sh "$HOPPER_GH" pr reviews N    --repo OWNER/NAME      (its reviews, and what they decide: approved, changes_requested)
  sh "$HOPPER_GH" pr status N     --repo OWNER/NAME      (state, mergeable, checks, failed checks, the work item)
  sh "$HOPPER_GH" pr wait N       --repo OWNER/NAME [--timeout SECONDS]
                                                         (wait until its checks end; then as pr status)
  sh "$HOPPER_GH" pr ready N      --repo OWNER/NAME      (mark a draft ready for review)
  sh "$HOPPER_GH" repo view      --repo OWNER/NAME      (canPush: whether your user can push to it; hasIssues)
  sh "$HOPPER_GH" repo fork      --repo OWNER/NAME      (this job's own repository only, when your user cannot push to it)
  sh "$HOPPER_GH" check log JOB  --repo OWNER/NAME      (a failed check's full log; JOB: the last number of the check's link)
  sh "$HOPPER_GH" report bug --title TITLE (--body TEXT | --body-file FILE) [--comment-on N] [--force]
                                                         (report a bug in the hopper itself)

Prints the answer as JSON, with the url. A refusal prints why and exits 1: do not try another way around it.
Read GitHub only this way: never curl api.github.com, never gh api, never a browser. A read is answered from what the
hopper read last when that is at most 30 seconds old, or when the pull request is merged: source cache, else source
github, and readAt says when it was read. ledger, when the hopper follows the item, says where its work stands.
An issue filed this way gets no labels or assignees and says the hopper filed it; a person triages it.
It is a child of this job's issue: its text names that issue as its parent, as a follow-up. With --required it is a
required child: the hopper links it as a sub-issue of this job's issue, which is not done while it is open. Use
--required only when this job's issue cannot be complete without it; a nice-to-have is a follow-up.
git fetch and git push to GitHub go through the hopper too: this machine holds no GitHub token for them. A job
pushes only to a new branch of its own work on this job's own repository, never to its default or a release branch.
A pull request: push the branch first (git push), on this job's own repository.
Where a pull request stands: pr status. Ask it, not GitHub: the hopper answers from what it already knows (from:
hopper), the same as its Pull requests list, and reads GitHub only for a pull request it does not know (from: github),
then answers that read again for a minute (from: cache). To wait on checks, run pr wait, once: do not ask again and
again. On a pull request the hopper follows, it returns when the hopper sees the checks end (or the pull request merged
or closed), with its status (exit 0); --timeout is the most it waits (an hour unless said; exit 4 when it ends first).
On one the hopper does not follow, it answers at once as pr status, wait none (exit 3): ask pr status again later, once
a minute at most. A job that ends its turn with HOPPER_WAITING while a pr wait is open is woken with the answer.
A failed check's log: check log reads the log of a GitHub Actions job through the hopper. Never ask a person to paste a
log. Ask a person only when check log says that the hopper cannot read it, and say why.
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
  'issue create'|'issue comment'|'issue view'|'issue comments'|'issue close'|'pr create'|'pr view'|'pr diff'|'pr commits'|'pr checks'|'pr reviews'|'pr status'|'pr wait'|'pr ready'|'repo view'|'repo fork'|'check log'|'report bug') op="$1.$2"; shift 2 ;;
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
    --repo|--title|--body|--head|--base|--body-file|--comment-on|--timeout)
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
if [ "$op" != pr.wait ]; then
  hcurl -sS --fail-with-body -H @- --data-urlencode "op=$op" "$@" "$HOPPER_URL${PROXY_PATH}"
  code=$?
  echo
  [ "$code" -eq 0 ] || exit 1
  exit 0
fi
# pr wait (issue #1072 part 2): 200, the answer now (wait none: the hopper does not follow it, exit 3); 202, a watch on
# the job stream, read until the hopper ends it.
${STREAM_WAIT_SH}
out=$(hcurl -sS -H @- --data-urlencode "op=$op" "$@" -w '\\n%{http_code}' "$HOPPER_URL${PROXY_PATH}") || exit 1
code=\${out##*
}
body=\${out%
*}
case $code in
  200) printf '%s\\n' "$body"; case $body in *'"wait":"none"'*) exit 3 ;; esac; exit 0 ;;
  202) ;;
  *) printf '%s\\n' "$body"; exit 1 ;;
esac
printf '%s\\n' "$body" >&2
id=$(printf '%s' "$body" | sed -n 's/.*"waitId":"\\([A-Za-z0-9_-]*\\)".*/\\1/p')
secs=$(printf '%s' "$body" | sed -n 's/.*"waitSeconds":\\([0-9]*\\).*/\\1/p')
[ -n "$id" ] && [ -n "$secs" ] || { echo 'no: the hopper opened no wait for this pull request' >&2; exit 1; }
stream_wait "$id" "$secs"
code=$?
echo
exit "$code"
`;
