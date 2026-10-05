// The plugin store's git side (design.md "Plugin store"): a bare mirror in the work dir, fetched
// from the store's HEAD (its default branch) with the update mirror's environment — never prompts,
// ssh in batch mode with only the user's ssh config (src/update/git.ts `sshCommand`).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sshCommand } from '../update/git.ts';

const exec = promisify(execFile);
const TIMEOUT_MS = 120_000;
const HEAD_REF = 'refs/plugin-store/head';

export interface StoreMirror {
  /** Fetch the store's HEAD; the commit it points at. */
  fetch(repo: string): Promise<string>;
  /** A file's text at `commit`, or undefined when there is none. */
  show(commit: string, path: string): Promise<string | undefined>;
  /** The tree id of directory `path` at `commit`, or undefined when there is none. */
  tree(commit: string, path: string): Promise<string | undefined>;
  /** Directory `path` at `commit`, unpacked into `dir` (created, emptied first). */
  extract(commit: string, path: string, dir: string): Promise<void>;
}

export function createStoreMirror(dir: string): StoreMirror {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: sshCommand(process.env, homedir(), existsSync) };
  const git = async (...args: string[]): Promise<string> =>
    (await exec('git', ['--git-dir', dir, ...args], { env, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const maybe = (p: Promise<string>): Promise<string | undefined> => p.then((s) => s, () => undefined);

  return {
    async fetch(repo) {
      if (!existsSync(join(dir, 'HEAD'))) {
        mkdirSync(dir, { recursive: true });
        await git('init', '--bare', '--quiet');
      }
      await git('fetch', '--quiet', '--force', '--no-tags', repo, `+HEAD:${HEAD_REF}`);
      return (await git('rev-parse', `${HEAD_REF}^{commit}`)).trim();
    },
    show(commit, path) {
      return maybe(git('show', `${commit}:${path}`));
    },
    async tree(commit, path) {
      const id = (await maybe(git('rev-parse', '--verify', '--quiet', `${commit}:${path}`)))?.trim();
      if (!id) return undefined;
      return (await maybe(git('cat-file', '-t', id)))?.trim() === 'tree' ? id : undefined;
    },
    async extract(commit, path, target) {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true, mode: 0o700 });
      const tar = `${target}.tar`;
      await git('archive', '--format=tar', '-o', tar, `${commit}:${path}`);
      try {
        await exec('tar', ['-xf', tar, '-C', target], { timeout: TIMEOUT_MS });
      } finally {
        rmSync(tar, { force: true });
      }
    },
  };
}
