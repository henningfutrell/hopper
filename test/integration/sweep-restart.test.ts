// The sweep at startup (issue #410): a hopper stopped mid-job and started again leaves nothing of that job
// running — here a real process that carries the job's id and outlived the hopper, found by the sweep's
// real survey of this machine and stopped by its real reap. A process of a job this hopper does not know
// is left alone.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionOutcome, Executor } from '../../src/domain/ports.ts';
import { localShell } from '../../src/executors/machine-shell.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const children: ChildProcess[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  cleanup?.();
});

const alive = (p: ChildProcess): boolean => p.exitCode === null && p.signalCode === null;

/** Not idempotent; each run leaves a detached process carrying the job's id. Its own cleanup reaps nothing: only the sweep can. */
function createLeaver(): Executor {
  return {
    name: 'leaver',
    idempotent: false,
    validate: () => null,
    run(ctx) {
      const p = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { ...process.env, HOPPER_JOB_ID: ctx.job.id } });
      children.push(p);
      ctx.saveState({ pid: p.pid });
      return new Promise<ExecutionOutcome>((resolve) => ctx.signal.addEventListener('abort', () => resolve({ kind: 'failed', error: 'aborted' }), { once: true }));
    },
    async cleanup() {},
    machineShell: (m) => (m.docker || m.client || m.ssh ? undefined : localShell()),
  };
}

describe.runIf(existsSync('/proc/self/environ'))('the sweep at startup (issue #410)', () => {
  it('a hopper stopped mid-job and started again: the job fails, and what it left running is stopped; a stranger\'s process is not', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const source = createManualSource();
    const leaver = createLeaver();
    const first = await startTestApp({ dbPath: db.dbPath, source, seams: { executors: [leaver] } });
    apps.push(first);
    const job = await first.pull({}, { executor: 'leaver' });
    await first.waitForStatus(job.id, 'running');
    await waitFor(() => children.length === 1);
    const left = children[0]!;
    const stranger = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { ...process.env, HOPPER_JOB_ID: 'not-this-hoppers-job' } });
    children.push(stranger);
    await first.stop();
    apps.splice(0);
    expect(alive(left)).toBe(true);

    const second = await startTestApp({ dbPath: db.dbPath, source, seams: { executors: [createLeaver()] } });
    apps.push(second);
    expect((await second.waitForStatus(job.id, 'failed')).error).toBe('interrupted by daemon restart');
    await waitFor(() => !alive(left), { timeoutMs: 15000, what: 'the job\'s leftover process stopped by the sweep' });
    expect(alive(stranger)).toBe(true);
  });
});
