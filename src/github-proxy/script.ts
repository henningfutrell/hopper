// `hopper-gh` (issue #563): the command a job runs to ask the hopper for a GitHub operation. Kept in the job's
// credentials dir on its machine beside its proxy token, run as `sh "$HOPPER_GH" …`: POSIX sh and curl, nothing
// else, so it works on any machine a job runs on. Its help is the whole manual, read only when a job needs it. A 503
// with Retry-After (the client door while the hopper is out of reach, issue #752) is waited out: `hcurl`. `pr wait`
// (issue #1072 part 2) reads the job stream (issue #613) when the hopper opens a watch: `stream_wait`, as `hopper-skill`.
// An issue create or comment (issue #1607), and a pull request create (issue #1959 part 4), carries a resend key of its
// own, and is sent again with it while no answer comes back (the connection broke): the hopper answers the first one
// again, so nothing is filed twice.

import { STREAM_WAIT_SH } from '../job-stream/script.ts';
import { HCURL_SH, TRACE_HEADER_SH } from './retry-after.ts';

/** The variables a job asks through: the script, its token file, and the hopper's URL as its machine reaches it. */
export const PROXY_SCRIPT_VARIABLE = 'HOPPER_GH';
export const PROXY_TOKEN_VARIABLE = 'HOPPER_TOKEN_FILE';
export const PROXY_URL_VARIABLE = 'HOPPER_URL';

/** How often hopper-gh sends an issue create, comment or pull request create in all while no answer comes back: the same resend key each time (issue #1607). */
export const PROXY_RESEND_TRIES = 5;

/** The route on the hopper's URL a job's requests go to. */
export const PROXY_PATH = '/job/github';

/** The files under the job's credentials dir. */
export const PROXY_SCRIPT_FILE = 'hopper/gh';
export const PROXY_TOKEN_FILE = 'hopper/token';

