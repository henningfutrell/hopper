// scripts/whats-new.ts (issue #824): `assemble` moves the What's new fragments into WHATS-NEW.md before a promotion,
// and `check <base>` is the pull request check that refuses a line added to WHATS-NEW.md directly. Each test runs the
// script in a local git repository of its own.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'whats-new.ts');
const HEADER = "# What's new\n\nWhat changed.\n\n";

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('/usr/bin/git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
function commit(files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(repo, path));
    else {
      mkdirSync(join(repo, 'whats-new'), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  return git('rev-parse', 'HEAD');
}

let base: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'jh-whats-new-'));
  git('init', '-q', '-b', 'dev');
  base = commit({ 'WHATS-NEW.md': `${HEADER}- Older news.\n`, 'whats-new/README.md': 'How to write a fragment.\n' });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('scripts/whats-new.ts', () => {
  it('check passes a pull request that adds a fragment', () => {
    commit({ 'whats-new/12.md': '- You can pause the queue.\n' });
    const r = run('check', base);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('check fails a pull request that adds a line to WHATS-NEW.md directly, and says where it goes', () => {
    commit({ 'WHATS-NEW.md': `${HEADER}- You can pause the queue.\n- Older news.\n` });
    const r = run('check', base);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('WHATS-NEW.md got a line directly: put it in whats-new/<issue number>.md instead: "You can pause the queue."');
  });

  it('assemble moves every fragment into the top of WHATS-NEW.md, deletes them, keeps the README, and passes the check', () => {
    const fragments = commit({ 'whats-new/12.md': '- Jobs show their machine.\n', 'whats-new/13.md': '- You can pause the queue.\n' });
    const r = run('assemble');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('moved 2 fragment(s)');
    expect(readFileSync(join(repo, 'WHATS-NEW.md'), 'utf8')).toBe(`${HEADER}- You can pause the queue.\n- Jobs show their machine.\n- Older news.\n`);
    expect(existsSync(join(repo, 'whats-new', '12.md'))).toBe(false);
    expect(existsSync(join(repo, 'whats-new', 'README.md'))).toBe(true);
    git('add', '-A');
    git('commit', '-q', '-m', 'assemble');
    expect(run('check', fragments).status).toBe(0);
    expect(run('assemble').stdout).toContain('nothing to assemble');
  });

  it('says how to use it', () => {
    expect(run().status).toBe(2);
    expect(run('check').stderr).toContain('usage');
  });
});
