// The credential check (issues #1459, #1467): a machine whose job user holds infra credentials takes jobs with a warning by
// default. Strict mode holds it until an admin uses it anyway; an admin's stop holds it whatever strict mode says. The
// Machines answer carries `credentialHeld` from the decider's own rule, and an acknowledgement survives a restart. Real
// database; this machine's job user holds the credentials, made in the test's throwaway HOME (test/support/isolate.ts).
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const CREDS = ['.kube', '.terraform.d'];

beforeEach(() => { for (const c of CREDS) mkdirSync(join(homedir(), c), { recursive: true }); });

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
  for (const c of CREDS) rmSync(join(homedir(), c), { recursive: true, force: true });
});

async function start(dbPath?: string): Promise<{ a: TestApp; token: string; id: string }> {
  if (!dbPath) {
    const db = tempDbPath();
    cleanup = db.cleanup;
    dbPath = db.dbPath;
  }
  t = await startTestApp({ dbPath });
  const token = await t.login();
  const ms = await machines(t);
  expect(ms[0]?.infraCredentials).toEqual(CREDS);
  return { a: t, token, id: ms[0]!.id };
}

type MachineRow = { id: string; infraCredentials?: string[]; credentialHeld?: boolean; credentialAcceptance?: { credentials: string[]; revokedAt?: string } };
const machines = async (a: TestApp): Promise<MachineRow[]> => (await a.api('GET', '/api/machines')).body.machines;
const strict = (a: TestApp, token: string, on: boolean) => a.ui('/ui/api/credential-check', { strict: on }, { token });
const accept = (a: TestApp, token: string, id: string) => a.ui(`/ui/api/machines/${id}/credentials/accept`, { machineKey: id, credentials: CREDS }, { token });
const stop = (a: TestApp, token: string, id: string) => a.ui(`/ui/api/machines/${id}/credentials/revoke`, { machineKey: id }, { token });

describe('the credential check', () => {
  it('by default a machine with credentials takes jobs, and the Machines answer says it is not held', async () => {
    const { a } = await start();
    expect((await a.api('GET', '/api/credential-check')).body).toEqual({ strict: false });
    expect((await machines(a))[0]?.credentialHeld).toBeUndefined();
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
  });

  it('strict mode on: the same machine is held; Use anyway lets it take jobs', async () => {
    const { a, token, id } = await start();
    expect((await strict(a, token, true)).body).toEqual({ strict: true });
    expect((await machines(a))[0]?.credentialHeld).toBe(true);
    const job = await a.pull({ op: 'echo' });
    await waitFor(() => a.job(job.id).then((j) => j.status === 'held'));
    const held = await a.job(job.id);
    expect(held.holdReason).toContain('not ready');
    expect(held.holdReason).toContain('.kube');

    await accept(a, token, id);
    expect((await machines(a))[0]?.credentialHeld).toBeUndefined();
    await a.waitForStatus(job.id, 'finished');
  });

  it('an admin\'s stop holds the machine with strict mode off; Use anyway clears it', async () => {
    const { a, token, id } = await start();
    await stop(a, token, id);
    const [m] = await machines(a);
    expect(m?.credentialHeld).toBe(true);
    expect(m?.credentialAcceptance?.revokedAt).toBeDefined();
    const job = await a.pull({ op: 'echo' });
    await waitFor(() => a.job(job.id).then((j) => j.status === 'held'));

    await accept(a, token, id);
    await a.waitForStatus(job.id, 'finished');
  });

  it('an acknowledgement survives a restart, and the machine takes jobs in strict mode', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const first = await start(db.dbPath);
    await strict(first.a, first.token, true);
    await accept(first.a, first.token, first.id);
    await first.a.stop();

    const { a } = await start(db.dbPath);
    const [m] = await machines(a);
    expect(m?.credentialAcceptance?.credentials).toEqual(CREDS);
    expect(m?.credentialAcceptance?.revokedAt).toBeUndefined();
    expect(m?.credentialHeld).toBeUndefined();
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
  });
});
