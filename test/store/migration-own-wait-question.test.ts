// Issue #1780: a job on its own wait has no question, but a job that asked one before kept its `questionId`, so
// `hopper question list` (no open question) and the job disagreed. The migration takes it off each job on its own wait;
// a job that waits on its question keeps it.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { createContext } from '../../src/store/context.ts';
import { createJobRepository } from '../../src/store/jobs.ts';
import { noQuestionOnOwnWait } from '../../src/store/migration-own-wait-question.ts';
import { migrateTenant, TENANT_SCHEMA_VERSION } from '../../src/store/tenant-migrations.ts';
import { RECENT_TENANT_MIGRATIONS } from '../../src/store/tenant-migrations-recent.ts';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();
const VERSION = TENANT_SCHEMA_VERSION - RECENT_TENANT_MIGRATIONS.length + RECENT_TENANT_MIGRATIONS.indexOf(noQuestionOnOwnWait) + 1;

/** A job row as the build before writes it: status and body. */
function write(db: Db, id: string, status: string, body: Record<string, unknown>): void {
  const cur = JSON.parse(String(db.get('SELECT body FROM jobs WHERE id = ?', id)!.body)) as Record<string, unknown>;
  db.run('UPDATE jobs SET status = ?, body = ? WHERE id = ?', status, JSON.stringify({ ...cur, status, ...body }), id);
}
const bodyOf = (db: Db, id: string) => JSON.parse(String(db.get('SELECT body FROM jobs WHERE id = ?', id)!.body)) as Record<string, unknown>;

describe('a job on its own wait keeps no question (issue #1780)', () => {
  it('the migration takes questionId off each job on its own wait, and off no other', () => {
    const db = t.tenantAt(t.url(), VERSION - 1);
    let n = 0;
    const jobs = createJobRepository(createContext({ db, clock: fixedClock(), idGen: () => `i${++n}` }));
    for (let i = 0; i < 3; i++) jobs.create(spec, 50);
    const wait = { for: 'the review', since: '2026-10-17T00:00:00.000Z', on: { kind: 'outside', what: 'the review' } };
    write(db, 'i1', 'waiting_on', { questionId: 'q1', wait });
    write(db, 'i2', 'waiting_answer', { questionId: 'q2' });
    write(db, 'i3', 'waiting_on', { wait });

    migrateTenant(db, VERSION);

    expect(bodyOf(db, 'i1')).not.toHaveProperty('questionId');
    expect(bodyOf(db, 'i1')).toMatchObject({ status: 'waiting_on', wait });
    expect(bodyOf(db, 'i2')).toMatchObject({ questionId: 'q2' });
    expect(bodyOf(db, 'i3')).toMatchObject({ status: 'waiting_on', wait });
    db.close();
  });
});
