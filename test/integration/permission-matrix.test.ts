// Issue #559, the permission matrix: GET /api/access names who stands on the asking side of a check beside the
// templates — each machine that joined as a box of a template, and each live job on such a machine, with its
// template — so Settings → Access can show what each may do on each asset. The daemon, store, HTTP edge and a joined
// client are real; OpenFGA is a double at the AuthorizationServer seam.
//
// Feature: the permission matrix's rows
//   Scenario: a box of a template and a live job on it are rows
//     Given a box joined as an instance of the template kube, and a machine of no template
//     And a job running on the box
//     When the instance admin reads GET /api/access
//     Then the box is a machine holder of kube, and the job a job holder of kube on the box
//     And the machine of no template is no holder
//   Scenario: a job no longer live is no row
//     When the job ends
//     Then it is no job holder
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import type { AccessView } from '../../src/domain/types.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);

let t: TestApp | undefined;
const clients: Client[] = [];
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_TOKEN_KEY: KEY },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
    seams: { authorizationServer: createFakeAuthorizationServer() },
  });
  const session = await t.login();
  await t.ui('/ui/api/vault', { action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: [] }, { token: session });
  return { a: t, session };
}

async function joinMachine(a: TestApp, session: string, name: string, template?: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-machine-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const code = (await a.ui<{ code: string }>('/ui/api/machines/join', template ? { template } : {}, { token: session })).body.code;
  await joinHopper({ line: `${a.url}#${code}`, name, dir });
  clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });
}

const access = async (a: TestApp, session: string) => (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': session })).body;

describe('the permission matrix\'s holders (issue #559)', () => {
  it('names each box of a template and each live job on one, and no machine of no template', async () => {
    const { a, session } = await boot();
    await joinMachine(a, session, 'hopper-sandbox-kube', 'kube');
    const job = await a.pull({ op: 'sleep', ms: 1500 });
    expect((await a.waitForStatus(job.id, 'running', 10000)).laneId).toBe('hopper-sandbox-kube/lane-1');

    const live = await access(a, session);
    expect(live.holders.machines).toEqual([{ user: 'admin', machine: 'hopper-sandbox-kube', template: 'kube' }]);
    expect(live.holders.jobs).toEqual([{ user: 'admin', job: job.id, machine: 'hopper-sandbox-kube', template: 'kube', status: 'running' }]);
    expect(live.templates.map((x) => x.template)).toEqual(['kube']);

    await a.waitForStatus(job.id, 'finished', 10000);
    expect((await access(a, session)).holders.jobs).toEqual([]);
  });

  it('names no machine that joined as no box of a template', async () => {
    const { a, session } = await boot();
    await joinMachine(a, session, 'desk');
    const job = await a.pull({ op: 'sleep', ms: 1500 });
    await a.waitForStatus(job.id, 'running', 10000);
    expect((await access(a, session)).holders).toEqual({ machines: [], jobs: [] });
  });
});
