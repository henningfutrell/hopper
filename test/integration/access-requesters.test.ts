// Issue #581: requesters in Access, through the real daemon, store, HTTP edge and a joined client; OpenFGA is a double
// at the AuthorizationServer seam. A check starts from the requester that asks — a job, a machine or a user — and
// follows the tuples the hopper writes from who is live: a user owns a job, the job runs on a machine, the machine is
// an instance of a template. The template's approval does the rest.
//
// Feature: requesters in Access
//   Scenario: a job on a box of an approved template is allowed
//     Given template kube is approved to read on cluster prod
//     And a box joined as an instance of kube, with a job running on it
//     When Access decides a read on cluster prod for the job
//     Then it is allowed, and the path names the user, the job, the machine and the template
//     And OpenFGA holds the tuples the hopper wrote for them
//   Scenario: the box and the job's user ask too, and the permission matrix shows each as a row
//   Scenario: the same check for a job on a box of a template that is not approved is denied
//   Scenario: a job that ends loses its tuples, and its check is denied
//   Scenario: a machine that leaves loses its tuple, and its check is denied
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import type { AccessView, RelationshipTuple } from '../../src/domain/types.ts';
import { createFakeAuthorizationServer, type FakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const PROD = { kind: 'cluster', name: 'prod' } as const;

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

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A hopper with the vault templates kube and other, and kube approved in Access to read on cluster prod. */
async function boot(): Promise<{ a: TestApp; session: string; server: FakeAuthorizationServer }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  const server = createFakeAuthorizationServer();
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_TOKEN_KEY: KEY },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
    seams: { authorizationServer: server },
  });
  const session = await t.login();
  const vault = (body: Record<string, unknown>) => t!.ui('/ui/api/vault', body, { token: session });
  await vault({ action: 'set', name: 'KUBE_TOKEN', scope: 'cluster prod, read only', value: 'k3s-token-never-in-access' });
  for (const name of ['kube', 'other']) expect((await vault({ action: 'save-template', name, image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN'] })).status).toBe(200);
  expect((await t.ui('/ui/api/access', { action: 'approve', template: 'kube', operation: 'read', asset: PROD }, { token: session })).status).toBe(200);
  return { a: t, session, server };
}

/** A box joined as an instance of `template`, its client started. */
async function joinBox(a: TestApp, session: string, name: string, template: string): Promise<void> {
  const dir = temp('hopper-box-');
  const code = (await a.ui<{ code: string }>('/ui/api/machines/join', { template }, { token: session })).body.code;
  await joinHopper({ line: `${a.url}#${code}`, name, dir });
  clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });
}

async function runningJob(a: TestApp, machine: string, ms = 60000): Promise<string> {
  const job = await a.pull({ op: 'sleep', ms });
  expect((await a.waitForStatus(job.id, 'running', 10000)).laneId).toBe(`${machine}/lane-1`);
  return job.id;
}

const held = (server: FakeAuthorizationServer): string[] => [...server.storeTuples([...server.stores.keys()][0]!).keys()];
const view = async (a: TestApp, session: string) => (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': session })).body;
const read = { operation: 'read', asset: PROD } as const;

const APPROVAL: RelationshipTuple[] = [
  { subject: 'template:kube', relation: 'approved_for', object: 'operation_profile:read/cluster/prod' },
  { subject: 'operation_profile:read/cluster/prod', relation: 'grants_read', object: 'asset:cluster/prod' },
];

describe('requesters in Access (issue #581)', () => {
  it('allows a job on a box of an approved template, and the path names the user, the job, the machine and the template', async () => {
    const { a, session, server } = await boot();
    await joinBox(a, session, 'kbox', 'kube');
    const job = await runningJob(a, 'kbox');
    const user = a.user().user.id;

    const d = await a.app.access.decideMint({ requester: { kind: 'job', userId: user, jobId: job }, ...read });
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/template kube is approved to read on cluster prod/);
    expect(d.path).toEqual([
      { subject: `user:${user}`, relation: 'owns', object: `job:${user}/${job}` },
      { subject: `job:${user}/${job}`, relation: 'runs_on', object: `machine:${user}/kbox` },
      { subject: `machine:${user}/kbox`, relation: 'instance_of', object: 'template:kube' },
      ...APPROVAL,
    ]);
    expect(held(server)).toEqual(expect.arrayContaining([
      `user:${user} owns job:${user}/${job}`, `job:${user}/${job} runs_on machine:${user}/kbox`, `machine:${user}/kbox instance_of template:kube`,
    ]));
    // No contextual tuple: the check is the requester's stored relations.
    expect(server.checks.at(-1)).toMatchObject({ tuple: { subject: `job:${user}/${job}`, relation: 'can_read', object: 'asset:cluster/prod' }, contextual: [] });
    expect((await view(a, session)).decisions[0]).toMatchObject({ requester: { kind: 'job', userId: user, jobId: job }, template: 'kube', allowed: true });
  });

  it('lets the box and the job\'s user ask too, and the permission matrix shows the user, the job and the machine as rows', async () => {
    const { a, session } = await boot();
    await joinBox(a, session, 'kbox', 'kube');
    const job = await runningJob(a, 'kbox');
    const user = a.user().user.id;

    const machine = await a.app.access.decideMint({ requester: { kind: 'machine', userId: user, machine: 'kbox' }, ...read });
    expect(machine).toMatchObject({ allowed: true, path: [{ subject: `machine:${user}/kbox`, relation: 'instance_of', object: 'template:kube' }, ...APPROVAL] });
    const person = await a.app.access.decideMint({ requester: { kind: 'user', userId: user }, ...read });
    expect(person.allowed).toBe(true);
    expect(person.path?.map((s) => s.relation)).toEqual(['owns', 'runs_on', 'instance_of', 'approved_for', 'grants_read']);
    expect((await a.app.access.decideMint({ requester: { kind: 'machine', userId: user, machine: 'kbox' }, operation: 'write', asset: PROD })).allowed).toBe(false);

    const rows = (await view(a, session)).requesters;
    const profile = { operation: 'read', asset: PROD };
    expect(rows).toEqual([
      { requester: { kind: 'user', userId: user }, grants: [{ profile, path: expect.any(Array) }] },
      { requester: { kind: 'job', userId: user, jobId: job }, template: 'kube', machine: 'kbox', grants: [{ profile, path: expect.any(Array) }] },
      { requester: { kind: 'machine', userId: user, machine: 'kbox' }, template: 'kube', grants: [{ profile, path: expect.any(Array) }] },
    ]);
  });

  it('denies the same check for a job on a box of a template that is not approved', async () => {
    const { a, session, server } = await boot();
    await joinBox(a, session, 'obox', 'other');
    const job = await runningJob(a, 'obox');
    const user = a.user().user.id;

    const d = await a.app.access.decideMint({ requester: { kind: 'job', userId: user, jobId: job }, ...read });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/template other is not approved to read on cluster prod/);
    expect(d.path).toBeUndefined();
    expect(held(server)).toContain(`machine:${user}/obox instance_of template:other`);
    const rows = (await view(a, session)).requesters;
    expect(rows.find((r) => r.requester.kind === 'job')).toMatchObject({ template: 'other', grants: [] });
  });

  it('removes a job\'s tuples when it ends, and denies its next check', async () => {
    const { a, session, server } = await boot();
    await joinBox(a, session, 'kbox', 'kube');
    const job = await runningJob(a, 'kbox', 1500);
    const user = a.user().user.id;
    const request = { requester: { kind: 'job', userId: user, jobId: job }, ...read } as const;
    expect((await a.app.access.decideMint(request)).allowed).toBe(true);

    await a.waitForStatus(job, 'finished', 10000);
    // Written and removed as jobs start and end, with no check asking: the hopper watches who is live.
    await waitFor(() => !held(server).some((k) => k.includes(`job:${user}/${job}`)), { timeoutMs: 10000, what: 'the job\'s tuples gone' });
    const ended = await a.app.access.decideMint(request);
    expect(ended.allowed).toBe(false);
    expect(ended.reason).toMatch(/is not live \(finished\)/);
    expect((await view(a, session)).requesters.map((r) => r.requester.kind)).toEqual(['user', 'machine']);
  });

  it('removes a machine\'s tuple when it leaves, and denies its next check', async () => {
    const { a, session, server } = await boot();
    await joinBox(a, session, 'kbox', 'kube');
    const user = a.user().user.id;
    const request = { requester: { kind: 'machine', userId: user, machine: 'kbox' }, ...read } as const;
    expect((await a.app.access.decideMint(request)).allowed).toBe(true);

    const version = (await a.api('GET', '/api/machines/config')).body.version as string;
    expect((await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'kbox', version }, { token: session })).status).toBe(200);
    await waitFor(() => !held(server).includes(`machine:${user}/kbox instance_of template:kube`), { timeoutMs: 10000, what: 'the box\'s tuple gone' });
    const left = await a.app.access.decideMint(request);
    expect(left.allowed).toBe(false);
    expect(left.reason).toMatch(/machine kbox is no box of a template/);
  });
});
