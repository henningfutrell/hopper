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
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { githubTraffic, type GitHubTraffic } from '../github-limiter/traffic.ts';

/** Where git fetches a repository, and the token it fetches with; none: a public repository, fetched as anyone's. */
export interface GitRemote { url: string; token?: string }

/** A pull request as git needs it: its number, the branch it merges into, its head commit. */
export interface PullRequestHead { number: number; base: string; headOid: string }

export type Mergeability = 'clean' | 'conflicting';

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
}

/** One git command in a mirror: its exit code and what it printed. Tests may give their own. */
export type GitRun = (args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;

const TIMEOUT_MS = 120_000;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A branch name as a refspec may hold it: no option, no `..`, no glob, no `:`. */
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const PULL = 'refs/remotes/origin/pull/';

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
  };
}
