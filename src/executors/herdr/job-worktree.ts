// Each job its own git worktree (issue #379): jobs on one machine share its work tree, so two jobs in one
// repository stepped on each other (branches, the index lock, uncommitted files, builds). The job's worktree is in the
// work tree's **workspace**, `<work tree>/workspace/worktrees/<name>-<job id>`, the layout workflow repos tend (issue
// #1103): never inside the repository it is of, never a copy in the scratch dir. When the work tree is the top of the job's
// git repository, the pane's shell makes the job a worktree of it, and Claude starts there. When it is not (a machine's
// work tree is a plain directory, the jobs directory by default, or another repository's top, issue #431), the job's
// worktree is made of the repository's **checkout** in that workspace, `<work tree>/workspace/<name>`: the one the
// workspace already tends, used as it is, or cloned there once, so an extra job adds only its worktree to disk; no
// machine needs its repositories set up by hand (issue #361). The reap removes the worktree when the job ends, or keeps
// it when it holds uncommitted or unpushed work (src/client/server.ts). The command runs in the pane's own shell, so on
// whichever machine the work tree is. A start fetches at most once per repository per sync pass on each machine (issue
// #858 part 2, `passFetches`): a later one in the same pass makes its worktree of what that fetch got.
// design.md "Work tree" → "Each job its own git worktree".

import { posix } from 'node:path';
import { shellQuote } from '../ssh.ts';
import { githubTraffic } from '../../github-limiter/traffic.ts';

/** The work tree's workspace (issue #1103): its repositories' checkouts, and `worktrees`, the job worktrees made of them. */
export const WORKSPACE_DIR = 'workspace';

/** What the job worktree command prints, followed by its outcome. */
export const JOB_WORKTREE_MARK = 'hopper-job-worktree-';

/**
 * made: the job runs in a worktree of the work tree; checkout: in a worktree of its repository's checkout in the work
 * tree's workspace (issue #1103); none: neither (the work tree is no repository's top and the job names no repository, or
 * job worktrees are off); unmade: git refused.
 */
export type JobWorktreeOutcome = 'made' | 'checkout' | 'none' | 'unmade';

const trimmed = (path: string): string => path.replace(/(.)\/+$/, '$1');
const nameOf = (repo: string): string => repo.slice(repo.lastIndexOf('/') + 1);

/**
 * The job's worktree (issue #1103): `<work tree>/workspace/worktrees/<name>-<job id>`, beside the checkouts there, named
 * for its repository (`owner/name`; the work tree's own name when it is of the work tree) and for the job.
 */
export function jobWorktreeOf(workTree: string, jobId: string, repo?: string): string {
  const tree = trimmed(workTree);
  return `${tree}/${WORKSPACE_DIR}/worktrees/${repo ? nameOf(repo) : posix.basename(tree)}-${jobId}`;
}

/**
 * The checkout of the job's repository (`owner/name`) in a work tree that is no repository of it: `<work
 * tree>/workspace/<name>` (issues #361, #1103), the one a workflow repo tends there. A job's worktree is made of it; with
 * job worktrees off, the job runs in the work tree beside it.
 */
export const checkoutOf = (workTree: string, repo: string): string => `${trimmed(workTree)}/${WORKSPACE_DIR}/${nameOf(repo)}`;

/** A GitHub repository's clone URL. */
export const githubUrlOf = (repo: string): string => `https://github.com/${repo}.git`;

/**
 * The start lock (issue #1075): a directory in the git common dir of the repository a job worktree is made of — the
 * checkout in the workspace, or the work tree's own repository. Concurrent starts on one machine share that repository, so each
 * takes it around its fetch and its worktree add, and git's gc runs inside it.
 */
export const JOB_WORKTREE_LOCK = 'hopper-start.lock';

/** How long, in seconds, a start waits on a start lock that a live process holds before it takes the lock over (issue #1075). */
const LOCK_WAIT_S = 300;

/** What the job worktree command prints first, so the hopper knows the shell runs it (issue #518). */
export const JOB_WORKTREE_RUNNING = 'hopper-worktree-running';

