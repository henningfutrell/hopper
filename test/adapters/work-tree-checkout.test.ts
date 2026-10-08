// Issue #361: the hopper puts the job's repository in the machine's work tree itself: it fetches a
// checkout the work tree already holds (the work tree itself, or a directory up to three levels down
// named after the repository), and clones one when there is none. Run here against real git, with a
// local repository standing in for GitHub.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKOUT_SCRIPT, checkoutCommand } from '../../src/executors/work-tree.ts';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

describe('the checkout step in the work tree', () => {
  let dir: string;
  let origin: string;
  let tree: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jh-checkout-'));
    // The "remote": <dir>/remote/acme/app.git, so its URL ends in acme/app.git as GitHub's does.
    origin = join(dir, 'remote', 'acme', 'app.git');
    mkdirSync(origin, { recursive: true });
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    const seed = join(dir, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
    git(seed, 'push', '-q', origin, 'main');
    tree = join(dir, 'tree');
    mkdirSync(tree);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const checkout = (env: Record<string, string> = {}) =>
    execFileSync('sh', ['-c', CHECKOUT_SCRIPT, 'hopper-checkout', 'acme/app', origin], { cwd: tree, encoding: 'utf8', env: { ...process.env, ...env } });

  it('clones the repository into a directory named after it when the work tree holds no checkout', () => {
    checkout();
    expect(git(join(tree, 'app'), 'log', '--format=%s')).toBe('first');
  });

  it('fetches a checkout that is already in the work tree, a few levels down, and clones nothing', () => {
    const nested = join(tree, 'workspace', 'app');
    mkdirSync(join(tree, 'workspace'));
    git(join(tree, 'workspace'), 'clone', '-q', origin, 'app');
    git(nested, 'remote', 'set-url', 'origin', origin);
    checkout();
    expect(existsSync(join(tree, 'app'))).toBe(false);
    expect(git(nested, 'rev-parse', '--abbrev-ref', 'origin/main')).toBe('origin/main');
  });

  it('fetches when the work tree is itself the checkout', () => {
    rmSync(tree, { recursive: true });
    git(dir, 'clone', '-q', origin, 'tree');
    checkout();
    expect(existsSync(join(tree, 'app'))).toBe(false);
  });

  it('fails, saying so, when the repository cannot be cloned', () => {
    expect(() => execFileSync('sh', ['-c', CHECKOUT_SCRIPT, 'hopper-checkout', 'acme/gone', join(dir, 'remote', 'acme', 'gone.git')], { cwd: tree, stdio: 'pipe' })).toThrow();
  });

  it('the command names the repository and its URL as arguments, and the token only as a variable', () => {
    const c = checkoutCommand('acme/app');
    expect(c).toMatch(/^sh -c '.*' hopper-checkout 'acme\/app' 'https:\/\/github\.com\/acme\/app\.git'$/s);
    expect(c).toContain('$GH_TOKEN');
  });
});
