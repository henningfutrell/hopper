// Each job its own git worktree (issue #379): jobs on one machine share its work tree, so two jobs in one
// repository stepped on each other (branches, the index lock, uncommitted files, builds). When the work
// tree is the top of the job's git repository, the pane's shell makes the job a worktree of it inside the job's
// scratch dir, and Claude starts there. When it is not (a machine's work tree is a plain directory, the jobs
// directory by default, or another repository's top, issue #431), the job's worktree is made of the
// **repository mirror** in the work tree's scratch dir (issue #858): one bare, blobless clone per repository per
// machine, fetched for the default branch only, so an extra job adds only its worktree to disk; no machine needs its
// repositories set up by hand (issue #361). The reap removes the worktree with the scratch dir when the job ends, or
// keeps it when it holds uncommitted or unpushed work (reap.ts). The command runs in the pane's own shell, so on
// whichever machine the work tree is. design.md "Work tree" → "Each job its own git worktree".

import { posix } from 'node:path';
import { SCRATCH_DIR } from '../../job-rules/index.ts';
import { shellQuote } from '../ssh.ts';

/** What the job worktree command prints, followed by its outcome. */
export const JOB_WORKTREE_MARK = 'hopper-job-worktree-';

/**
 * made: the job runs in a worktree of the work tree; mirror: in a worktree of its repository's mirror in the work
 * tree's scratch dir (issue #858); none: neither (the work tree is no repository's top and the job names no
 * repository, or job worktrees are off); unmade: git refused.
 */
export type JobWorktreeOutcome = 'made' | 'mirror' | 'none' | 'unmade';

const trimmed = (path: string): string => path.replace(/(.)\/+$/, '$1');
const nameOf = (repo: string): string => repo.slice(repo.lastIndexOf('/') + 1);

/** The job's worktree of the work tree: in its scratch dir, named as the work tree is. */
export function jobWorktreeOf(workTree: string, jobId: string): string {
  const tree = trimmed(workTree);
  return `${tree}/${SCRATCH_DIR}/${jobId}/${posix.basename(tree)}`;
}

/**
 * The full checkout of the job's repository (`owner/name`) in a work tree that is no repository, made only with job
 * worktrees off: `<work tree>/<name>` (issue #361). A job then runs in the work tree beside it.
 */
export const checkoutOf = (workTree: string, repo: string): string => `${trimmed(workTree)}/${nameOf(repo)}`;

/**
 * The repository mirror of the job's repository (`owner/name`, issue #858): `<work tree>/.hopper-scratch/repos/<owner>/<name>.git`,
 * a bare, blobless clone whose branches are `refs/remotes/origin/*`. Git ignores it there, and the sweep leaves it (no job's id).
 */
export const mirrorOf = (workTree: string, repo: string): string => `${trimmed(workTree)}/${SCRATCH_DIR}/repos/${repo}.git`;

/** The job's worktree of the mirror: in its scratch dir, named as the repository is. */
export const mirrorWorktreeOf = (workTree: string, jobId: string, repo: string): string =>
  `${trimmed(workTree)}/${SCRATCH_DIR}/${jobId}/${nameOf(repo)}`;

/** A GitHub repository's clone URL. */
export const githubUrlOf = (repo: string): string => `https://github.com/${repo}.git`;

/** What the job worktree command prints first, so the hopper knows the shell runs it (issue #518). */
export const JOB_WORKTREE_RUNNING = 'hopper-worktree-running';

/**
 * Run by `sh` in the work tree: `$1` the worktree of the work tree, `$2` the worktree of the mirror,
 * `$3` the job's repository (`owner/name`, empty for none), `$4` its clone URL, `$5` 1 when job worktrees
 * are on. Prints its outcome last. The worktree is made after one fetch (never prompting, issue #858) of the remote's
 * default branch only, pruned — blobless in a mirror —, detached at it, else the current branch's upstream, else
 * HEAD; one an earlier run of the job left is used as it is, nothing fetched. The mirror is `mirrorOf` when the work
 * tree is no repository's top, or the top of one whose origin is not the job's (matched in any case); its origin must
 * be the repository. A missing one is cloned bare and blobless beside it, its branches moved to
 * `refs/remotes/origin/*` (so the reap reads what a job pushed as pushed), and moved in, so two jobs cloning at once
 * leave one. With job worktrees off, a work tree that is no repository gets the full checkout `<name>` instead, and
 * the job runs beside it. Git reaches GitHub through the hopper, by the variables the job runs with (issue #652): no
 * GitHub token is on the machine or a command line. One line (issue #518): an interactive shell whose start-up files
 * were busy lost or mangled a command of many lines typed into it, so every statement ends in `;` or a keyword.
 */