/**
 * Run by `sh` in the work tree: `$1` the worktree of the work tree, `$2` the worktree of the checkout,
 * `$3` the job's repository (`owner/name`, empty for none), `$4` its clone URL, `$5` 1 when job worktrees
 * are on, `$6` 1 to fetch before a new worktree (0: this sync pass fetched already, or the checkout was just cloned).
 * Prints its outcome last. The worktree is made after one fetch (never prompting, issue #858) of the remote's
 * default branch only, pruned, detached at it, else the current branch's upstream, else HEAD; one an earlier run of the
 * job left is used as it is, nothing fetched. The fetch and the worktree add run under the repository's start lock
 * (`JOB_WORKTREE_LOCK`, issue #1075), git's automatic gc in the foreground, so concurrent starts share one repository one
 * at a time. A fetch moves only the remote's branches: the checkout's own branch and files are left as they are. The
 * checkout is `checkoutOf` when the work tree is no repository's top, or the top of one whose origin is not the job's
 * (matched in any case); its origin must be the repository. A missing one is cloned beside it and moved in, so two jobs
 * cloning at once leave one. A workspace the hopper makes ignores itself (`.gitignore` of `*`), as `worktrees` in any
 * workspace does. With job worktrees off, only the checkout is made, and the job runs in the work tree. Git reaches
 * GitHub through the hopper, by the variables the job runs with (issue #652): no GitHub token is on the machine or a
 * command line. One line (issue #518): an interactive shell whose start-up files were busy lost or mangled a command of
 * many lines typed into it, so every statement ends in `;` or a keyword.
 */
const SCRIPT = [
  'a=$1 b=$2 r=$3 url=$4 on=$5 f=$6 l=;',
  'export GIT_TERMINAL_PROMPT=0;',
  "base() { git rev-parse --verify --quiet refs/remotes/origin/HEAD || git rev-parse --verify --quiet '@{upstream}' || git rev-parse --verify HEAD; };",
  // One fetch, of the default branch only (issue #858); a repository that knows no default branch fetches as it is set up.
  'refresh() { d=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); if [ -n "$d" ]; then g fetch --quiet --prune origin "${d#origin/}"; else g fetch --quiet --prune; fi; };',
  // Git's automatic gc and maintenance run in the foreground, so under the start lock (issue #1075).
  'g() { git -c gc.autoDetach=false -c maintenance.autoDetach=false "$@"; };',
  // The repository's start lock (issue #1075): a directory, made or not at once on any machine. Its holder's pid is in
  // it; a lock whose holder ended, or held past the wait, is moved aside and taken over.
  `lock() { k=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)/${JOB_WORKTREE_LOCK} i=0; until mkdir "$k" 2>/dev/null; do q=$(cat "$k/pid" 2>/dev/null); if [ -n "$q" ] && ! kill -0 "$q" 2>/dev/null || [ "$i" -ge ${LOCK_WAIT_S} ]; then echo "hopper: took over the start lock $k" >&2; mv "$k" "$k.stale-$$" 2>/dev/null && rm -rf "$k.stale-$$"; i=0; continue; fi; i=$((i+1)); sleep 1; done; l=$k; echo $$ > "$l/pid"; };`,
  'unlock() { [ -z "$l" ] || rm -rf "$l"; l=; };',
  "trap unlock EXIT; trap 'unlock; exit 1' HUP INT TERM;",
  // The workspace (issue #1103), in the work tree: one the hopper makes ignores itself; its worktrees dir always does.
  `ws() { [ -d ${WORKSPACE_DIR} ] || { mkdir ${WORKSPACE_DIR} && printf "*\\n" > ${WORKSPACE_DIR}/.gitignore; }; };`,
  'worktree() { p=$1; w=${p%/*}; [ -e "$p/.git" ] || { mkdir -p "$w" && { [ -e "$w/.gitignore" ] || printf "*\\n" > "$w/.gitignore"; } || return 1; lock; if [ "$f" = 1 ]; then refresh 2>/dev/null; fi; g worktree prune && g worktree add --quiet --detach "$p" "$(base)"; s=$?; unlock; return $s; }; };',
  'lc() { printf %s "$1" | tr "[:upper:]" "[:lower:]"; };',
  'of() { o=$(lc "$(git -C "$1" remote get-url origin 2>/dev/null)"); l=$(lc "$r"); case "$o" in *[:/]"$l"|*[:/]"$l".git|*[:/]"$l"/) return 0;; esac; return 1; };',
  'take() { n=$1; [ -e "$n" ] && return 0; t="$n.hopper-clone-$$"; git clone --quiet "$url" "$t" || { rm -rf "$t"; return 1; }; f=0; if [ -e "$n" ]; then rm -rf "$t"; else mv "$t" "$n"; fi; };',
  'if [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ]; then',
  '  [ "$on" = 1 ] || { echo none; exit 0; };',
  '  if [ -z "$r" ] || of .; then if ws && worktree "$a"; then echo made; else echo unmade; fi; exit 0; fi;',
  'fi;',
  '[ -n "$r" ] || { echo none; exit 0; };',
  `n=${WORKSPACE_DIR}/\${r##*/}; ws && take "$n" || { echo unmade; exit 0; };`,
  'of "$n" || { echo "hopper: $PWD/$n is not a checkout of $r" >&2; echo unmade; exit 0; };',
  'if [ "$on" != 1 ]; then git -C "$n" fetch --quiet --prune || echo "hopper: could not fetch $r" >&2; echo none; exit 0; fi;',
  'cd "$n" || { echo unmade; exit 0; };',
  'if worktree "$b"; then echo checkout; else echo unmade; fi',
].map((l) => l.trim()).join(' ');

