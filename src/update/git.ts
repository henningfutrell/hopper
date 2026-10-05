// A bare mirror of the update repository in the data dir, driven by the git CLI. Fetching names
// the repository each time, so a changed install.json `repo` needs nothing else. Never prompts:
// no terminal prompt, ssh in batch mode (an unreachable or unauthorised repo is an error, not a hang).
// ssh reads only the user's own config: the unit's PrivateTmp puts the daemon in a user namespace
// where root-owned files under /etc/ssh show as owned by nobody, and ssh refuses them.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const TIMEOUT_MS = 120_000;
const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;

export interface GitMirror {
  fetch(repo: string): Promise<void>;
  /** The commit a branch points at, or undefined. */
  branchHead(branch: string): Promise<string | undefined>;
  /** The newest `v<major>.<minor>.<patch>` tag and its commit. */
  newestRelease(): Promise<{ tag: string; commit: string } | undefined>;
  has(commit: string): Promise<boolean>;
  /** `ancestor` is reachable from `commit` (equal counts). */
  contains(commit: string, ancestor: string): Promise<boolean>;
  /** How many commits are in `to` and not in `from` (all of `to`'s when `from` is unknown). */
  count(from: string, to: string): Promise<number>;
  /** The text of `path` at `commit`, or undefined when it has no such file. */
  read(commit: string, path: string): Promise<string | undefined>;
  /** The tree of `commit`, unpacked into `dir` (created). */
  extract(commit: string, dir: string): Promise<void>;
}

const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/** GIT_SSH_COMMAND for the mirror: the caller's own if set, else batch mode with only the user's ssh config (or none). */
export function sshCommand(env: Record<string, string | undefined>, home: string, exists: (path: string) => boolean): string {
  if (env.GIT_SSH_COMMAND) return env.GIT_SSH_COMMAND;
  const config = join(home, '.ssh', 'config');
  return `ssh -o BatchMode=yes -F ${exists(config) ? shellQuote(config) : '/dev/null'}`;
}

export function createGitMirror(dir: string): GitMirror {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: sshCommand(process.env, homedir(), existsSync) };
  const git = async (...args: string[]): Promise<string> =>
    (await exec('git', ['--git-dir', dir, ...args], { env, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  const ok = (p: Promise<unknown>): Promise<boolean> => p.then(() => true, () => false);

  return {
    async fetch(repo) {
      if (!existsSync(join(dir, 'HEAD'))) {
        mkdirSync(dir, { recursive: true });
        await git('init', '--bare', '--quiet');
      }
      await git('fetch', '--quiet', '--prune', '--prune-tags', '--force', repo, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*');
    },
    async branchHead(branch) {
      return git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`).catch(() => undefined);
    },
    async newestRelease() {
      const tag = (await git('tag', '--list', 'v*', '--sort=-v:refname')).split('\n').find((t) => SEMVER_TAG.test(t));
      return tag === undefined ? undefined : { tag, commit: await git('rev-parse', `refs/tags/${tag}^{commit}`) };
    },
    has(commit) {
      return ok(git('cat-file', '-e', `${commit}^{commit}`));
    },
    contains(commit, ancestor) {
      return ok(git('merge-base', '--is-ancestor', ancestor, commit));
    },
    async count(from, to) {
      const range = (await this.has(from)) ? [`${from}..${to}`] : [to];
      return Number(await git('rev-list', '--count', ...range, '--'));
    },
    async read(commit, path) {
      return (await this.has(commit)) ? git('show', `${commit}:${path}`).catch(() => undefined) : undefined;
    },
    async extract(commit, target) {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      const tar = `${target}.tar`;
      await git('archive', '--format=tar', '-o', tar, commit);
      try {
        await exec('tar', ['-xf', tar, '-C', target], { timeout: TIMEOUT_MS });
      } finally {
        rmSync(tar, { force: true });
      }
    },
  };
}
