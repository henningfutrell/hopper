import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { spec, useTempStore } from './helpers.ts';

const t = useTempStore();
const ref = { source: 'github', kind: 'github', key: 'https://x/1' };

describe('migration 5 (a source key may have many jobs)', () => {
  it('replaces the unique source-key index in place, keeping the persisted jobs', () => {
    const path = t.path();
    const first = t.open(path);
    const kept = first.jobs.create(spec, 5, ref);
    first.close();

    // Put the file back as v4 shipped it: unique index, user_version 4.
    const raw = new DatabaseSync(path);
    raw.exec('DROP INDEX jobs_source_key; CREATE UNIQUE INDEX jobs_source_key ON jobs (source_key); DROP TABLE ui_sessions; PRAGMA user_version = 4');
    raw.close();

    const s = t.open(path);
    expect(s.jobs.get(kept.id)).toEqual(kept);
    const rerun = s.jobs.create(spec, 5, ref);
    expect(s.jobs.getBySourceKey(ref.key)).toEqual(rerun);
    expect(s.jobs.list()).toHaveLength(2);
    s.close();

    const after = new DatabaseSync(path);
    expect(after.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION });
    after.close();
  });
});
