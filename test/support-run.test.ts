// A test run leaves nothing behind (issue #401): its temp dirs live under one run root, every
// process it started carries the run's marker, and what a dead run left (its run root, its
// containers) is swept by the next run. The sweep logic (test/support/sweep.ts) against a real
// temp dir and real child processes; docker only through its seam.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gone, killMarked, sweepContainers, sweepRunRoots, type Docker } from './support/sweep.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jh-sweep-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const DEAD = 999_999_999; // above any pid_max: never alive

describe('the stale sweep of run roots', () => {
  it('removes a run root whose pid is dead, keeps one whose pid is alive, and leaves every other name alone', () => {
    for (const name of [`jh-run-${DEAD}-abc`, `jh-run-${process.pid}-def`, 'jh-test-home-xyz', 'jh-run-notapid-x']) mkdirSync(join(dir, name));
    expect(sweepRunRoots(dir)).toEqual([join(dir, `jh-run-${DEAD}-abc`)]);
    expect(existsSync(join(dir, `jh-run-${DEAD}-abc`))).toBe(false);
    for (const name of [`jh-run-${process.pid}-def`, 'jh-test-home-xyz', 'jh-run-notapid-x']) expect(existsSync(join(dir, name))).toBe(true);
  });

  it('asks the injected liveness check', () => {
    mkdirSync(join(dir, 'jh-run-42-a'));
    mkdirSync(join(dir, 'jh-run-43-b'));
    expect(sweepRunRoots(dir, (pid) => pid === 43)).toEqual([join(dir, 'jh-run-42-a')]);
  });

  it('is quiet when the dir is missing', () => {
    expect(sweepRunRoots(join(dir, 'none'))).toEqual([]);
  });
});

describe('killing the processes a run started', () => {
  it.runIf(existsSync('/proc/self/environ'))('kills every process carrying the run marker, and no other', async () => {
    const marked = spawn('sleep', ['60'], { env: { ...process.env, HOPPER_TEST_RUN: 'sweep-test-run' }, stdio: 'ignore' });
    const other = spawn('sleep', ['60'], { env: { ...process.env, HOPPER_TEST_RUN: 'another-run' }, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 100)); // exec'd: /proc/<pid>/environ is sleep's
      const killed = await killMarked('sweep-test-run', { graceMs: 2000 });
      expect(killed).toEqual([marked.pid]);
      expect(gone(marked.pid!)).toBe(true);
      expect(gone(other.pid!)).toBe(false);
    } finally {
      marked.kill('SIGKILL');
      other.kill('SIGKILL');
    }
  });

  it('kills one that ignores SIGTERM after the grace', async () => {
    const stubborn = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 0.05; done'], { env: { ...process.env, HOPPER_TEST_RUN: 'sweep-stubborn' }, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(await killMarked('sweep-stubborn', { graceMs: 200 })).toContain(stubborn.pid); // and its sleep children
      expect(gone(stubborn.pid!)).toBe(true);
    } finally {
      stubborn.kill('SIGKILL');
    }
  });

  it('never kills the calling process, and is quiet without /proc', async () => {
    expect(await killMarked(String(process.env.HOPPER_TEST_RUN ?? 'x'), { self: process.pid, graceMs: 100, proc: join(dir, 'no-proc') })).toEqual([]);
  });
});

describe('the stale sweep of containers', () => {
  const fake = (names: string[], labeled: { id: string; pid: string }[]): Docker & { removed: string[] } => {
    const removed: string[] = [];
    return { removed, names: () => names, labeled: () => labeled, remove: (ids) => { removed.push(...ids); } };
  };

  it('removes the jh-<kind>-<pid> containers and the labelled ones whose pid is dead, never a live pid\'s or another name', () => {
    const d = fake(
      ['jh-it-sshd-42', 'jh-test-target-43', 'jh-script-proxy-x', 'hopper-hopper-1', 'jh-test-proxy-abc123-42', 'i78-pg'],
      [{ id: 'pg-dead', pid: '42' }, { id: 'pg-live', pid: '43' }, { id: 'pg-bad', pid: 'nope' }],
    );
    expect(sweepContainers(d, (pid) => pid === 43)).toEqual(['jh-it-sshd-42', 'jh-test-proxy-abc123-42', 'pg-dead']);
    expect(d.removed).toEqual(['jh-it-sshd-42', 'jh-test-proxy-abc123-42', 'pg-dead']);
  });

  it('removes nothing when nothing is stale', () => {
    const d = fake(['jh-it-sshd-43'], []);
    expect(sweepContainers(d, () => true)).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

describe('the run root (test/support/run.ts, vitest globalSetup)', () => {
  it('is every worker\'s tmpdir, and the worker carries the run marker', () => {
    expect(tmpdir()).toMatch(/\/jh-run-\d+-[^/]+$/);
    expect(process.env.HOPPER_TEST_RUN).toMatch(/.+/);
    expect(process.env.HOME?.startsWith(`${tmpdir()}/jh-test-home-`)).toBe(process.env.HOPPER_REAL_HERDR !== '1');
  });
});
