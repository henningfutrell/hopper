// The leftovers of the layout before issue #1188 that the sweep does not judge (issue #1116), listed and removed for real:
// a real shell, real git repositories and a real repository mirror in a work tree's `.hopper-scratch`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLeftoverPath, leftoverArgvOf, leftoverRemoveArgv, leftoversArgv, readLeftoverRemoval, readLeftovers } from '../../src/client/leftovers.ts';

let root: string;
let work: string;
let x: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopper-leftovers-'));
  work = join(root, 'work');
  x = join(work, '.hopper-scratch');
  mkdirSync(x, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
});

/** A bare remote with one commit on main. */
function remote(): string {
  const r = join(root, `remote-${Math.random().toString(36).slice(2)}.git`);
  git(root, 'init', '-q', '--bare', '-b', 'main', r);
  const seed = mkdtempSync(join(root, 'seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'a');
  git(seed, 'push', '-q', r, 'main');
  return r;
}

/** A mirror as job-worktree.ts made it before issue #1188: bare, its branches under refs/remotes/origin. */
function mirror(at: string): string {
  git(root, 'clone', '-q', '--bare', remote(), at);
  git(at, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  git(at, 'fetch', '-q', 'origin');
  git(at, 'update-ref', '-d', 'refs/heads/main');
  git(at, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  return at;
}

const run = (argv: string[]): string => {
  const [file, ...args] = argv;
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 60000 });
};
const list = (...roots: string[]) => readLeftovers(run(leftoversArgv(roots)));
const remove = (path: string) => readLeftoverRemoval(run(leftoverRemoveArgv(path)));

describe('the leftovers a listing finds (issue #1116)', () => {
  it('lists each dir in .hopper-scratch with its age and size, and whether it holds work not pushed; not the shared dependencies, nor a link', () => {
    const clean = join(x, 'other-hopper-1');
    git(root, 'clone', '-q', remote(), join(clean, 'app'));
    const dirty = join(x, 'test-job');
    git(root, 'clone', '-q', remote(), join(dirty, 'app'));
    writeFileSync(join(dirty, 'app', 'a.txt'), 'changed\n');
    const plain = join(x, 'notes');
    mkdirSync(plain);
    writeFileSync(join(plain, 'big'), Buffer.alloc(256 * 1024, 1));
    mkdirSync(join(x, 'deps', 'abc'), { recursive: true });
    symlinkSync(plain, join(x, 'linked'));
    const found = list(work)!;
    expect(found.map((l) => [l.path, l.kind, l.unpushed])).toEqual([[plain, 'scratch', false], [clean, 'scratch', false], [dirty, 'scratch', true]]);
    expect(found.every((l) => l.ageMs >= 0 && l.users === undefined)).toBe(true);
    expect(found[0]!.bytes).toBeGreaterThanOrEqual(256 * 1024);
  });

  it('a commit no remote has is work not pushed', () => {
    const dir = join(x, 'stranger');
    git(root, 'clone', '-q', remote(), join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'b.txt'), 'b\n');
    git(join(dir, 'app'), 'add', 'b.txt');
    git(join(dir, 'app'), 'commit', '-q', '-m', 'local');
    expect(list(work)!.map((l) => l.unpushed)).toEqual([true]);
  });

  it('lists a repository mirror while something holds the layout before, with the worktrees that use it and whether it holds work not pushed', () => {
    const m = mirror(join(x, 'repos', 'owner', 'app.git'));
    const job = join(x, 'kept-job');
    git(m, 'worktree', 'add', '-q', '--detach', join(job, 'app'), 'origin/main');
    git(join(job, 'app'), 'switch', '-q', '-c', 'local-only');
    writeFileSync(join(job, 'app', 'b.txt'), 'b\n');
    git(join(job, 'app'), 'add', 'b.txt');
    git(join(job, 'app'), 'commit', '-q', '-m', 'local');
    const found = list(work)!;
    expect(found.map((l) => [l.path, l.kind, l.unpushed, l.users])).toEqual([[job, 'scratch', true, undefined], [m, 'mirror', true, 1]]);
  });

  it('lists no mirror once nothing holds the layout before: the next reap there removes it (issue #1188)', () => {
    mirror(join(x, 'repos', 'owner', 'app.git'));
    mkdirSync(join(x, 'deps'));
    expect(list(work)).toEqual([]);
  });

  it('lists nothing in a work tree with no .hopper-scratch, or one that is not there', () => {
    const bare = join(root, 'bare');
    mkdirSync(join(bare, '.worktrees'), { recursive: true });
    expect(list(bare, join(root, 'nowhere'))).toEqual([]);
  });
});

describe('a leftover a person removes (issue #1116)', () => {
  it('removes a scratch dir whatever it holds, and git forgets its worktree', () => {
    const m = mirror(join(x, 'repos', 'owner', 'app.git'));
    const job = join(x, 'kept-job');
    git(m, 'worktree', 'add', '-q', '--detach', join(job, 'app'), 'origin/main');
    writeFileSync(join(job, 'app', 'a.txt'), 'changed\n');
    expect(remove(job)).toBe('removed');
    expect(existsSync(job)).toBe(false);
    expect(git(m, 'worktree', 'list')).not.toContain(job);
    expect(existsSync(m)).toBe(true);
  });

  it('removes a mirror and its owner\'s dir when that is empty; nothing else', () => {
    const m = mirror(join(x, 'repos', 'owner', 'app.git'));
    const other = join(x, 'stranger');
    mkdirSync(other);
    expect(remove(m)).toBe('removed');
    expect(existsSync(join(x, 'repos', 'owner'))).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('says a leftover that is no longer there is gone, and never removes a link', () => {
    expect(remove(join(x, 'never'))).toBe('gone');
    const target = join(root, 'elsewhere');
    mkdirSync(target);
    symlinkSync(target, join(x, 'linked'));
    expect(remove(join(x, 'linked'))).toBe('left');
    expect(existsSync(target)).toBe(true);
  });
});

describe('the paths a removal takes (issue #1116)', () => {
  it('takes a dir right in .hopper-scratch, or a mirror in its repos; nothing else', () => {
    expect(isLeftoverPath('/w/.hopper-scratch/abc-1')).toBe(true);
    expect(isLeftoverPath('/w/.hopper-scratch/repos/owner/app.git')).toBe(true);
    for (const p of ['/w/.hopper-scratch', '/w/.hopper-scratch/deps', '/w/.hopper-scratch/repos', '/w/.hopper-scratch/repos/owner', '/w/.hopper-scratch/abc/app',
      '/w/.hopper-scratch/repos/owner/app', '/w/.hopper-scratch/..', '/w/../.hopper-scratch/x', '/w/.hopper-scratch/.hopper-scratch', 'w/.hopper-scratch/x',
      '/w/.worktrees/@scratch/x', '/w//.hopper-scratch/x', '/w/.hopper-scratch/x\n', '/w/.hopper-scratch/repos/owner/.git', 7]) {
      expect(isLeftoverPath(p), String(p)).toBe(false);
    }
  });

  it('a client refuses a body that names anything else', () => {
    expect(leftoverArgvOf('/leftover-remove', { path: '/home' })).toMatch(/must be a leftover/);
    expect(leftoverArgvOf('/leftovers', { roots: ['relative'] })).toMatch(/absolute/);
    expect(leftoverArgvOf('/leftovers', { roots: ['/w'] })).toEqual(leftoversArgv(['/w']));
  });
});