/** Each printed as two words, so the command's own echo never reads as what it printed. */
const SAY_RUNNING = `printf 'hopper-%s-%s\\n' worktree running`;
const SAY = `printf 'hopper-job-%s-%s\\n' worktree "\${o:-unmade}"`;

/**
 * Make the job's worktree and enter it, in the pane's shell: of the work tree when that is the top of the
 * job's git repository, or of any when the job names none (a directory inside one, such as a home kept in git,
 * is not the job's repository); else of the checkout of the job's `repo` in the work tree's workspace, fetched or
 * cloned first (`url`, default GitHub's); `fetch` false: no fetch before a new worktree. With `worktrees` off, only the
 * checkout in a work tree that is no repository is fetched or cloned, and the shell stays in the work tree. It says first that it runs
 * (`JOB_WORKTREE_RUNNING`), then its outcome. One line, for any shell to type.
 */
export function makeJobWorktreeCommand(workTree: string, jobId: string, o: { repo?: string; url?: string; worktrees?: boolean; fetch?: boolean } = {}): string {
  const made = jobWorktreeOf(workTree, jobId);
  const ofCheckout = o.repo ? jobWorktreeOf(workTree, jobId, o.repo) : '';
  const args = [made, ofCheckout, o.repo ?? '', o.repo ? (o.url ?? githubUrlOf(o.repo)) : '', o.worktrees === false ? '0' : '1', o.fetch === false ? '0' : '1'].map(shellQuote).join(' ');
  return `cd ${shellQuote(workTree)} && { ${SAY_RUNNING}; o=$(sh -c ${shellQuote(SCRIPT)} hopper-worktree ${args} | tail -n 1);`
    + ` case "$o" in made) cd ${shellQuote(made)};; checkout) cd ${shellQuote(ofCheckout || made)};; esac; ${SAY}; }`;
}

const OUTCOME = new RegExp(`${JOB_WORKTREE_MARK}(made|checkout|none|unmade)\\b`, 'g');

/**
 * The outcome the job worktree command printed on the screen, if it has: the last one, wherever it stands on
 * its line (issue #518), as a prompt or a pane's own wrapping may put text before it.
 */
export function jobWorktreeOutcome(screen: string): JobWorktreeOutcome | undefined {
  return [...screen.matchAll(OUTCOME)].at(-1)?.[1] as JobWorktreeOutcome | undefined;
}

/** Which work trees a job start fetched in the newest sync pass (issue #858 part 2): keyed by machine, work tree and repository. */
export interface PassFetches {
  /** A start in this work tree fetched since the newest sync pass began: fetch nothing now. */
  fresh(key: string): boolean;
  /** A start in this work tree fetched. */
  fetched(key: string): void;
}

/** `lastPass`: the newest sync pass's id (`GitHubTraffic.lastPass`); before the first (0), every start fetches. */
export function passFetches(lastPass: () => number = () => githubTraffic.lastPass()): PassFetches {
  const at = new Map<string, number>();
  return {
    fresh: (key) => lastPass() > 0 && at.get(key) === lastPass(),
    fetched: (key) => { at.set(key, lastPass()); },
  };
}

/** The process's own: every executor's starts share it, so two lanes on one machine fetch once a pass. */
export const jobStartFetches = passFetches();

/** The key of a start's fetch: its machine, its work tree, its repository. */
export const passFetchKey = (machine: string, workTree: string, repo: string | undefined): string => `${machine}\0${trimmed(workTree)}\0${(repo ?? '').toLowerCase()}`;