export const PROXY_HELP = `hopper-gh: GitHub through the hopper. The hopper acts with your user's GitHub connection;
this machine needs no GitHub login. Never run gh auth login or start a device login.

  sh "$HOPPER_GH" issue create   --repo OWNER/NAME --title TITLE (--body TEXT | --body-file FILE) [--required] [--key KEY]
  sh "$HOPPER_GH" issue comment N --repo OWNER/NAME (--body TEXT | --body-file FILE) [--key KEY]
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
  sh "$HOPPER_GH" pr wait N       --repo OWNER/NAME [--for checks|mergeable] [--timeout SECONDS]
                                                         (wait until its checks end, or with --for mergeable until
                                                         its merge conflicts change; then as pr status)
  sh "$HOPPER_GH" pr ready N      --repo OWNER/NAME      (mark a draft ready for review)
  sh "$HOPPER_GH" pr edit N       --repo OWNER/NAME [--title TITLE] [--body TEXT | --body-file FILE]
                                                         (change its title or body: a pull request this job opened,
                                                         its work item's, the one it tends, or one its issue names)
  sh "$HOPPER_GH" pr close N      --repo OWNER/NAME      (close it with no merge: the same, but not one only its issue names)
  sh "$HOPPER_GH" repo view      --repo OWNER/NAME      (canPush: whether your user can push to it; hasIssues)
  sh "$HOPPER_GH" repo fork      --repo OWNER/NAME      (this job's own repository only, when your user cannot push to it)
  sh "$HOPPER_GH" check log JOB  --repo OWNER/NAME      (a failed check's full log; JOB: the last number of the check's link)
  sh "$HOPPER_GH" run list       --repo OWNER/NAME [--branch BRANCH] [--event EVENT]
                                                         (its newest workflow runs, at most 50: id, name, event, branch,
                                                         status, conclusion; EVENT: push, pull_request, ...)
  sh "$HOPPER_GH" run view RUN   --repo OWNER/NAME      (a workflow run and its jobs: id, name, status, conclusion;
                                                         a job's id is its check log JOB)
  sh "$HOPPER_GH" report bug --title TITLE (--body TEXT | --body-file FILE) [--comment-on N] [--force] [--key KEY]
                                                         (report a bug in the hopper itself, on its public tracker:
                                                         describe the hopper's behavior only. The hopper removes what
                                                         names your private work first, and answers what, as removed)

Prints the answer as JSON, with the url and as (the GitHub account that acted). A refusal prints why and exits 1: do not try another way around it.
Read GitHub only this way: never curl api.github.com, never gh api, never a browser. A read is answered from what the
hopper read last when that is at most 30 seconds old, or when the pull request is merged: source cache, else source
github, and readAt says when it was read. ledger, when the hopper follows the item, says where its work stands.
An issue filed this way says the hopper filed it. A follow-up gets no labels or assignees: a person triages it.
When no answer comes back to issue create, issue comment, pr create or report bug, hopper-gh sends it again by itself: the
hopper answers the first one again (replayed true; for report bug, the first report), so nothing is filed twice. Do not run the command again for that; a new command is a new one.
With --key KEY (8 to 64 letters, digits, _ or -) you choose the key: the same key from this job, also after it resumed on
another machine, is answered the first answer, and nothing is filed twice. Use it for a sub-task (the work skill).
It is a child of this job's issue: its text names that issue as its parent, as a follow-up. With --required it is a
required child: the hopper links it as a sub-issue of this job's issue, which is not done while it is open, and gives
it the job sources' label and your user as assignee, so Intake lists it. When GitHub did not set the assignee, the
answer says unassigned: say so in your final message, so a person assigns it. Use
--required only when this job's issue cannot be complete without it; a nice-to-have is a follow-up.
git fetch and git push to GitHub go through the hopper too: this machine holds no GitHub token for them. A job
pushes only to a new branch of its own work, never to a default or a release branch: on this job's own repository, or
on any other repository your user can push to when the change belongs there (its issue stays on this job's own: the
pull request body says "Closes OWNER/NAME#N" with this job's issue). Only where a person turned on direct push for a
repository, a push may go straight to its target branch (its landing branch, else its default branch), and only as a
fast-forward: never rewrite it. When GitHub gives your user no write access there,
the push is refused and says so. A refused push names whose refusal it is: "refused: ..." is a hopper rule;
"GitHub refused the push (HTTP N): ..." is GitHub's own (a token GitHub does not take there, single sign-on, a ruleset):
say it in your final message, so a person can fix the access. A pull request: push the branch first (git push), on the repository the pull request
is opened on. On a repository the hopper does not work on, a job opens a pull request, and marks ready, edits or closes
only the one it opened; it files no issue there.
Where a pull request stands: pr status. Ask it, not GitHub: the hopper answers from what it already knows (from:
hopper), the same as its Pull requests list, and reads GitHub only for a pull request it does not know (from: github),
then answers that read again for a minute (from: cache). To wait on checks, run pr wait, once: do not ask again and
again. On a pull request the hopper follows, it returns when the hopper sees the checks end (or the pull request merged
or closed), with its status (exit 0); --timeout is the most it waits (an hour unless said; exit 4 when it ends first).
On one the hopper does not follow (your own while you run, or one in another repository), and on one with no checks
yet (they start a short time after a push), it answers at once as pr status: its checks ended, wait settled (exit 0);
else wait none (exit 3) and waitOn: end your turn with HOPPER_WAITING and the line on: pr OWNER/NAME#N checks, and the
hopper wakes you when they end. No checks is never settled: queued checks are still to run. Never poll pr status for it in a loop.
A job that ends its turn with HOPPER_WAITING while a pr wait is open is woken with the answer.
To wait on its merge conflicts (a tend job of the hopper rebases it, or another merge makes conflicts), run pr wait
--for mergeable, once: it returns when the hopper sees its mergeable other than it was, or it merged or closed. The same
read asked again and again is a poll: the answer says so (poll). Never wait on the hopper in a loop with sleep.
When GitHub refuses the checks to your user's connection, checks is unknown and checksWhy says the permission it lacks
and the fix; pr wait cannot wait on them, and pr checks answers what it may read (unreadable: what it may not). Asking
again does not help: say checksWhy in your pull request or final message, so a person gives the permission.
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
  'issue create'|'issue comment'|'issue view'|'issue comments'|'issue close'|'pr create'|'pr view'|'pr diff'|'pr commits'|'pr checks'|'pr reviews'|'pr status'|'pr wait'|'pr ready'|'pr edit'|'pr close'|'repo view'|'repo fork'|'check log'|'run list'|'run view'|'report bug') op="$1.$2"; shift 2 ;;
  'help '*|' ') help; exit 0 ;;
  *) help >&2; exit 2 ;;
esac
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
n=$#; i=0; ownkey=
while [ "$i" -lt "$n" ]; do
  a=$1; shift; i=$((i + 1))
  case "$a" in
    --force) set -- "$@" --data-urlencode "force=true" ;;
    --required) set -- "$@" --data-urlencode "required=true" ;;
    --repo|--title|--body|--head|--base|--body-file|--comment-on|--timeout|--for|--key|--branch|--event)
      [ "$i" -lt "$n" ] || { echo "hopper-gh: $a needs a value" >&2; exit 2; }
      v=$1; shift; i=$((i + 1))
      [ "$a" = --key ] && ownkey=1
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
${TRACE_HEADER_SH}
token() { printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")"; trace_header; }
${HCURL_SH}
if [ "$op" != pr.wait ]; then
  case $op in
    issue.create|issue.comment|pr.create|report.bug) [ -n "$ownkey" ] || set -- "$@" --data-urlencode "key=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \\n')"; tries=${PROXY_RESEND_TRIES} ;;
    *) tries=1 ;;
  esac
  # Sent again with the same key only when no answer came (curl's own error, not GitHub's or the hopper's: 22).
  while :; do
    hcurl -sS --fail-with-body -H @- --data-urlencode "op=$op" "$@" "$HOPPER_URL${PROXY_PATH}"
    code=$?
    [ "$code" -ne 0 ] && [ "$code" -ne 22 ] && [ "$tries" -gt 1 ] || break
    tries=$((tries - 1))
    echo "hopper-gh: no answer from the hopper; sending it again" >&2
    sleep 2
  done
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
