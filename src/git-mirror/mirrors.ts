// The hopper's mirror (issue #858 part 2, design.md "Git efficiency"): one bare, blobless git repository per job
// repository per user, in the user's work dir (`<user's work dir>/git-mirrors/<owner>/<name>.git`), so git, not GitHub's
// `mergeable`, says whether a pull request merges into its base. It is fetched at most once per repository per sync pass,
// when the pass first asks of it: the pull request's base branch and every pull request head (`refs/pull/*/head`, so a
// fork's too), pruned and blobless, with the source's own GitHub credential in git's environment, never on a command line.
// Then `git merge-tree --write-tree <base> <head>` answers: 0 clean, 1 conflicts. A blob git needs for a file both sides
// changed comes on demand. Git cannot say — outside a pass, a fetch that failed, another base than the one fetched, a head
// that moved since the fetch, git failing — and the caller keeps GitHub's answer. Scratch only: a fetch makes it again.
// Two pull requests of one repository conflict with each other (issue #939) when `git merge-tree --write-tree <a> <b>` of
// their heads, as this pass fetched them, has conflicts: their own changes touch the same lines. Merge both, and the
// second gets merge conflicts. Neither head fetched, or git failing: git cannot say.
// The base merge (issue #967): the hopper merges a pull request's base branch, as this pass fetched it, into the pull
// request's head, in the mirror, and pushes the merge commit to the pull request's branch — no job, no lane. A conflict
// is resolved only in a Markdown file where both sides only added lines at the same place (no line of the merge base is in
// the conflict): both additions are kept, the base branch's first (`WHATS-NEW.md` lines, design sections). Any other
// conflict is a real one: nothing is pushed, and the files are named. The push leases the branch at the head as fetched
// (`--force-with-lease`), so a branch that moved, or a fork's branch that is not in the repository, is never written.
// What a pull request changes (issue #935 part 2, design.md "A job's parts list"): its commits after the merge base with
// its base branch, and the files it changes there, as `git log` and `git diff --name-only` of the pass's fetch say. Both
// read commits and trees only, which a blobless mirror has: no blob comes.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BaseMerge } from '../domain/pull-requests.ts';
import { githubTraffic, type GitHubTraffic } from '../github-limiter/traffic.ts';

/** Where git fetches a repository, and the token it fetches with; none: a public repository, fetched as anyone's. */
export interface GitRemote { url: string; token?: string }

/** A pull request as git needs it: its number, the branch it merges into, its head commit. */
export interface PullRequestHead { number: number; base: string; headOid: string }

export type Mergeability = 'clean' | 'conflicting';

/** A pull request whose base branch the hopper merges into its head (issue #967): its number, base and head branch. */
export interface BaseMergeTarget { number: number; base: string; headRef: string }

/** What a pull request changes: its commits, newest first, `<short sha> <subject>`; the paths of the files it changes. */
export interface PullRequestChanges { commits: string[]; files: string[] }

/** At most this many commits and files are named of one pull request. */
export const CHANGES_COMMITS = 100;
export const CHANGES_FILES = 300;

export interface GitMirrors {
  /**
   * Whether pull request `pr` of `repo` (`owner/name`) merges into its base, as git says after this pass's fetch;
   * undefined: git cannot say. `remote` is asked once per pass, for the fetch.
   */
  mergeability(repo: string, remote: () => Promise<GitRemote>, pr: PullRequestHead): Promise<Mergeability | undefined>;
  /**
   * Whether pull requests `a` and `b` of `repo`, both into `base`, conflict with each other (issue #939), as git says
   * of their heads after this pass's fetch; undefined: git cannot say.
   */
  conflictBetween(repo: string, remote: () => Promise<GitRemote>, base: string, a: number, b: number): Promise<boolean | undefined>;
  /**
   * Merge the base branch into pull request `pr` of `repo` and push the merge commit to its branch (issue #967), as this
   * pass fetched both; undefined: git cannot say (outside a pass, not fetched, a name git must not take, the push refused).
   */
  baseMerge(repo: string, remote: () => Promise<GitRemote>, pr: BaseMergeTarget): Promise<BaseMerge | undefined>;
  /** What pull request `pr` of `repo` changes, as git says after this pass's fetch (issue #935 part 2); undefined: git cannot say. */
  changes(repo: string, remote: () => Promise<GitRemote>, pr: PullRequestHead): Promise<PullRequestChanges | undefined>;
}

