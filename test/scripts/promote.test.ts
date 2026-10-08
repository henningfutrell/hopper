// scripts/promote.sh (issue #423): a promotion moves a commit up one update channel, dev → beta → stable,
// as a fast-forward of the steadier branch to a commit the branch below already has, and only once that
// commit's image built there. The repository is a local bare one; gh is a stand-in on PATH that answers
// the image run's conclusion. Nothing leaves this process tree.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'promote.sh');

let dir: string;
let bin: string;
let origin: string;
let work: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('/usr/bin/git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const head = (branch: string): string => git(origin, 'rev-parse', branch);

/** A commit on dev, pushed. */
function onDev(file: string): string {
  git(work, 'checkout', '-q', 'dev');
  writeFileSync(join(work, file), file);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', file);
  git(work, 'push', '-q', 'origin', 'dev');
  return git(work, 'rev-parse', 'HEAD');
}

/** gh answers this conclusion for every image run it is asked about, and logs the question. */
function imageRun(conclusion: string): void {
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "gh $*" >> "${dir}/gh.log"\necho "${conclusion}"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
}

function promote(...args: string[]) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd: work, encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-promote-'));
  bin = join(dir, 'bin');
  origin = join(dir, 'origin.git');
  work = join(dir, 'work');
  mkdirSync(bin);
  execFileSync('/usr/bin/git', ['init', '-q', '--bare', '-b', 'dev', origin]);
  git(dir, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'dev');
  const first = onDev('first');
  git(work, 'push', '-q', 'origin', `${first}:refs/heads/beta`, `${first}:refs/heads/stable`);
  imageRun('success');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('promote.sh', () => {
  it('promotes the head of dev to beta, then beta to stable, once each image built', () => {
    const c = onDev('second');
    const toBeta = promote('beta');
    expect(toBeta.status, toBeta.stderr).toBe(0);
    expect(head('beta')).toBe(c);
    expect(head('stable')).not.toBe(c);
    const toStable = promote('stable');
    expect(toStable.status, toStable.stderr).toBe(0);
    expect(head('stable')).toBe(c);
    const asked = readFileSync(join(dir, 'gh.log'), 'utf8');
    expect(asked).toContain(`--branch dev --commit ${c}`);
    expect(asked).toContain(`--branch beta --commit ${c}`);
  });

  it('promotes a named commit of the branch below, not only its head', () => {
    const c = onDev('second');
    onDev('third');
    expect(promote('beta', c).status).toBe(0);
    expect(head('beta')).toBe(c);
  });

  it('never skips a step: stable takes only what beta has', () => {
    const c = onDev('second');
    const r = promote('stable', c);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not on beta');
    expect(head('stable')).not.toBe(c);
  });

  it('refuses a commit whose image did not build on the branch below', () => {
    const c = onDev('second');
    imageRun('failure');
    const r = promote('beta');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('image');
    expect(head('beta')).not.toBe(c);
  });

  it('refuses a move that is not a fast-forward: the steadier branch has a commit the one below lacks', () => {
    git(work, 'checkout', '-q', '-b', 'side', head('beta'));
    writeFileSync(join(work, 'side'), 'side');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'side');
    git(work, 'push', '-q', 'origin', 'side:beta');
    const before = head('beta');
    onDev('second');
    const r = promote('beta');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('fast-forward');
    expect(head('beta')).toBe(before);
  });

  it('takes only beta or stable', () => {
    for (const to of ['dev', 'main', 'release']) expect(promote(to).status).not.toBe(0);
  });
});
