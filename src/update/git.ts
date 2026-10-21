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
import { bullets, type Notes, WHATS_NEW_DIR, WHATS_NEW_FILE } from './whats-new.ts';

const exec = promisify(execFile);
const TIMEOUT_MS = 120_000;

export interface GitMirror {
  fetch(repo: string): Promise<void>;
  /** The commit a branch points at, or undefined. */
  branchHead(branch: string): Promise<string | undefined>;
  has(commit: string): Promise<boolean>;
  /** `ancestor` is reachable from `commit` (equal counts). */
  contains(commit: string, ancestor: string): Promise<boolean>;
  /** How many commits are in `to` and not in `from` (all of `to`'s when `from` is unknown). */
  count(from: string, to: string): Promise<number>;
  /** The text of `path` at `commit`, or undefined when it has no such file. */
  read(commit: string, path: string): Promise<string | undefined>;
  /** The text of each of `paths` at `commit`, as `read`, from one git process (issue #2367). */
  readAll(commit: string, paths: string[]): Promise<(string | undefined)[]>;
  /** The names of the files in folder `dir` at `commit`; none when it has no such folder. */
  list(commit: string, dir: string): Promise<string[]>;
  /**
   * Along the first-parent line ending at `commit`, each commit that added `- ` lines to `paths`: when, and those
   * lines, newest first. A line the same commit removed elsewhere in `paths` only moved (issue #824): not added.
   */
  added(commit: string, paths: string[]): Promise<{ commit: string; at: string; lines: string[] }[]>;
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

/** The objects `git cat-file --batch` printed, in the order asked; undefined for one it says is missing. */
export function batchObjects(out: Buffer): (string | undefined)[] {
  const objects: (string | undefined)[] = [];
  for (let at = 0; at < out.length;) {
    const end = out.indexOf(10, at);
    const header = out.toString('utf8', at, end < 0 ? out.length : end).split(' ');
    const size = header.length === 3 ? Number(header[2]) : NaN;
    if (end < 0 || Number.isNaN(size)) { objects.push(undefined); at = end < 0 ? out.length : end + 1; continue; }
    objects.push(header[1] === 'blob' ? out.toString('utf8', end + 1, end + 1 + size) : undefined);
    at = end + 1 + size + 1;
  }
  return objects;
}

/** `onGit`: told the arguments of each git process the mirror starts (tests count them). */
export function createGitMirror(dir: string, o: { onGit?: (args: string[]) => void } = {}): GitMirror {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: sshCommand(process.env, homedir(), existsSync) };
  const options = { env, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 };
  const git = async (...args: string[]): Promise<string> => {
    o.onGit?.(args);
    return (await exec('git', ['--git-dir', dir, ...args], options)).stdout.trim();
  };
  // Each spawn holds the event loop while it forks, the longer the larger the daemon (issue #2367): many reads go in one.
  const batch = (specs: string[]): Promise<Buffer> => new Promise((resolve, reject) => {
    o.onGit?.(['cat-file', '--batch']);
    const child = execFile('git', ['--git-dir', dir, 'cat-file', '--batch'], { ...options, encoding: 'buffer' }, (e, out) => (e ? reject(e) : resolve(out)));
    child.stdin?.on('error', () => undefined); // git ended early: its error comes through the callback
    child.stdin?.end(specs.map((s) => `${s}\n`).join(''));
  });
  const ok = (p: Promise<unknown>): Promise<boolean> => p.then(() => true, () => false);

  return {
    async fetch(repo) {
      if (!existsSync(join(dir, 'HEAD'))) {
        mkdirSync(dir, { recursive: true });
        await git('init', '--bare', '--quiet');
      }
      await git('fetch', '--quiet', '--prune', '--force', repo, '+refs/heads/*:refs/heads/*');
    },
    async branchHead(branch) {
      return git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`).catch(() => undefined);
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
    async readAll(commit, paths) {
      if (!paths.length) return [];
      const objects = batchObjects(await batch(paths.map((p) => `${commit}:${p}`)));
      return paths.map((_, i) => objects[i]);
    },
    async list(commit, dir) {
      if (!(await this.has(commit))) return [];
      const out = await git('ls-tree', '--name-only', commit, `${dir}/`).catch(() => '');
      return out.split('\n').filter(Boolean).map((p) => p.slice(dir.length + 1));
    },
    async added(commit, paths) {
      // First parent only: a merged pull request is one version, dated when it landed.
      const log = await git('log', '--first-parent', '--diff-merges=first-parent', '-p', '--unified=0', '--format=%x00%H %cI', commit, '--', ...paths);
      const changed = (diff: string[], sign: string): string[] =>
        bullets(diff.filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).map((l) => l.slice(1)).join('\n'));
      return log.split('\0').flatMap((chunk) => {
        const [head = '', ...diff] = chunk.split('\n');
        const [sha, at] = head.split(' ');
        const moved = new Set(changed(diff, '-'));
        const lines = changed(diff, '+').filter((l) => !moved.has(l));
        return sha && at && lines.length ? [{ commit: sha, at, lines }] : [];
      });
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

/** What's new at `commit` of the mirror: WHATS-NEW.md and the fragments of `whats-new/` (issue #824). */
export async function notesAt(mirror: GitMirror, commit: string): Promise<Notes> {
  const names = (await mirror.list(commit, WHATS_NEW_DIR)).filter((n) => n.endsWith('.md'));
  const [file, ...texts] = await mirror.readAll(commit, [WHATS_NEW_FILE, ...names.map((name) => `${WHATS_NEW_DIR}/${name}`)]);
  return { file: file ?? '', fragments: names.map((name, i) => ({ name, text: texts[i] ?? '' })) };
}
