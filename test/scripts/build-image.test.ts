// Issue #409: every build knows its repository, branch and commit, however it was built. The image bakes
// them in at build time (build arguments → /app/install.json and OCI labels); scripts/build-image.sh is the
// local build that passes them from the checkout, the published image's workflow passes them from GitHub, and
// scripts/write-install-json.ts writes the file for both the image and scripts/install.sh. The build engine is
// a stub here that records its arguments: no image is built.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readInstallInfo } from '../../src/update/install.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const ID = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } }).trim();

/** A checkout holding the script, with `origin`, one commit, and a stub engine that writes its arguments one per line. */
function checkout(origin: string) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-build-image-'));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts', 'build-image.sh'), join(repo, 'scripts', 'build-image.sh'));
  writeFileSync(join(repo, 'Dockerfile'), 'FROM scratch\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  const engine = join(dir, 'engine');
  const argsFile = join(dir, 'args');
  writeFileSync(engine, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
  chmodSync(engine, 0o755);
  const run = (env: Record<string, string> = {}, ...args: string[]) => {
    const r = spawnSync('bash', [join(repo, 'scripts', 'build-image.sh'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, HOPPER_BUILDER: engine, ...env } });
    return { ...r, args: r.status === 0 ? readFileSync(argsFile, 'utf8').split('\n').filter(Boolean) : [] };
  };
  return { repo, run, head: git(repo, 'rev-parse', 'HEAD') };
}

describe('scripts/build-image.sh, the local image build', () => {
  it('builds the checkout as localhost/hopper with its repository, branch and commit as build arguments', () => {
    const c = checkout('https://example.invalid/o/hopper.git');
    const r = c.run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.args[0]).toBe('build');
    expect(r.args).toEqual(expect.arrayContaining([
      '--build-arg', 'HOPPER_REPO=https://example.invalid/o/hopper.git', 'HOPPER_BRANCH=stable', `HOPPER_COMMIT=${c.head}`, '-t', 'localhost/hopper',
    ]));
    expect(r.args.at(-1)).toBe(c.repo);
  });

  it('names a GitHub repository by https: the image holds no ssh key, and a public repository needs none', () => {
    const r = checkout('git@github.com:o/hopper.git').run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.args).toContain('HOPPER_REPO=https://github.com/o/hopper.git');
  });

  it('tags HOPPER_IMAGE, the image compose.yaml runs, and passes further arguments to the engine', () => {
    const r = checkout('https://example.invalid/o/hopper.git').run({ HOPPER_IMAGE: 'localhost/hopper:dev' }, '--build-arg', 'INSTALL_CLAUDE=false');
    expect(r.status, r.stderr).toBe(0);
    expect(r.args).toEqual(expect.arrayContaining(['-t', 'localhost/hopper:dev', 'INSTALL_CLAUDE=false']));
  });

  it('warns when the checkout has changes its commit does not hold', () => {
    const c = checkout('https://example.invalid/o/hopper.git');
    writeFileSync(join(c.repo, 'Dockerfile'), 'FROM scratch\n# changed\n');
    const r = c.run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/uncommitted changes/);
  });

  it('refuses a checkout with no origin: the build would not know its repository', () => {
    const c = checkout('https://example.invalid/o/hopper.git');
    git(c.repo, 'remote', 'remove', 'origin');
    const r = c.run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/origin/);
  });
});

describe('scripts/write-install-json.ts', () => {
  const write = (...args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-install-json-'));
    dirs.push(dir);
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'write-install-json.ts'), join(dir, 'install.json'), ...args], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return { dir, json: JSON.parse(readFileSync(join(dir, 'install.json'), 'utf8')) as Record<string, string> };
  };

  it('writes what the build was made from and when, read back as a whole install', () => {
    const commit = 'a'.repeat(40);
    const { dir, json } = write('image', 'https://example.invalid/o/hopper.git', 'main', commit);
    expect(json).toMatchObject({ kind: 'image', repo: 'https://example.invalid/o/hopper.git', branch: 'main', commit });
    expect(new Date(json.installedAt!).getTime()).not.toBeNaN();
    expect(readInstallInfo(dir)).toMatchObject({ ok: true, info: { kind: 'image', commit } });
  });

  it('leaves out a field it was given empty, so the build says what it lacks instead of a wrong value', () => {
    const { dir, json } = write('image', 'https://example.invalid/o/hopper.git', 'main', '');
    expect(json).not.toHaveProperty('commit');
    const read = readInstallInfo(dir);
    expect(read.ok).toBe(false);
    expect(read.known).toMatchObject({ kind: 'image', repo: 'https://example.invalid/o/hopper.git', branch: 'main' });
  });
});

describe('every build path records what it was built from', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  it('the Dockerfile takes the repository, branch and commit as build arguments and writes them into the image', () => {
    for (const arg of ['HOPPER_REPO', 'HOPPER_BRANCH', 'HOPPER_COMMIT']) expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}`, 'm'));
    expect(dockerfile).toMatch(/node scripts\/write-install-json\.ts \/app\/install\.json image "\$HOPPER_REPO" "\$HOPPER_BRANCH" "\$HOPPER_COMMIT"/);
    expect(dockerfile).toMatch(/org\.opencontainers\.image\.revision=\$HOPPER_COMMIT/);
    expect(dockerfile).toMatch(/org\.opencontainers\.image\.source=\$HOPPER_REPO/);
  });

  it('the published image is built with GitHub\'s repository, branch and commit', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'image.yml'), 'utf8');
    expect(workflow).toContain('HOPPER_REPO=${{ github.server_url }}/${{ github.repository }}.git');
    expect(workflow).toContain('HOPPER_BRANCH=${{ github.ref_name }}');
    expect(workflow).toContain('HOPPER_COMMIT=${{ github.sha }}');
  });

  it('the published image follows dev, beta and stable: a tag for each branch, and latest is stable (issue #423)', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'image.yml'), 'utf8');
    expect(workflow).toMatch(/branches: \[dev, beta, stable\]/);
    expect(workflow).toContain("type=raw,value=latest,enable=${{ github.ref_name == 'stable' }}");
    expect(workflow).toContain('type=ref,event=branch');
    expect(workflow).not.toMatch(/\bmain\b/);
  });

  it('every build defaults to the stable branch (issue #423)', () => {
    expect(dockerfile).toMatch(/^ARG HOPPER_BRANCH=stable$/m);
    expect(readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8')).toContain('BRANCH="${HOPPER_UPDATE_BRANCH:-stable}"');
  });

  it('scripts/install.sh writes install.json with the same script', () => {
    expect(readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8')).toMatch(/scripts\/write-install-json\.ts" "\$target\/install\.json" install /);
  });

  it('the docs build a local image with the script, not a bare build that knows no commit', () => {
    for (const file of ['docs/deploy.md', 'compose.yaml', '.env.example']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text, file).toContain('scripts/build-image.sh');
      expect(text, file).not.toMatch(/podman build -t localhost\/hopper \./);
    }
  });
});
