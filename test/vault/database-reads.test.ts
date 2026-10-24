// Issue #2231: a database read on the vault's side. Access decides each read for the template, as a need step's mint;
// a deny mints nothing. The vault mints a database read role from the database's minting credential, runs the job's SELECT with
// it, and drops it at the read's end, whatever happened. Each mint, read and drop is an event with the job, the read,
// the database, the role, the decision and the expiry; the read carries its SQL. No password reaches an event or an
// answer. The sweep drops roles a hopper that stopped left. The database is a double at its seam (DatabaseReader); the
// Postgres side is test/vault/postgres-reads.test.ts.
import { describe, expect, it } from 'vitest';
import type { Asset, MintDecision, VaultAccess } from '../../src/domain/access.ts';
import type { DatabaseMintingCredential, DatabaseReader } from '../../src/domain/database-read.ts';
import type { DomainEvent, NewEvent } from '../../src/domain/types.ts';
import type { VaultSecret } from '../../src/domain/vault.ts';
import { databaseReads } from '../../src/vault/database-reads.ts';

const NOW = new Date('2026-10-23T12:00:00Z');
const DB: Asset = { kind: 'database', name: 'lab/apps/orders' };
const MINTER_PASSWORD = 'minter-pw-never-shown';
const CREDENTIAL = JSON.stringify({ engine: 'postgres', host: 'db.lab.internal', database: 'orders', user: 'hopper_minter', password: MINTER_PASSWORD, schemas: ['app'] });

function world(o: { allowed?: boolean; status?: string; read?: DatabaseReader['read']; mint?: DatabaseReader['mint']; secrets?: VaultSecret[] } = {}) {
  const events: DomainEvent[] = [];
  const asked: unknown[] = [];
  const done: { minted: { role: string; password: string; validUntil: Date }[]; read: { role: string; password: string; sql: string }[]; dropped: string[]; swept: number } = { minted: [], read: [], dropped: [], swept: 0 };
  const secrets: VaultSecret[] = o.secrets ?? [{ id: 's1', name: 'ORDERS_DB', mints: DB, setBy: 'u', createdAt: '', changedBy: 'u', changedAt: '' } as VaultSecret];
  const reader: DatabaseReader = {
    mint: o.mint ?? (async (_c, r) => { done.minted.push(r); }),
    read: o.read ?? (async (_c, r) => { done.read.push(r); return { csv: 'n\n2\n', rows: 1, bytes: 4 }; }),
    drop: async (_c, role) => { done.dropped.push(role); },
    sweep: async (c: DatabaseMintingCredential) => { done.swept++; return c.database === 'orders' ? ['hopper_read_left'] : []; },
  };
  const access = {
    async decideCheckMint(r: unknown): Promise<MintDecision> {
      asked.push(r);
      return { id: 'd1', at: NOW.toISOString(), allowed: o.allowed ?? true, reason: o.allowed === false ? 'template t is not approved for read on database lab/apps/orders' : 'approved' };
    },
  } as unknown as VaultAccess;
  const store = {
    vault: { list: () => secrets, get: (n: string) => secrets.find((s) => s.name === n) },
    events: { append: (e: NewEvent) => { const d = { ...e, seq: events.length + 1, id: `e${events.length}`, at: NOW.toISOString(), schemaVersion: 1 } as DomainEvent; events.push(d); return d; } },
    jobs: { get: (id: string) => (id === 'job-1' ? { id, status: o.status ?? 'running' } : undefined) },
    tx: <T>(fn: () => T): T => fn(),
  };
  const reads = databaseReads(store as never, { access, reader, valueOf: async () => ({ value: CREDENTIAL }), clock: { now: () => NOW }, logger: { warn: () => {} } });
  return { reads, events, asked, done };
}

const ASK = { job: 'job-1', template: 'orders-read', asset: DB, sql: 'SELECT count(*) AS n FROM app.users' };

