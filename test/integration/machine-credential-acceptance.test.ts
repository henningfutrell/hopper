// Machine credential acceptance (issue #1459): an admin accepts that a machine whose job user holds infra credentials
// can take jobs anyway, despite the blast-radius risk. The acceptance is persisted; the decider and lane listing treat
// an accepted machine as ready. Real database, seeded infra credentials on the machine.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  //
});

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({
    dbPath: db.dbPath,
    seams: {
      machineProbe: async () => ({ online: true, infraCredentials: ['.kube', '.config/gh/hosts.yml'] }),
    },
  });
  return { a: t, token: await t.login() };
}

const jobs = async (a: TestApp): Promise<Job[]> => (await a.api('GET', '/api/jobs')).body.queue.waiting;
const machines = async (a: TestApp) => (await a.api('GET', '/api/machines')).body.machines;

describe('machine credential acceptance', () => {
  it('a machine with infra credentials is held and takes no jobs', async () => {
    const { a } = await start();
    // The machine has credentials
    const ms = await machines(a);
    expect(ms.length).toBeGreaterThan(0);
    expect(ms[0]?.infraCredentials).toEqual(['.kube', '.config/gh/hosts.yml']);
    
    // Queue a job
    await a.pull({ op: 'echo' });
    await waitFor(() => jobs(a).then((j) => j.length === 1 && j[0]?.status === 'held'));
    
    const j = await jobs(a);
    expect(j.length).toBeGreaterThan(0);
    expect(j[0]?.status).toBe('held');
    expect(j[0]?.holdReason).toContain('not ready');
    expect(j[0]?.holdReason).toContain('.kube');
  });

  it('after accepting the credentials, the machine takes jobs', async () => {
    const { a, token } = await start();
    const ms = await machines(a);
    expect(ms.length).toBeGreaterThan(0);
    const machineId = ms[0]!.id;
    
    // Accept the credentials
    await a.ui('/ui/api/machines/' + machineId + '/credentials/accept', {
      machineKey: machineId,
      credentials: ['.kube', '.config/gh/hosts.yml'],
    }, { token });
    
    // Queue a job
    await a.pull({ op: 'echo' });
    await waitFor(() => jobs(a).then((j) => j.length === 1 && j[0]?.status === 'claimed'));
    
    const j = await jobs(a);
    expect(j.length).toBeGreaterThan(0);
    expect(j[0]?.status).toBe('claimed');
  });

  it('after revoking acceptance, the machine is held again', async () => {
    const { a, token } = await start();
    const ms = await machines(a);
    expect(ms.length).toBeGreaterThan(0);
    const machineId = ms[0]!.id;
    
    // Accept the credentials
    await a.ui('/ui/api/machines/' + machineId + '/credentials/accept', {
      machineKey: machineId,
      credentials: ['.kube', '.config/gh/hosts.yml'],
    }, { token });
    
    // Queue and claim a job
    const job1 = await a.pull({ op: 'echo' });
    await a.waitForStatus(job1.id, 'finished');
    
    // Revoke the acceptance
    await a.ui('/ui/api/machines/' + machineId + '/credentials/revoke', {
      machineKey: machineId,
    }, { token });
    
    // Queue another job
    const job2 = await a.pull({ op: 'echo' });
    await waitFor(() => jobs(a).then((j) => j.some((jj) => jj.id === job2.id && jj.status === 'held')));
    
    const j = await a.job(job2.id);
    expect(j.status).toBe('held');
    expect(j.holdReason).toContain('not ready');
  });

  it('acceptance survives restart', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    
    // Start the app, accept the machine
    t = await startTestApp({
      dbPath: db.dbPath,
      seams: {
        machineProbe: async () => ({ online: true, infraCredentials: ['.kube'] }),
      },
    });
    const token = await t.login();
    const ms = await machines(t);
    expect(ms.length).toBeGreaterThan(0);
    const machineId = ms[0]!.id;
    
    await t.ui('/ui/api/machines/' + machineId + '/credentials/accept', {
      machineKey: machineId,
      credentials: ['.kube'],
    }, { token });
    
    // Stop and restart
    await t.stop();
    t = await startTestApp({
      dbPath: db.dbPath,
      seams: {
        machineProbe: async () => ({ online: true, infraCredentials: ['.kube'] }),
      },
    });
    
    // The acceptance persisted
    const ms2 = await machines(t);
    expect(ms2.length).toBeGreaterThan(0);
    expect(ms2[0]?.credentialAcceptance).toBeDefined();
    expect(ms2[0]?.credentialAcceptance?.credentials).toEqual(['.kube']);
    expect(ms2[0]?.credentialAcceptance?.revokedAt).toBeUndefined();
    
    // The machine takes jobs
    const job = await t.pull({ op: 'echo' });
    await t.waitForStatus(job.id, 'claimed');
    
    const j = await t.job(job.id);
    expect(j.status).toBe('claimed');
  });
});
