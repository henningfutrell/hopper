// Each job its own git worktree (issue #379): jobs on one machine share its work tree, so two jobs in one
// repository stepped on each other (branches, the index lock, uncommitted files, builds). When the work
// tree is the top of a git repository, the pane's shell makes the job a worktree of it inside the job's
// scratch dir, and Claude starts there. When it is not (a machine's work tree is a plain directory, the
// jobs directory by default), the job's repository is fetched or cloned into it first, and the job's
// worktree is made of that checkout (issue #361): no machine needs its repositories set up by hand. The
// reap removes the worktree with the scratch dir when the job ends, or keeps it when it holds uncommitted
// or unpushed work (reap.ts). The command runs in the pane's own shell, so on whichever machine the work
// tree is. design.md "Work tree" → "Each job its own git worktree".

import { posix } from 'node:path';
import { SCRATCH_DIR } from '../../job-rules/index.ts';
import { shellQuote } from '../ssh.ts';

/** What the job worktree command prints, followed by its outcome. */
export const JOB_WORKTREE_MARK = 'hopper-job-worktree-';

/**
 * made: the job runs in a worktree of the work tree; checkout: in a worktree of its repository's checkout
 * in the work tree; none: neither (the work tree is no repository's top and the job names no repository,
 * or job worktrees are off); unmade: git refused.
 */
export type JobWorktreeOutcome = 'made' | 'checkout' | 'none' | 'unmade';

const trimmed = (path: string): string => path.replace(/(.)\/+$/, '$1');
const nameOf = (repo: string): string => repo.slice(repo.lastIndexOf('/') + 1);

/** The job's worktree of the work tree: in its scratch dir, named as the work tree is. */
export function jobWorktreeOf(workTree: string, jobId: string): string {
  const tree = trimmed(workTree);
  return `${tree}/${SCRATCH_DIR}/${jobId}/${posix.basename(tree)}`;
}

/** The checkout of the job's repository (`owner/name`) in a work tree that is no repository: `<work tree>/<name>` (issue #361). */
export const checkoutOf = (workTree: string, repo: string): string => `${trimmed(workTree)}/${nameOf(repo)}`;

/** The job's worktree of that checkout: in its scratch dir, named as the repository is. */
export const checkoutWorktreeOf = (workTree: string, jobId: string, repo: string): string =>
  `${trimmed(workTree)}/${SCRATCH_DIR}/${jobId}/${nameOf(repo)}`;

/** A GitHub repository's clone URL. */
export const githubUrlOf = (repo: string): string => `https://github.com/${repo}.git`;

/**
 * Run by `sh` in the work tree: `$1` the worktree of the work tree, `$2` the worktree of the checkout,
 * `$3` the job's repository (`owner/name`, empty for none), `$4` its clone URL, `$5` 1 when job worktrees
 * are on. Prints its outcome last. The worktree is made after a fetch (never prompting), detached at the
 * remote's default branch, else the current branch's upstream, else HEAD; one an earlier run of the job
 * left is used as it is. A checkout is `<name>` in the work tree, whose origin must be the repository; a
 * missing one is cloned beside it and moved in, so two jobs cloning at once leave one. Git asks for
 * github.com credentials only `GH_TOKEN` (the job's connection, issue #214), else `gh`, by name: the
 * token is never on a command line.
 */
const SCRIPT = [
  'a=$1 b=$2 r=$3 url=$4 on=$5',
  'export GIT_TERMINAL_PROMPT=0',
  "base() { git rev-parse --verify --quiet refs/remotes/origin/HEAD || git rev-parse --verify --quiet '@{upstream}' || git rev-parse --verify HEAD; }",
  'worktree() { git fetch --quiet 2>/dev/null; git worktree prune && { [ -e "$1/.git" ] || git worktree add --quiet --detach "$1" "$(base)"; }; }',
  'if [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ]; then',
  '  [ "$on" = 1 ] || { echo none; exit 0; }',
  '  if worktree "$a"; then echo made; else echo unmade; fi; exit 0',
  'fi',
  '[ -n "$r" ] || { echo none; exit 0; }',
  'n=${r##*/}',
  'if [ -n "$GH_TOKEN" ]; then h=\'!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f\'',
  "elif command -v gh >/dev/null 2>&1; then h='!gh auth git-credential'; else h=; fi",
  '[ -z "$h" ] || export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1="$h"',
  'if [ -e "$n/.git" ]; then',
  '  case "$(git -C "$n" remote get-url origin 2>/dev/null)" in',
  '    *[:/]"$r"|*[:/]"$r".git|*[:/]"$r"/) ;;',
  '    *) echo "hopper: $PWD/$n is not a checkout of $r" >&2; echo unmade; exit 0;;',
  '  esac',
  'else',
  '  t="$n.hopper-clone-$$"',
  '  git clone --quiet "$url" "$t" || { rm -rf "$t"; echo unmade; exit 0; }',
  '  if [ -e "$n" ]; then rm -rf "$t"; else mv "$t" "$n"; fi',
  'fi',
  'cd "$n" || { echo unmade; exit 0; }',
  'if [ "$on" != 1 ]; then git fetch --quiet || echo "hopper: could not fetch $r" >&2; echo none; exit 0; fi',
  'if worktree "$b"; then echo checkout; else echo unmade; fi',
].join('\n');

/** Printed as two words, so the command's own echo never reads as its outcome. */
const SAY = `printf 'hopper-job-%s-%s\\n' worktree "\${o:-unmade}"`;

/**
 * Make the job's worktree and enter it, in the pane's shell: of the work tree when that is the top of a
 * git repository (a directory inside one, such as a home kept in git, is not the job's repository), else
 * of the checkout of the job's `repo` in it, fetched or cloned first (`url`, default GitHub's). With
 * `worktrees` off, only the checkout is fetched or cloned, and the shell stays in the work tree.
 */
export function makeJobWorktreeCommand(workTree: string, jobId: string, o: { repo?: string; url?: string; worktrees?: boolean } = {}): string {
  const made = jobWorktreeOf(workTree, jobId);
  const checkout = o.repo ? checkoutWorktreeOf(workTree, jobId, o.repo) : '';
  const args = [made, checkout, o.repo ?? '', o.repo ? (o.url ?? githubUrlOf(o.repo)) : '', o.worktrees === false ? '0' : '1'].map(shellQuote).join(' ');
  return `cd ${shellQuote(workTree)} && { o=$(sh -c ${shellQuote(SCRIPT)} hopper-worktree ${args} | tail -n 1);`
    + ` case "$o" in made) cd ${shellQuote(made)};; checkout) cd ${shellQuote(checkout || made)};; esac; ${SAY}; }`;
}

/** The outcome the job worktree command printed on the screen, if it has. */
export function jobWorktreeOutcome(screen: string): JobWorktreeOutcome | undefined {
  const last = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(JOB_WORKTREE_MARK)).at(-1)?.slice(JOB_WORKTREE_MARK.length);
  return last === 'made' || last === 'checkout' || last === 'none' || last === 'unmade' ? last : undefined;
}
