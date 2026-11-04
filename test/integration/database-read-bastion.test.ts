// Issue #2231, the route through a bastion, through the real composition root, the real HTTP server, the real `hopper-skill`
// and a real Postgres. The minting credential names a bastion target, and its host resolves nowhere here: the only way to the
// database is the job's bastion. The container runtime is a double at its port whose box runs the bastion's script under `sh`
// with a fake kubectl, and whose pipe joins a connection to the test Postgres, as the box's forward does; OpenFGA is a
// double at its seam.
//
// Feature: a database read through a bastion
//   Scenario: with no bastion the read says which target to start; with it, the read answers CSV, a write is refused, the
//     role is gone, each connection is a relay on the job's timeline, and no password is in an answer or an event
//   Scenario: with the vault in its own container, the read is refused and says why
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent, VaultView } from '../../src/domain/types.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { readDatabases, type ReadDatabases } from '../support/database-read.ts';
import { boot, runningJob, skill, stopAll, type Booted } from '../support/read-only-check.ts';
import { waitFor } from '../support/wait.ts';

const DB = 'lab/apps/orders';
const TARGET = 'lab/apps/svc/orders-db:5432';
let dbs: ReadDatabases;
const children: ChildProcess[] = [];
beforeAll(async () => { dbs = await readDatabases(); }, 60_000);
afterAll(async () => { await dbs?.close(); });
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ }
  await stopAll();
});

const credential = (): string => JSON.stringify({ ...dbs.credential, host: 'orders-db.apps.svc.cluster.local', port: 5432, through: TARGET });
const readRoles = async (): Promise<string[]> =>
  (await dbs.admin("SELECT rolname FROM pg_roles WHERE rolname LIKE 'hopper\\_read\\_%' AND pg_has_role($1, oid, 'USAGE')", [dbs.credential.user])).rows.map((r: { rolname: string }) => r.rolname);

