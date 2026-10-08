// Dependencies shared by a repository's job worktrees (issue #410), run for real: the command each job's
// pane shell runs in its new worktree, sh and git the machine's own, npm a stand-in that logs each install.
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { depsOutcome, shareDepsCommand } from '../../src/executors/herdr/shared-deps.ts';

const run = promisify(execFile);
let root: string;
let tree: string;
let env: NodeJS.ProcessEnv;

const LOCK = JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' } } });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jh-deps-')));
  tree = join(root, 'tree');
  mkdirSync(join(tree, '.hopper-scratch'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // npm ci: logs where it ran, takes a moment, and makes node_modules; NPM_FAIL fails it.
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s %s\\n" "$PWD" "$*" >> "$NPM_LOG"\n[ -n "$NPM_FAIL" ] && exit 1\nsleep 0.3\nmkdir -p node_modules/left-pad && echo x > node_modules/left-pad/index.js\n');
  chmodSync(join(bin, 'npm'), 0o755);
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NPM_LOG: join(root, 'npm.log') };
  delete env.NPM_FAIL;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A job worktree with this lockfile (and package.json). */
function job(id: string, lock: string | null = LOCK, pkg = '{"name":"app"}'): string {
  const w = join(tree, '.hopper-scratch', id, 'tree');
  mkdirSync(w, { recursive: true });
  writeFileSync(join(w, 'package.json'), pkg);
  if (lock !== null) writeFileSync(join(w, 'package-lock.json'), lock);
  return w;
}

async function share(w: string, maxAgeHours = 24): Promise<string> {
  const { stdout } = await run('sh', ['-c', shareDepsCommand(tree, w, maxAgeHours)], { cwd: w, env });
  return depsOutcome(stdout) ?? `no outcome in: ${stdout}`;
}

const installs = (): string[] => (existsSync(env.NPM_LOG!) ? readFileSync(env.NPM_LOG!, 'utf8').trim().split('\n') : []);

describe('shared dependencies for job worktrees (issue #410)', () => {
  it('the first job installs for its lockfile; the next with that lockfile only links, and both see the same dependencies', async () => {
    const a = job('a');
    expect(await share(a)).toBe('installed');
    expect(installs()).toEqual([`${a} ci --prefer-offline --no-audit --no-fund`]);
    const b = job('b');
    expect(await share(b)).toBe('linked');
    expect(installs()).toHaveLength(1);
    expect(lstatSync(join(a, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(b, 'node_modules'))).toBe(readlinkSync(join(a, 'node_modules')));
    expect(readlinkSync(join(a, 'node_modules'))).toMatch(new RegExp(`^${tree}/\\.hopper-scratch/deps/[0-9a-f]{40}/node_modules$`));
    expect(readFileSync(join(b, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('x\n');
  });

  it('several jobs at once with one lockfile install it once', async () => {
    const jobs = ['c1', 'c2', 'c3', 'c4'].map((id) => job(id));
    const outcomes = await Promise.all(jobs.map((w) => share(w)));
    expect(outcomes.sort()).toEqual(['installed', 'linked', 'linked', 'linked']);
    expect(installs()).toHaveLength(1);
    expect(new Set(jobs.map((w) => readlinkSync(join(w, 'node_modules'))))).toHaveProperty('size', 1);
  });

  it('another lockfile gets dependencies of its own; the ones in use do not change', async () => {
    const a = job('a');
    await share(a);
    const b = job('b', LOCK.replace('"app"', '"app2"'));
    expect(await share(b)).toBe('installed');
    expect(readlinkSync(join(b, 'node_modules'))).not.toBe(readlinkSync(join(a, 'node_modules')));
    expect(existsSync(join(a, 'node_modules', 'left-pad'))).toBe(true);
  });

  it('no lockfile: nothing; a worktree that has node_modules (a run before): kept as it is', async () => {
    expect(await share(job('n', null))).toBe('none');
    const k = job('k');
    mkdirSync(join(k, 'node_modules'));
    expect(await share(k)).toBe('kept');
    expect(lstatSync(join(k, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(installs()).toEqual([]);
  });

  it('workspaces: an install of the job\'s own, never shared', async () => {
    const w = job('ws', LOCK, '{"name":"app","workspaces":["packages/*"]}');
    expect(await share(w)).toBe('own');
    expect(lstatSync(join(w, 'node_modules')).isDirectory()).toBe(true);
    expect(existsSync(join(tree, '.hopper-scratch', 'deps'))).toBe(false);
  });

  it('npm failing: failed, nothing linked or left half-made', async () => {
    env.NPM_FAIL = '1';
    const w = job('f');
    expect(await share(w)).toBe('failed');
    expect(existsSync(join(w, 'node_modules'))).toBe(false);
    delete env.NPM_FAIL;
    expect(await share(job('g'))).toBe('installed');
  });

  it('removes an entry no job worktree links to once unused for the scratch age; never one a worktree links to', async () => {
    const a = job('a');
    await share(a);
    const used = readlinkSync(join(a, 'node_modules')).replace(/\/node_modules$/, '');
    const stale = join(tree, '.hopper-scratch', 'deps', 'f'.repeat(40));
    mkdirSync(join(stale, 'node_modules'), { recursive: true });
    const old = Date.now() / 1000 - 3 * 3600;
    utimesSync(stale, old, old);
    utimesSync(used, old, old);
    await share(job('b', LOCK.replace('"app"', '"other"')), 1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(used)).toBe(true);
  });

  it('the command is one line any shell runs, its outcome never read from its own echo', () => {
    const command = shareDepsCommand('/w/', '/w/.hopper-scratch/j/w', 24);
    expect(command).not.toContain('\n');
    expect(command.startsWith("sh -c '")).toBe(true);
    expect(command.endsWith("'/w' '/w/.hopper-scratch/j/w' 1440")).toBe(true);
    expect(depsOutcome(`$ ${command}`)).toBeUndefined();
  });
});

describe('the reap after shared dependencies (issue #410)', () => {
  it('a job worktree linked to them is removed, never with --force, and they stay for the other jobs', async () => {
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
    const origin = join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    rmSync(tree, { recursive: true, force: true });
    git(root, 'clone', '-q', origin, tree);
    writeFileSync(join(tree, 'package.json'), '{"name":"app"}');
    writeFileSync(join(tree, 'package-lock.json'), LOCK);
    git(tree, 'add', '.');
    git(tree, 'commit', '-q', '-m', 'a');
    git(tree, 'push', '-q', 'origin', 'main');
    mkdirSync(join(tree, '.hopper-scratch', 'j1'), { recursive: true });
    writeFileSync(join(tree, '.hopper-scratch', '.gitignore'), '*\n');
    const w = join(tree, '.hopper-scratch', 'j1', 'tree');
    git(tree, 'worktree', 'add', '-q', '--detach', w, 'origin/main');
    expect(await share(w)).toBe('installed');
    const shared = readlinkSync(join(w, 'node_modules'));
    const { reapArgv, readReap } = await import('../../src/client/server.ts');
    const [file, ...args] = reapArgv('j1', join(tree, '.hopper-scratch', 'j1'));
    expect(readReap(execFileSync(file!, args, { encoding: 'utf8' }))).toEqual({ kept: [] });
    expect(existsSync(w)).toBe(false);
    expect(existsSync(join(shared, 'left-pad', 'index.js'))).toBe(true);
    expect(git(tree, 'worktree', 'list')).not.toContain(w);
  });
});
