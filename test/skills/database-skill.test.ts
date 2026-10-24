// Issue #2231: the database ask. It reads only through a template that names the database's read; a read a person has
// not approved yet waits; a wait the hopper asks again carries no SQL, so its answer says the read may run and never
// holds rows the job stream would keep.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import type { SandboxRequestView } from '../../src/domain/sandbox-approvals.ts';
import { databaseAsk, type DatabaseUser } from '../../src/skills/database-skill.ts';
import type { DatabaseReadAsk } from '../../src/vault/database-reads.ts';

const DB = { kind: 'database', name: 'lab/apps/orders' } as const;
const JOB = { id: 'job-1' } as Job;

function user(o: { pending?: boolean; run?: SandboxRequestView['state'] } = {}) {
  const reads: DatabaseReadAsk[] = [];
  const t = { name: 'orders-read', profiles: [{ operation: 'read', asset: DB }], pending: { profiles: o.pending ? [{ operation: 'read', asset: DB }] : [] } } as unknown as TemplateView;
  const u: DatabaseUser = {
    template: (name) => (name === t.name ? t : undefined),
    sandbox: () => ({ state: o.run ?? 'approved' }) as SandboxRequestView,
    databases: { readDatabase: async (a) => { reads.push(a); return { csv: 'n\n1\n', rows: 1, bytes: 4 }; } },
  };
  return { u, reads };
}

const say = {
  no: (status: number, reason: string) => ({ status, text: `no: ${reason}` }),
  loaded: (text: string) => ({ status: 200, text }),
  waiting: (text: string) => ({ status: 202, text }),
  waitingText: () => 'waiting: a person approves the runs.',
  declinedText: () => 'a person declined the runs',
};
const fields = { asset: 'read', template: 'orders-read', database: DB.name, sql: 'SELECT 1 AS n' };

describe('the database ask (issue #2231)', () => {
  it('reads through a template that names the database, the job\'s runs of it approved', async () => {
    const w = user();
    expect(await databaseAsk(w.u, JOB, fields, say)).toEqual({ status: 200, text: 'n\n1\n' });
    expect(w.reads).toEqual([{ job: 'job-1', template: 'orders-read', asset: DB, sql: 'SELECT 1 AS n' }]);
  });

  it('waits for a person, and reads nothing meanwhile', async () => {
    for (const w of [user({ pending: true }), user({ run: 'waiting' })]) {
      expect((await databaseAsk(w.u, JOB, fields, say)).status).toBe(202);
      expect(w.reads).toEqual([]);
    }
  });

  it('answers a wait asked again with no SQL: the read may run, and no row', async () => {
    const w = user();
    const { sql: _sql, ...again } = fields;
    expect(await databaseAsk(w.u, JOB, again, say)).toEqual({ status: 200, text: expect.stringMatching(/^ready: template orders-read may read database lab\/apps\/orders now\. Run the read: /) });
    expect(w.reads).toEqual([]);
  });

  it('says how with no asset, and refuses another', async () => {
    expect((await databaseAsk(user().u, JOB, {}, say)).text).toMatch(/^database: read rows of a database through the hopper/);
    expect(await databaseAsk(user().u, JOB, { ...fields, asset: 'write' }, say)).toMatchObject({ status: 400, text: expect.stringMatching(/^no: database takes read, not write/) });
  });
});
