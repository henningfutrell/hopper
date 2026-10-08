// The reap and the survey through a machine's own connection (issue #410): this machine's shell, and a
// client target's `/reap` and `/survey`, signed like its herdr calls — never typed into a pane.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintToken } from '../../src/client/signature.ts';
import { clientScript } from '../../src/executors/client.ts';
import { clientShell, localShell } from '../../src/executors/machine-shell.ts';
import { startTestClient, type TestClient } from '../support/client.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const JOB = 'job-410-shell';

let root: string;
let work: string;
let scratch: string;
let client: TestClient | undefined;
const children: ChildProcess[] = [];

const alive = (p: ChildProcess): boolean => p.exitCode === null && p.signalCode === null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jh-shell-'));
  work = join(root, 'work');
  scratch = join(work, '.hopper-scratch', JOB);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'tmp.txt'), 'x');
});

afterEach(async () => {
  for (const c of children.splice(0)) if (alive(c)) c.kill('SIGKILL');
  await client?.stop();
  client = undefined;
  rmSync(root, { recursive: true, force: true });
});

function straggler(): ChildProcess {
  const p = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { ...process.env, HOPPER_JOB_ID: JOB } });
  children.push(p);
  return p;
}

const exited = (p: ChildProcess): Promise<void> => new Promise((r) => { if (!alive(p)) r(); else p.once('exit', () => r()); });

describe.each([
  ['this machine', async () => localShell()],
  ['a client target', async () => {
    const token = mintToken();
    client = await startTestClient({ token: () => token, herdrBin: HERDR, session: 'hopper' });
    return clientShell(client.transport(token));
  }],
])('the reap and the survey on %s (issue #410)', (_where, shellOf) => {
  it.runIf(existsSync('/proc/self/environ'))('the survey names the job by its process and its scratch dir; the reap stops it and removes the dir', async () => {
    const shell = await shellOf();
    const p = straggler();
    const found = await shell.survey([work]);
    expect(found.processes).toContain(JOB);
    expect(found.scratch).toEqual([{ jobId: JOB, path: scratch, ageMs: expect.any(Number) }]);
    expect(await shell.reap(JOB, scratch)).toEqual({ kept: [] });
    await exited(p);
    expect(existsSync(scratch)).toBe(false);
    expect((await shell.survey([work])).processes).not.toContain(JOB);
  });

  it('a reap with no scratch dir removes none', async () => {
    const shell = await shellOf();
    expect(await shell.reap(JOB)).toEqual({ kept: [] });
    expect(existsSync(join(scratch, 'tmp.txt'))).toBe(true);
  });
});

describe('a client target takes only a job id, its own scratch dir, or work trees (issue #410)', () => {
  it('refuses anything else before running a script', async () => {
    const token = mintToken();
    client = await startTestClient({ token: () => token, herdrBin: HERDR, session: 'hopper' });
    const t = client.transport(token);
    await expect(clientScript(t, '/reap', { jobId: JOB, scratch: work })).rejects.toThrow(/400 .*scratch must be the job's own scratch dir/);
    await expect(clientScript(t, '/reap', { jobId: '../x' })).rejects.toThrow(/400 .*jobId must be a job id/);
    await expect(clientScript(t, '/survey', { roots: 'relative' })).rejects.toThrow(/400 .*roots must be/);
    expect(existsSync(join(scratch, 'tmp.txt'))).toBe(true);
  });

  it('refuses a call it cannot verify as the hopper\'s', async () => {
    const token = mintToken();
    client = await startTestClient({ token: () => token, herdrBin: HERDR, session: 'hopper' });
    await expect(clientShell(client.transport(mintToken())).reap(JOB, scratch)).rejects.toThrow(/refused the hopper \(401\)/);
    expect(existsSync(scratch)).toBe(true);
  });
});
