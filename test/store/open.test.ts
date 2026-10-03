import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

describe('openStore', () => {
  it('creates the parent directory, uses WAL, records the schema version', () => {
    const path = t.path();
    const s = t.open(path);
    expect(existsSync(path)).toBe(true);
    s.close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(raw.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 });
    raw.close();
  });

  it('reopening an existing file does not re-run or lose migrations', () => {
    const path = t.path();
    const s = t.open(path);
    const j = s.jobs.create({ executor: 'x', payload: {} }, 5);
    s.close();
    const s2 = t.open(path);
    expect(s2.jobs.get(j.id)).toEqual(j);
    s2.close();
  });

  it('uses the injected idGen', () => {
    let n = 0;
    const s = openStore({ path: t.path(), clock: fixedClock(), idGen: () => `id-${++n}` });
    expect(s.jobs.create({ executor: 'x', payload: {} }, 5).id).toBe('id-1');
    expect(s.webhooks.upsertByName({ name: 'n', url: 'u', events: [], secret: 's', active: true }).id).toBe('id-2');
    expect(s.events.append({ type: 'job.queued', data: {} }).id).toBe('id-3');
    s.close();
  });

  it('defaults ids to uuids', () => {
    const s = t.open(t.path());
    expect(s.jobs.create({ executor: 'x', payload: {} }, 5).id).toMatch(/^[0-9a-f-]{36}$/);
    s.close();
  });
});