describe('a database read (issue #2231)', () => {
  it('asks Access for the template, mints a role, reads, and drops the role', async () => {
    const w = world();
    const a = await w.reads.readDatabase(ASK);
    expect(a).toEqual({ csv: 'n\n2\n', rows: 1, bytes: 4 });
    expect(w.asked).toEqual([{ template: 'orders-read', check: expect.stringMatching(/^database-read-[0-9a-f]{16}$/), operation: 'read', asset: DB }]);
    const [m] = w.done.minted;
    expect(m!.role).toMatch(/^hopper_read_[0-9a-f]{16}$/);
    expect(m!.validUntil.toISOString()).toBe('2026-10-23T12:15:00.000Z');
    expect(w.done.read).toEqual([{ role: m!.role, password: m!.password, sql: ASK.sql }]);
    expect(w.done.dropped).toEqual([m!.role]);
    const read = m!.role.slice('hopper_read_'.length);
    expect(w.events.map((e) => [e.type, e.jobId, e.data])).toEqual([
      ['database.role_minted', 'job-1', { job: 'job-1', read, template: 'orders-read', asset: DB, credential: 'ORDERS_DB', role: m!.role, decision: 'd1', expiresAt: '2026-10-23T12:15:00.000Z' }],
      ['database.role_dropped', 'job-1', { job: 'job-1', read, asset: DB, credential: 'ORDERS_DB', role: m!.role, reason: 'read-ended' }],
      ['database.read', 'job-1', { job: 'job-1', read, template: 'orders-read', asset: DB, role: m!.role, decision: 'd1', sql: ASK.sql, rows: 1, bytes: 4, ms: 0 }],
    ]);
  });

  it('mints nothing when Access denies it', async () => {
    const w = world({ allowed: false });
    expect(await w.reads.readDatabase(ASK)).toEqual({ status: 403, no: 'Access denied it: template t is not approved for read on database lab/apps/orders. A person approves read on database lab/apps/orders for template orders-read on Access requests' });
    expect(w.done.minted).toEqual([]);
    expect(w.events.map((e) => [e.type, e.data])).toEqual([['database.read_refused', { job: 'job-1', template: 'orders-read', asset: DB, reason: expect.stringMatching(/^Access denied it/), decision: 'd1' }]]);
  });

  it('runs only for a job at work, one SELECT, on a database a minting credential mints for', async () => {
    expect(await world({ status: 'done' }).reads.readDatabase(ASK)).toEqual({ status: 409, no: 'the job is not at work: the vault reads a database only while its job runs' });
    expect(await world().reads.readDatabase({ ...ASK, sql: '' })).toEqual({ status: 400, no: 'name the SELECT to run with --sql' });
    expect(await world().reads.readDatabase({ ...ASK, asset: { kind: 'cluster', name: 'lab' } })).toEqual({ status: 400, no: 'a database read names a database (database/<cluster>/<namespace>/<database>), not cluster lab' });
    expect(await world({ secrets: [] }).reads.readDatabase(ASK)).toEqual({ status: 409, no: 'no minting credential mints for database lab/apps/orders: a person adds one on Vault' });
  });

  it('drops the role when the read fails, and says why with no password in it', async () => {
    const w = world({ read: async (_c, r) => { throw new Error(`permission denied for table secrets (login ${r.password}, minter ${MINTER_PASSWORD})`); } });
    const a = await w.reads.readDatabase(ASK);
    expect(a).toMatchObject({ status: 502 });
    expect(JSON.stringify(a)).not.toContain(MINTER_PASSWORD);
    expect(JSON.stringify(a)).not.toContain(w.done.minted[0]!.password);
    expect(w.done.dropped).toEqual([w.done.minted[0]!.role]);
    const read = w.events.find((e) => e.type === 'database.read')!;
    expect(read.data).toMatchObject({ sql: ASK.sql, problem: expect.stringContaining('permission denied for table secrets') });
    expect(JSON.stringify(w.events)).not.toContain(MINTER_PASSWORD);
    expect(JSON.stringify(w.events)).not.toContain(w.done.minted[0]!.password);
  });

  it('reads nothing when the mint fails', async () => {
    const w = world({ mint: async () => { throw new Error(`the database read role could change app.open (minter ${MINTER_PASSWORD})`); } });
    const a = await w.reads.readDatabase(ASK);
    expect(a).toEqual({ status: 502, no: 'minting a database read role in database lab/apps/orders failed: the database read role could change app.open (minter ***)' });
    expect(w.done.read).toEqual([]);
    expect(w.events.map((e) => e.type)).toEqual(['database.read_refused']);
  });
});

describe('the sweep of database read roles (issue #2231)', () => {
  it('drops, with each database\'s minting credential, the roles whose VALID UNTIL passed', async () => {
    const w = world();
    await w.reads.sweepDatabaseRoles();
    expect(w.done.swept).toBe(1);
    expect(w.events.map((e) => [e.type, e.jobId, e.data])).toEqual([
      ['database.role_dropped', undefined, { asset: DB, credential: 'ORDERS_DB', role: 'hopper_read_left', reason: 'expired' }],
    ]);
  });

  it('hands a read Access allowed to the vault that holds the minting credential, and mints nothing here (issue #586)', async () => {
    const w = world();
    const handed: unknown[] = [];
    const a = await w.reads.readDatabase(ASK, async (r) => { handed.push(r); return { csv: 'n\n3\n', rows: 1, bytes: 4 }; });
    expect(a).toEqual({ csv: 'n\n3\n', rows: 1, bytes: 4 });
    expect(handed).toEqual([{ ...ASK, id: expect.stringMatching(/^[0-9a-f]{16}$/), decision: 'd1' }]);
    expect(w.done.minted).toEqual([]);
    expect(await world({ allowed: false }).reads.readDatabase(ASK, async (r) => { handed.push(r); return { status: 500, no: 'not asked' }; })).toMatchObject({ status: 403 });
    expect(handed).toHaveLength(1);
  });
});