const SCRIPT = [
  'a=$1 b=$2 r=$3 url=$4 on=$5;',
  'export GIT_TERMINAL_PROMPT=0;',
  "base() { git rev-parse --verify --quiet refs/remotes/origin/HEAD || git rev-parse --verify --quiet '@{upstream}' || git rev-parse --verify HEAD; };",
  // One fetch, of the default branch only (issue #858); a repository that knows no default branch fetches as it is set up.
  'refresh() { d=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); if [ -n "$d" ]; then git fetch --quiet --prune "$@" origin "${d#origin/}"; else git fetch --quiet --prune "$@"; fi; };',
  'worktree() { p=$1; shift; [ -e "$p/.git" ] || { refresh "$@" 2>/dev/null; git worktree prune && git worktree add --quiet --detach "$p" "$(base)"; }; };',
  'lc() { printf %s "$1" | tr "[:upper:]" "[:lower:]"; };',
  'of() { o=$(lc "$(git -C "$1" remote get-url origin 2>/dev/null)"); l=$(lc "$r"); case "$o" in *[:/]"$l"|*[:/]"$l".git|*[:/]"$l"/) return 0;; esac; return 1; };',
  // A bare clone's branches are `refs/heads/*`: moved to `refs/remotes/origin/*`, and fetched there from now on.
  "remotes() { git -C \"$1\" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && h=$(git -C \"$1\" symbolic-ref --short HEAD) && git -C \"$1\" for-each-ref --format='create refs/remotes/origin/%(refname:lstrip=2) %(objectname)%0adelete %(refname)' refs/heads | git -C \"$1\" update-ref --stdin && git -C \"$1\" symbolic-ref refs/remotes/origin/HEAD \"refs/remotes/origin/$h\"; };",
  'take() { n=$1; shift; [ -e "$n" ] && return 0; t="$n.hopper-clone-$$"; git clone --quiet "$@" "$url" "$t" && { [ "$1" != --bare ] || remotes "$t"; } || { rm -rf "$t"; return 1; }; if [ -e "$n" ]; then rm -rf "$t"; else mv "$t" "$n"; fi; };',
  'if [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ]; then',
  '  [ "$on" = 1 ] || { echo none; exit 0; };',
  '  if [ -z "$r" ] || of .; then if worktree "$a"; then echo made; else echo unmade; fi; exit 0; fi;',
  'fi;',
  '[ -n "$r" ] || { echo none; exit 0; };',
  'if [ "$on" != 1 ]; then',
  '  n=${r##*/}; take "$n" || { echo unmade; exit 0; };',
  '  of "$n" || { echo "hopper: $PWD/$n is not a checkout of $r" >&2; echo unmade; exit 0; };',
  '  git -C "$n" fetch --quiet --prune || echo "hopper: could not fetch $r" >&2; echo none; exit 0;',
  'fi;',
  `m=${SCRATCH_DIR}/repos/$r.git; mkdir -p "\${m%/*}" || { echo unmade; exit 0; };`,
  'take "$m" --bare --filter=blob:none || { echo unmade; exit 0; };',
  'of "$m" || { echo "hopper: $PWD/$m is not a mirror of $r" >&2; echo unmade; exit 0; };',
  'cd "$m" || { echo unmade; exit 0; };',
  'if worktree "$b" --filter=blob:none; then echo mirror; else echo unmade; fi',
].map((l) => l.trim()).join(' ');

/** Each printed as two words, so the command's own echo never reads as what it printed. */
const SAY_RUNNING = `printf 'hopper-%s-%s\\n' worktree running`;
const SAY = `printf 'hopper-job-%s-%s\\n' worktree "\${o:-unmade}"`;

/**
 * Make the job's worktree and enter it, in the pane's shell: of the work tree when that is the top of the
 * job's git repository, or of any when the job names none (a directory inside one, such as a home kept in git,
 * is not the job's repository); else of the mirror of the job's `repo` in the work tree's scratch dir, fetched or
 * cloned first (`url`, default GitHub's). With `worktrees` off, only the full checkout in a work tree that is no
 * repository is fetched or cloned, and the shell stays in the work tree. It says first that it runs
 * (`JOB_WORKTREE_RUNNING`), then its outcome. One line, for any shell to type.
 */
export function makeJobWorktreeCommand(workTree: string, jobId: string, o: { repo?: string; url?: string; worktrees?: boolean } = {}): string {
  const made = jobWorktreeOf(workTree, jobId);
  const mirrored = o.repo ? mirrorWorktreeOf(workTree, jobId, o.repo) : '';
  const args = [made, mirrored, o.repo ?? '', o.repo ? (o.url ?? githubUrlOf(o.repo)) : '', o.worktrees === false ? '0' : '1'].map(shellQuote).join(' ');
  return `cd ${shellQuote(workTree)} && { ${SAY_RUNNING}; o=$(sh -c ${shellQuote(SCRIPT)} hopper-worktree ${args} | tail -n 1);`
    + ` case "$o" in made) cd ${shellQuote(made)};; mirror) cd ${shellQuote(mirrored || made)};; esac; ${SAY}; }`;
}

const OUTCOME = new RegExp(`${JOB_WORKTREE_MARK}(made|mirror|none|unmade)\\b`, 'g');

/**
 * The outcome the job worktree command printed on the screen, if it has: the last one, wherever it stands on
 * its line (issue #518), as a prompt or a pane's own wrapping may put text before it.
 */
export function jobWorktreeOutcome(screen: string): JobWorktreeOutcome | undefined {
  return [...screen.matchAll(OUTCOME)].at(-1)?.[1] as JobWorktreeOutcome | undefined;
}
