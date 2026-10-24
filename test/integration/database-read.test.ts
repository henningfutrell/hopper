// Issue #2231, through the real composition root, the real HTTP server, the real `hopper-skill` and a real Postgres: a
// job reads rows of a database through the hopper. A person sets the database's minting credential on Vault once; a job
// asks for a template with read on the database; a person approves it, as every database read is high radius; then each
// `database read` mints a database read role, runs the job's SELECT with it, answers CSV and drops the role. A write is refused;
// no password reaches an answer or an event; the read and its SQL are on the job's timeline. OpenFGA is a double at its
// seam. Part 3: the same with the vault in a container of its own (issue #586), which holds the minting credential and
// runs the read; Access still decides it in the hopper, and the events reach the hopper's log.
//
// Feature: a database read
//   Scenario Outline: the first read waits for a person's approval of the template; then a read answers CSV, a write is
//     refused, each database read role is gone after its read, and no password is in an answer or an event
//     Examples: the vault in the hopper; the vault in its own container
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent, VaultView } from '../../src/domain/types.ts';
import { boot, runningJob, skill, stopAll } from '../support/read-only-check.ts';
import { readDatabases, type ReadDatabases } from '../support/database-read.ts';

const DB = 'lab/apps/orders';
let dbs: ReadDatabases;
beforeAll(async () => { dbs = await readDatabases(); }, 60_000);
afterAll(async () => { await dbs?.close(); });
afterEach(async () => { await stopAll(); });

const readRoles = async (): Promise<string[]> =>
  (await dbs.admin("SELECT rolname FROM pg_roles WHERE rolname LIKE 'hopper\\_read\\_%' AND pg_has_role($1, oid, 'USAGE')", [dbs.credential.user])).rows.map((r: { rolname: string }) => r.rolname);

describe('a database read (issue #2231)', () => {
  it.each([['in the hopper', false], ['in its own container', true]])('with the vault %s, waits for a person first, then answers CSV through a database read role that is gone after it', async (_where, container) => {
    const b = await boot([], { container });
    const set = await b.a.ui('/ui/api/vault', { action: 'set', name: 'ORDERS_DB', value: JSON.stringify(dbs.credential), mints: { kind: 'database', name: DB } }, { token: b.token });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    const jobId = b.a.user().store.jobs.list({ status: ['running'] }).at(-1)!.id;
    const view = async () => (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body;

    // The template request: a database read is never in the read policy, and sandbox YOLO approves no high-radius
    // profile, so a person approves it.
    const asked = await skill(b.a, creds, ['sandbox-template', '--why', 'Compare the user records', '--needs', `read/database/${DB}`]);
    expect(asked.code, asked.stdout + asked.stderr).toBe(3);
    const name = (await view()).templates.find((t) => t.name.startsWith('asked-'))!.name;
    const sql = 'SELECT id, email, note FROM app.users ORDER BY id';
    const ask = ['database', 'read', '--template', name, '--database', DB, '--sql', sql, '--why', 'Compare the user records'];
    const early = await skill(b.a, creds, ask);
    expect(early.code, early.stdout + early.stderr).toBe(3);
    expect(early.stdout.split('\n')[0]).toBe(`waiting: template ${name} waits for a person to approve read on database ${DB} on Access requests. Add --wait to have the hopper tell you when the read can run.`);
    expect(early.stdout).toMatch(/\nwatch: [0-9a-f-]+: when the answer is ready, the hopper ends this job's own wait/);
    expect(await readRoles()).toEqual([]);

    for (const body of [{ action: 'approve-template', name }, { action: 'approve-profile', name, operation: 'read', asset: { kind: 'database', name: DB } }]) {
      const r = await b.a.ui('/ui/api/vault', body, { token: b.token });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const read = await skill(b.a, creds, ask);
    expect(read.code, read.stdout + read.stderr).toBe(0);
    expect(read.stdout).toBe('id,email,note\n1,a@example.test,\n2,b@example.test,"say ""hi"", twice"\n');
    expect(await readRoles()).toEqual([]);

    const write = await skill(b.a, creds, ['database', 'read', '--template', name, '--database', DB, '--sql', 'DELETE FROM app.users RETURNING id']);
    expect(write.code).toBe(1);
    expect(write.stdout).toMatch(/^no: the read of database lab\/apps\/orders failed: syntax error/);
    const two = await skill(b.a, creds, ['database', 'read', '--template', name, '--database', DB, '--sql', 'SELECT 1; DELETE FROM app.users']);
    expect(two.stdout).toContain('cannot insert multiple commands into a prepared statement');
    expect((await dbs.admin('SELECT count(*)::int AS n FROM app.users')).rows).toEqual([{ n: 2 }]);
    expect(await readRoles()).toEqual([]);

    const events: DomainEvent[] = await b.a.events();
    for (const r of [asked, early, read, write, two]) expect(r.stdout + r.stderr).not.toContain(dbs.credential.password);
    expect(JSON.stringify(events)).not.toContain(dbs.credential.password);
    const reads = events.filter((e) => e.type === 'database.read' && e.jobId === jobId);
    expect(reads.map((e) => e.data)).toMatchObject([{ template: name, asset: { kind: 'database', name: DB }, sql, rows: 2 }, { problem: expect.stringMatching(/syntax error/) }, { problem: expect.stringMatching(/multiple commands/) }]);
    const minted = events.filter((e) => e.type === 'database.role_minted').map((e) => e.data.role);
    expect(events.filter((e) => e.type === 'database.role_dropped').map((e) => e.data.role)).toEqual(minted);
  }, 60_000);

  it('mints nothing for a template with no read on the database', async () => {
    const b = await boot([]);
    await b.a.ui('/ui/api/vault', { action: 'set', name: 'ORDERS_DB', value: JSON.stringify(dbs.credential), mints: { kind: 'database', name: DB } }, { token: b.token });
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    await skill(b.a, creds, ['sandbox-template', '--why', 'Read the lab', '--needs', 'read/cluster/lab']);
    const name = (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body.templates.find((t) => t.name.startsWith('asked-'))!.name;
    const r = await skill(b.a, creds, ['database', 'read', '--template', name, '--database', DB, '--sql', 'SELECT 1']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(`no: template ${name} has no read on database ${DB}. Ask for one: sh "$HOPPER_SKILL" sandbox-template --needs "read/database/${DB}" --why "…"\n`);
    expect(await readRoles()).toEqual([]);
    expect((await b.a.events()).filter((e: DomainEvent) => e.type === 'database.role_minted')).toEqual([]);
  }, 60_000);
});