/** The bastion's box runs its script under `sh` with a kubectl that says it listens; its pipe connects to the test Postgres. */
function boxes(b: Booted): void {
  const homeOf = (name: string): string => { const h = join(b.cloud.dir, `home-${name}`); mkdirSync(h, { recursive: true }); return h; };
  const bin = join(b.cloud.dir, 'bastion-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\necho "Forwarding from 127.0.0.1:20000 -> 5432"\nexec sleep 600\n');
  chmodSync(join(bin, 'kubectl'), 0o755);
  const check = b.runtime.runScript;
  const running = new Map<string, ChildProcess>();
  const outputs = new Map<string, string>();
  b.runtime.runScript = (spec) => (spec.name.startsWith('hopper-check-') && check ? check(spec) : new Promise((resolve) => {
    const child = spawn('sh', ['-c', spec.script ?? ''], { env: { ...spec.env, HOME: homeOf(spec.name), PATH: `${bin}:${process.env.PATH}` }, detached: true });
    running.set(spec.name, child);
    children.push(child);
    const add = (d: Buffer): void => { outputs.set(spec.name, (outputs.get(spec.name) ?? '') + d.toString()); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('exit', (code) => resolve({ exit: code ?? 143, output: outputs.get(spec.name) ?? '' }));
  }));
  const logs = b.runtime.logs.bind(b.runtime);
  b.runtime.logs = async (id) => {
    const c = [...b.runtime.boxes.values()].find((x) => x.id === id);
    return c && running.has(c.spec.name) ? outputs.get(c.spec.name) ?? '' : logs(id);
  };
  b.runtime.copyIn = async (id, dir, tar) => {
    const c = [...b.runtime.boxes.values()].find((x) => x.id === id)!;
    const to = dir.replace(HOME, homeOf(c.spec.name));
    mkdirSync(to, { recursive: true });
    execFileSync('tar', ['-xf', tar, '-C', to]);
  };
  const stop = b.runtime.stop.bind(b.runtime);
  b.runtime.stop = async (id) => {
    const c = [...b.runtime.boxes.values()].find((x) => x.id === id);
    const child = c && running.get(c.spec.name);
    if (child?.exitCode === null) process.kill(-child.pid!, 'SIGTERM');
    await stop(id);
  };
  b.runtime.pipe = async () => Object.assign(connect(dbs.credential.port, dbs.credential.host), { stderr: () => '' });
}

/** The template a person approved: read on the database, the observe, and the target. Its read-only check passed. */
async function approvedTemplate(b: Booted, creds: string): Promise<string> {
  const view = async () => (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body;
  const asked = await skill(b.a, creds, ['sandbox-template', '--why', 'Compare the user records', '--plan', 'port-forward to the database, read only', '--needs', `read/database/${DB} observe/namespace/lab/apps`, '--targets', TARGET]);
  expect(asked.stdout + asked.stderr).toContain('asked-');
  const name = (await view()).templates.find((t) => t.name.startsWith('asked-'))!.name;
  for (const body of [
    { action: 'approve-template', name },
    { action: 'approve-profile', name, operation: 'read', asset: { kind: 'database', name: DB } },
    { action: 'approve-profile', name, operation: 'observe', asset: { kind: 'namespace', name: 'lab/apps' } },
  ]) {
    const r = await b.a.ui('/ui/api/vault', body, { token: b.token });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  await b.a.app.sandboxes.check();
  return name;
}

describe('a database read through a bastion (issue #2231)', () => {
  it('needs the job\'s bastion, then reads over its forward and leaves no role', async () => {
    const b = await boot([]);
    boxes(b);
    expect((await b.a.ui('/ui/api/vault', { action: 'set', name: 'ORDERS_DB', value: credential(), mints: { kind: 'database', name: DB } }, { token: b.token })).status).toBe(200);
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    const jobId = b.a.user().store.jobs.list({ status: ['running'] }).at(-1)!.id;
    const name = await approvedTemplate(b, creds);
    const sql = 'SELECT count(*) AS n FROM app.users';
    const ask = ['database', 'read', '--template', name, '--database', DB, '--sql', sql];

    const early = await skill(b.a, creds, ask);
    expect(early.code, early.stdout + early.stderr).toBe(1);
    expect(early.stdout).toContain(`database ${DB} is reached through bastion target ${TARGET}: this job has no bastion that runs`);
    expect(early.stdout).toContain(`sh "$HOPPER_SKILL" bastion --template ${name} --targets "${TARGET}"`);
    expect(await readRoles()).toEqual([]);

    const started = await skill(b.a, creds, ['bastion', '--template', name, '--targets', TARGET, '--why', 'Compare the user records']);
    expect(started.code, started.stdout + started.stderr).toBe(0);
    await waitFor(async () => (await skill(b.a, creds, ['bastion'])).stdout.includes('is running'), { timeoutMs: 10_000 });

    const read = await skill(b.a, creds, ask);
    expect(read.code, read.stdout + read.stderr).toBe(0);
    expect(read.stdout).toBe('n\n2\n');
    expect(await readRoles()).toEqual([]);

    const write = await skill(b.a, creds, ['database', 'read', '--template', name, '--database', DB, '--sql', 'DELETE FROM app.users RETURNING id']);
    expect(write.code).toBe(1);
    expect(write.stdout).toMatch(/^no: the read of database lab\/apps\/orders failed: syntax error/);
    expect((await dbs.admin('SELECT count(*)::int AS n FROM app.users')).rows).toEqual([{ n: 2 }]);
    expect(await readRoles()).toEqual([]);

    await waitFor(async () => (await b.a.events() as DomainEvent[]).some((e) => e.type === 'bastion.relayed'), { timeoutMs: 5_000 });
    const events: DomainEvent[] = await b.a.events();
    expect(events.find((e) => e.type === 'bastion.relayed')).toMatchObject({ jobId, data: { target: TARGET } });
    expect(events.filter((e) => e.type === 'database.read' && e.jobId === jobId).map((e) => e.data)).toMatchObject([{ sql, rows: 1 }, { problem: expect.stringMatching(/syntax error/) }]);
    for (const r of [early, started, read, write]) expect(r.stdout + r.stderr).not.toContain(dbs.credential.password);
    expect(JSON.stringify(events)).not.toContain(dbs.credential.password);
  }, 60_000);

  it('with the vault in its own container, refuses and says why', async () => {
    const b = await boot([], { container: true });
    boxes(b);
    expect((await b.a.ui('/ui/api/vault', { action: 'set', name: 'ORDERS_DB', value: credential(), mints: { kind: 'database', name: DB } }, { token: b.token })).status).toBe(200);
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    const name = await approvedTemplate(b, creds);
    const r = await skill(b.a, creds, ['database', 'read', '--template', name, '--database', DB, '--sql', 'SELECT 1']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('a vault in a container of its own reads only a database it reaches itself');
    expect(await readRoles()).toEqual([]);
    await b.a.user().vault.reconcileMints();
  }, 60_000);
});
