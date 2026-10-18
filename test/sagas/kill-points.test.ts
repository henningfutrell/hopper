// Kill points (issue #1954, design.md "The crash harness"): a named place where a test's crash harness ends the hopper's
// process with SIGKILL. Armed only in a test run (HOPPER_TEST_RUN) that names the point (HOPPER_TEST_KILL_POINT); a
// process with neither, as every deploy is, passes each point and goes on.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { killPointsOf } from '../../src/sagas/kill-points.ts';

const KILL_POINTS = new URL('../../src/sagas/kill-points.ts', import.meta.url).pathname;

/** A process that passes the kill points `names` in order, then prints `went on`. */
const passes = (names: string[], env: Record<string, string | undefined>) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  const { killPoint } = await import(${JSON.stringify(KILL_POINTS)});
  for (const name of ${JSON.stringify(names)}) killPoint(name);
  console.log('went on');
`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 20_000 });

describe('kill points', () => {
  it('end the process with SIGKILL at the point named, and say which', () => {
    const r = passes(['saga:k:a:before-do', 'saga:k:a:after-do', 'saga:k:b:before-do'], { HOPPER_TEST_RUN: 'run', HOPPER_TEST_KILL_POINT: 'saga:k:a:after-do' });
    expect(r.signal).toBe('SIGKILL');
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('hopper: kill point saga:k:a:after-do');
  });

  it('end it at the nth time the point is passed, when the name says #n', () => {
    const r = passes(['saga:k:a:before-do', 'saga:k:a:before-do', 'saga:k:a:before-do'], { HOPPER_TEST_RUN: 'run', HOPPER_TEST_KILL_POINT: 'saga:k:a:before-do#2' });
    expect(r.signal).toBe('SIGKILL');
    const once = passes(['saga:k:a:before-do'], { HOPPER_TEST_RUN: 'run', HOPPER_TEST_KILL_POINT: 'saga:k:a:before-do#2' });
    expect([once.status, once.stdout]).toEqual([0, 'went on\n']);
  });

  it('are off outside a test run, even when a point is named', () => {
    const r = passes(['saga:k:a:after-do'], { HOPPER_TEST_KILL_POINT: 'saga:k:a:after-do' });
    expect([r.status, r.signal, r.stdout]).toEqual([0, null, 'went on\n']);
  });

  it('are off in a test run that names none', () => {
    const r = passes(['saga:k:a:after-do'], { HOPPER_TEST_RUN: 'run' });
    expect([r.status, r.stdout]).toEqual([0, 'went on\n']);
  });

  it('of a saga kind: before and after each step\'s do, and before and after each compensation', () => {
    const noop = async () => {};
    expect(killPointsOf({ kind: 'k', steps: [{ name: 'a', do: noop, compensate: noop }, { name: 'b', do: noop }] })).toEqual([
      'saga:k:a:before-do', 'saga:k:a:after-do', 'saga:k:a:before-compensate', 'saga:k:a:after-compensate',
      'saga:k:b:before-do', 'saga:k:b:after-do',
    ]);
  });
});