/** One git command in a mirror: its exit code and what it printed. Tests may give their own. */
export type GitRun = (args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;

const TIMEOUT_MS = 120_000;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A branch name as a refspec may hold it: no option, no `..`, no glob, no `:`. */
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const PULL = 'refs/remotes/origin/pull/';
/** A conflict marker of `git merge-file --diff3` at `MARKER` characters: longer than any line a file is likely to hold. */
const MARKER = 40;
/** Who a base merge's commit is by (issue #967): the hopper, no person. */
const AUTHOR = { GIT_AUTHOR_NAME: 'hopper', GIT_AUTHOR_EMAIL: 'hopper@noreply.invalid', GIT_COMMITTER_NAME: 'hopper', GIT_COMMITTER_EMAIL: 'hopper@noreply.invalid' };
/** A file whose added lines a base merge may keep from both sides (issue #967). */
const UNION = /\.md$/i;

/**
 * Both sides' additions of a `git merge-file --diff3` result (issue #967), the base branch's (`theirs`) first; undefined
 * when a conflict holds a line of the merge base: one side changed or removed a line, which is a real conflict.
 */
export function keepBothAdditions(merged: string): string | undefined {
  const [open, mid, sep, close] = ['<', '|', '=', '>'].map((c) => c.repeat(MARKER));
  const out: string[] = [];
  let ours: string[] = [], base: string[] = [], theirs: string[] = [];
  let at: 'none' | 'ours' | 'base' | 'theirs' = 'none';
  for (const line of merged.split('\n')) {
    if (at === 'none' && line.startsWith(`${open!} `)) { at = 'ours'; ours = []; base = []; theirs = []; continue; }
    if (at === 'ours' && line.startsWith(`${mid!} `)) { at = 'base'; continue; }
    if (at === 'base' && line === sep) { at = 'theirs'; continue; }
    if (at === 'theirs' && line.startsWith(`${close!} `)) {
      if (base.length > 0) return undefined;
      out.push(...theirs, ...ours);
      at = 'none';
      continue;
    }
    (at === 'ours' ? ours : at === 'base' ? base : at === 'theirs' ? theirs : out).push(line);
  }
  return at === 'none' ? out.join('\n') : undefined;
}

export const runGit: GitRun = (args, env) => new Promise((resolve) => {
  execFile('git', args, { env: { ...process.env, ...env }, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
    const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr || (e && code === -1 ? e.message : '')) });
  });
});

