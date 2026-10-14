// scripts/promote.sh (issue #423): a promotion moves a commit up one update channel, dev → beta → canary → stable
// (the canary: issue #1073 part 5),
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
  return promoteIn(work, ...args);
}

function promoteIn(cwd: string, ...args: string[]) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-promote-'));
  bin = join(dir, 'bin');
  origin = join(dir, 'origin.git');
  work = join(dir, 'work');
  mkdirSync(bin);
  execFileSync('/usr/bin/git', ['init', '-q', '--bare', '-b', 'dev', origin]);
  git(dir, 'clone', '-q', origin, work);
  writeFileSync(join(work, 'first'), 'first');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'push', '-q', 'origin', 'HEAD:dev');
  const first = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', `${first}:refs/heads/beta`, `${first}:refs/heads/stable`);
  imageRun('success');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('promote.sh', () => {
  it('promotes the head of dev to beta, then beta to canary (made the first time), then canary to stable, once each image built', () => {
    const c = onDev('second');
    const toBeta = promote('beta');
    expect(toBeta.status, toBeta.stderr).toBe(0);
    expect(head('beta')).toBe(c);
    expect(head('stable')).not.toBe(c);
    const toCanary = promote('canary');
    expect(toCanary.status, toCanary.stderr).toBe(0);
    expect(head('canary')).toBe(c);
    expect(head('stable')).not.toBe(c);
    const toStable = promote('stable');
    expect(toStable.status, toStable.stderr).toBe(0);
    expect(head('stable')).toBe(c);
    const asked = readFileSync(join(dir, 'gh.log'), 'utf8');
    expect(asked).toContain(`--branch dev --commit ${c}`);
    expect(asked).toContain(`--branch beta --commit ${c}`);
    expect(asked).toContain(`--branch canary --commit ${c}`);
  });

  it('stable takes only what canary has; with no canary branch yet, it says so', () => {
    const c = onDev('second');
    expect(promote('beta').status).toBe(0);
    const none = promote('stable');
    expect(none.status).not.toBe(0);
    expect(none.stderr).toContain('there is no canary branch yet');
    expect(promote('canary').status).toBe(0);
    const d = onDev('third');
    expect(promote('beta').status).toBe(0);
    const r = promote('stable', d);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not on canary');
    expect(head('stable')).not.toBe(c);
  });

  it('promotes a named commit of the branch below, not only its head', () => {
    const c = onDev('second');
    onDev('third');
    expect(promote('beta', c).status).toBe(0);
    expect(head('beta')).toBe(c);
  });

  it('never skips a step: canary takes only what beta has', () => {
    const c = onDev('second');
    const r = promote('canary', c);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not on beta');
    expect(() => head('canary')).toThrow();
  });

  it('says a commit only dev has is not on beta, also from a clone that has not fetched it yet', () => {
    const stale = join(dir, 'stale');
    git(dir, 'clone', '-q', origin, stale);
    const c = onDev('second');
    const r = promoteIn(stale, 'canary', c);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not on beta');
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

  it('refuses a commit with What\'s new fragments left: they go into WHATS-NEW.md on dev first (issue #824)', () => {
    mkdirSync(join(work, 'whats-new'), { recursive: true });
    writeFileSync(join(work, 'whats-new', 'README.md'), 'how to');
    const readme = onDev('whats-new/12.md');
    const r = promote('beta');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("What's new fragments not in WHATS-NEW.md yet (12.md)");
    expect(r.stderr).toContain('node scripts/whats-new.ts assemble');
    expect(head('beta')).not.toBe(readme);
    git(work, 'rm', '-q', 'whats-new/12.md');
    git(work, 'commit', '-q', '-m', 'assemble');
    git(work, 'push', '-q', 'origin', 'dev');
    const ok = promote('beta');
    expect(ok.status, ok.stderr).toBe(0);
  });

  it('takes only beta, canary or stable', () => {
    for (const to of ['dev', 'main', 'release']) expect(promote(to).status).not.toBe(0);
  });
});
