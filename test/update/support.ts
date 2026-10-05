// Real git repositories in temp dirs for the self-update tests: an upstream with commits and
// tags, and an install directory (install.json + src/main.ts) built from one of its commits.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateBuilder } from '../../src/domain/ports.ts';
import type { InstallInfo } from '../../src/domain/types.ts';

const ID = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } }).trim();
}

export interface Upstream {
  dir: string;
  /** Commit `app.txt` = `content` with this subject on the current branch; returns the sha. */
  commit(subject: string, content?: string): string;
  /** Write WHATS-NEW.md with these bullets, newest first, for the next commit. */
  whatsNew(bullets: string[]): void;
  tag(name: string, commit: string): void;
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function createUpstream(root: string): Upstream {
  const dir = join(root, 'upstream');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  return {
    dir,
    commit(subject, content = subject) {
      writeFileSync(join(dir, 'app.txt'), content);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', subject);
      return git(dir, 'rev-parse', 'HEAD');
    },
    tag(name, commit) { git(dir, 'tag', name, commit); },
    whatsNew(bullets) { writeFileSync(join(dir, 'WHATS-NEW.md'), `# What's new\n\n${bullets.map((b) => `- ${b}\n`).join('')}`); },
  };
}

/** An install dir: install.json naming `commit` of `repo`, and the app as built (app.txt, src/main.ts, WHATS-NEW.md when the commit has one). */
export function createInstall(root: string, repo: string, commit: string, branch = 'main'): string {
  const appDir = join(root, 'app');
  mkdirSync(join(appDir, 'src'), { recursive: true });
  const info: InstallInfo = { repo, branch, commit, installedAt: '2026-10-04T00:00:00.000Z' };
  writeFileSync(join(appDir, 'install.json'), JSON.stringify(info));
  writeFileSync(join(appDir, 'app.txt'), git(repo, 'show', `${commit}:app.txt`));
  writeFileSync(join(appDir, 'src', 'main.ts'), 'export {};\n');
  const notes = git(repo, 'ls-tree', '--name-only', commit, 'WHATS-NEW.md').trim();
  if (notes) writeFileSync(join(appDir, 'WHATS-NEW.md'), git(repo, 'show', `${commit}:WHATS-NEW.md`));
  return appDir;
}

export const readInstall = (appDir: string): InstallInfo => JSON.parse(readFileSync(join(appDir, 'install.json'), 'utf8')) as InstallInfo;

/** A builder that copies the source tree and adds src/main.ts (`main` overrides its text) and install.json. */
export function copyBuilder(o: { main?: string; calls?: string[] } = {}): UpdateBuilder {
  return {
    async build(sourceDir, targetDir, info) {
      o.calls?.push(info.commit);
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true });
      mkdirSync(join(targetDir, 'src'), { recursive: true });
      writeFileSync(join(targetDir, 'src', 'main.ts'), o.main ?? 'export {};\n');
      writeFileSync(join(targetDir, 'install.json'), JSON.stringify(info));
    },
  };
}