/** git's environment for one mirror: no prompt, and the token as an HTTP header in git's config from the environment. */
function gitEnv(remote: GitRemote): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  if (!remote.token) return env;
  const basic = Buffer.from(`x-access-token:${remote.token}`).toString('base64');
  return { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

interface Fetched {
  /** The base branch fetched. */
  base: string;
  /** Each pull request's head as fetched, by number. */
  heads: Map<number, string>;
  env: Record<string, string>;
}

interface RepoState { pass: number; fetched: Promise<Fetched | undefined> }

/** A mirror's path for `repo`: `<dir>/<owner>/<name>.git`. */
export const mirrorPathOf = (dir: string, repo: string): string => join(dir, `${repo}.git`);

export function createGitMirrors(o: { dir: string; log(line: string): void; traffic?: GitHubTraffic; git?: GitRun }): GitMirrors {
  const traffic = o.traffic ?? githubTraffic;
  const git = o.git ?? runGit;
  const repos = new Map<string, RepoState>();

  const said = (r: { stderr: string; code: number }): string => r.stderr.trim().replace(/\s*\n\s*/g, ' ') || `git exited ${r.code}`;

  /** The mirror, made bare and blobless the first time (in a temporary path, then moved in), its origin `url`. */
  async function ready(path: string, url: string, env: Record<string, string>): Promise<string | undefined> {
    if (!existsSync(join(path, 'HEAD'))) {
      const made = `${path}.hopper-init-${process.pid}`;
      rmSync(made, { recursive: true, force: true });
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      for (const args of [
        ['init', '--quiet', '--bare', made],
        ['--git-dir', made, 'remote', 'add', 'origin', url],
        ['--git-dir', made, 'config', 'remote.origin.promisor', 'true'],
        ['--git-dir', made, 'config', 'remote.origin.partialclonefilter', 'blob:none'],
        ['--git-dir', made, 'config', 'core.repositoryformatversion', '1'],
        ['--git-dir', made, 'config', 'extensions.partialClone', 'origin'],
      ]) {
        const r = await git(args, env);
        if (r.code !== 0) { rmSync(made, { recursive: true, force: true }); return said(r); }
      }
      if (existsSync(join(path, 'HEAD'))) rmSync(made, { recursive: true, force: true });
      else renameSync(made, path);
    }
    const now = await git(['--git-dir', path, 'remote', 'get-url', 'origin'], env);
    if (now.code === 0 && now.stdout.trim() === url) return undefined;
    const set = await git(['--git-dir', path, 'remote', 'set-url', 'origin', url], env);
    return set.code === 0 ? undefined : said(set);
  }

  /** This pass's one fetch of `repo`: `base` and every pull request head, pruned and blobless. */
  async function fetch(repo: string, path: string, remote: () => Promise<GitRemote>, base: string): Promise<Fetched | undefined> {
    const problem = (why: string): undefined => { o.log(`hopper: git mirror of ${repo}: ${why}`); return undefined; };
    let r: GitRemote;
    try { r = await remote(); } catch (e) { return problem(`no credential to fetch with: ${(e as Error).message}`); }
    const env = gitEnv(r);
    const notReady = await ready(path, r.url, env);
    if (notReady) return problem(notReady);
    traffic.gitFetch(repo);
    const fetched = await git(['--git-dir', path, 'fetch', '--quiet', '--prune', '--no-tags', '--filter=blob:none', 'origin',
      `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/pull/*/head:${PULL}*`], env);
    if (fetched.code !== 0) return problem(said(fetched));
    const refs = await git(['--git-dir', path, 'for-each-ref', '--format=%(objectname) %(refname)', PULL], env);
    if (refs.code !== 0) return problem(said(refs));
    const heads = new Map<number, string>();
    for (const line of refs.stdout.split('\n')) {
      const [oid, ref] = line.split(' ');
      const n = Number(ref?.slice(PULL.length));
      if (oid && Number.isInteger(n)) heads.set(n, oid);
    }
    return { base, heads, env };
  }

  /** This pass's fetch of `repo` with `base`; undefined: outside a pass, a name git must not take, or the fetch failed. */
  async function fetchedIn(repo: string, remote: () => Promise<GitRemote>, base: string): Promise<{ path: string; f: Fetched } | undefined> {
    const pass = traffic.passId();
    if (pass === undefined || !REPO.test(repo) || repo.split('/').some((p) => p.startsWith('.')) || !BRANCH.test(base)) return undefined;
    const path = mirrorPathOf(o.dir, repo);
    let state = repos.get(repo);
    if (state?.pass !== pass) {
      state = { pass, fetched: fetch(repo, path, remote, base) };
      repos.set(repo, state);
    }
    const f = await state.fetched;
    return f && f.base === base ? { path, f } : undefined;
  }

  return {
    async mergeability(repo, remote, pr) {
      const at = await fetchedIn(repo, remote, pr.base);
      if (!at || at.f.heads.get(pr.number) !== pr.headOid) return undefined;
      const r = await git(['--git-dir', at.path, 'merge-tree', '--write-tree', `refs/remotes/origin/${pr.base}`, pr.headOid], at.f.env);
      if (r.code === 0) return 'clean';
      if (r.code === 1) return 'conflicting';
      o.log(`hopper: git mirror of ${repo}: merge-tree of #${pr.number}: ${said(r)}`);
      return undefined;
    },
    async conflictBetween(repo, remote, base, a, b) {
      const at = await fetchedIn(repo, remote, base);
      const [ha, hb] = [at?.f.heads.get(a), at?.f.heads.get(b)];
      if (!at || !ha || !hb) return undefined;
      const r = await git(['--git-dir', at.path, 'merge-tree', '--write-tree', ha, hb], at.f.env);
      if (r.code === 0 || r.code === 1) return r.code === 1;
      o.log(`hopper: git mirror of ${repo}: merge-tree of #${a} and #${b}: ${said(r)}`);
      return undefined;
    },
    async baseMerge(repo, remote, pr) {
      if (!BRANCH.test(pr.headRef) || pr.headRef === pr.base) return undefined;
      const at = await fetchedIn(repo, remote, pr.base);
      const head = at?.f.heads.get(pr.number);
      if (!at || !head) return undefined;
      const problem = (why: string): undefined => { o.log(`hopper: git mirror of ${repo}: base merge of #${pr.number}: ${why}`); return undefined; };
      const run = (args: string[], env: Record<string, string> = {}) => git(['--git-dir', at.path, ...args], { ...at.f.env, ...env });
      const base = await run(['rev-parse', `refs/remotes/origin/${pr.base}`]);
      if (base.code !== 0) return problem(said(base));
      const baseOid = base.stdout.trim();
      const tree = await run(['merge-tree', '--write-tree', '--name-only', '-z', head, baseOid]);
      if (tree.code !== 0 && tree.code !== 1) return problem(`merge-tree: ${said(tree)}`);
      const [treeOid, ...rest] = tree.stdout.split('\0');
      const conflicted = tree.code === 0 ? [] : [...new Set(rest.slice(0, rest.indexOf('')))];
      const resolved = await resolve(run, head, baseOid, conflicted);
      if ('files' in resolved) return { outcome: 'conflicts', files: resolved.files };
      const finalTree = await withBlobs(run, at.path, treeOid!, resolved.blobs);
      if (!finalTree) return problem('could not write the merged tree');
      const commit = await run(['commit-tree', finalTree, '-p', head, '-p', baseOid, '-m', `Merge branch '${pr.base}' into ${pr.headRef}`], AUTHOR);
      if (commit.code !== 0) return problem(`commit-tree: ${said(commit)}`);
      const oid = commit.stdout.trim();
      const pushed = await run(['push', '--quiet', '--porcelain', `--force-with-lease=refs/heads/${pr.headRef}:${head}`, 'origin', `${oid}:refs/heads/${pr.headRef}`]);
      if (pushed.code !== 0) return problem(`push refused: ${said(pushed)}`);
      at.f.heads.set(pr.number, oid);
      return { outcome: 'pushed', commit: oid, resolved: resolved.blobs.map((b) => b.path) };
    },
    async changes(repo, remote, pr) {
      const at = await fetchedIn(repo, remote, pr.base);
      if (!at || at.f.heads.get(pr.number) !== pr.headOid) return undefined;
      const base = `refs/remotes/origin/${pr.base}`;
      const log = await git(['--git-dir', at.path, 'log', `--max-count=${CHANGES_COMMITS}`, '--format=%h %s', `${base}..${pr.headOid}`], at.f.env);
      const diff = await git(['--git-dir', at.path, 'diff', '--name-only', '--no-renames', `${base}...${pr.headOid}`], at.f.env);
      if (log.code !== 0 || diff.code !== 0) {
        o.log(`hopper: git mirror of ${repo}: changes of #${pr.number}: ${said(log.code !== 0 ? log : diff)}`);
        return undefined;
      }
      const lines = (out: string) => out.split('\n').filter((l) => l.length > 0);
      return { commits: lines(log.stdout), files: lines(diff.stdout).slice(0, CHANGES_FILES) };
    },
  };

  type Run = (args: string[], env?: Record<string, string>) => ReturnType<GitRun>;
  interface Blob { path: string; mode: string; oid: string }

  /**
   * Each conflicted file resolved by keeping both sides' additions (issue #967), as a blob written to the mirror; or the
   * files that are not: not Markdown, not in all three of the merge base and both sides, or one side changed a line.
   */
  async function resolve(run: Run, head: string, base: string, files: string[]): Promise<{ blobs: Blob[] } | { files: string[] }> {
    const mb = await run(['merge-base', head, base]);
    const blobs: Blob[] = [];
    const not: string[] = [];
    for (const path of files) {
      const blob = mb.code === 0 ? await resolveOne(run, head, mb.stdout.trim(), base, path) : undefined;
      if (blob) blobs.push(blob); else not.push(path);
    }
    return not.length > 0 ? { files: not } : { blobs };
  }

  async function resolveOne(run: Run, head: string, mergeBase: string, base: string, path: string): Promise<Blob | undefined> {
    if (!UNION.test(path)) return undefined;
    const mode = (await run(['ls-tree', head, '--', path])).stdout.split(/\s/)[0];
    if (mode !== '100644') return undefined;
    const merged = await run(['merge-file', '-p', '--diff3', `--marker-size=${MARKER}`, '--object-id', `${head}:${path}`, `${mergeBase}:${path}`, `${base}:${path}`]);
    if (merged.code <= 0) return undefined;
    const text = keepBothAdditions(merged.stdout);
    if (text === undefined) return undefined;
    const oid = await hashBlob(run, text);
    return oid ? { path, mode, oid } : undefined;
  }

  /** Write `text` as a blob in the mirror; undefined: git failed. */
  async function hashBlob(run: Run, text: string): Promise<string | undefined> {
    const file = join(o.dir, `.hopper-blob-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, text);
    try {
      const r = await run(['hash-object', '-w', '--no-filters', file]);
      return r.code === 0 ? r.stdout.trim() : undefined;
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** `tree` with each of `blobs` in its place, through an index file of its own; undefined: git failed. */
  async function withBlobs(run: Run, path: string, tree: string, blobs: Blob[]): Promise<string | undefined> {
    if (blobs.length === 0) return tree;
    const index = { GIT_INDEX_FILE: join(path, `hopper-base-merge-${process.pid}-${Math.random().toString(36).slice(2)}.index`) };
    try {
      if ((await run(['read-tree', tree], index)).code !== 0) return undefined;
      for (const b of blobs) if ((await run(['update-index', '--cacheinfo', `${b.mode},${b.oid},${b.path}`], index)).code !== 0) return undefined;
      const w = await run(['write-tree'], index);
      return w.code === 0 ? w.stdout.trim() : undefined;
    } finally {
      rmSync(index.GIT_INDEX_FILE, { force: true });
    }
  }
}
