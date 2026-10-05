import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { openStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

describe('openStore', () => {
  it('records the schema version', () => {
    const url = t.url();
    t.open(url).close();
    const raw = openDb(url);
    expect(raw.get('SELECT version FROM schema_version')).toEqual({ version: SCHEMA_VERSION });
    raw.close();
  });

  it('reopening an existing database does not re-run or lose migrations', () => {
    const path = t.url();
    const s = t.open(path);
    const j = s.jobs.create({ executor: 'x', payload: {} }, 5);
    s.close();
    const s2 = t.open(path);
    expect(s2.jobs.get(j.id)).toEqual(j);
    s2.close();
  });

  it('uses the injected idGen', () => {
    let n = 0;
    const s = openStore({ url: t.url(), clock: fixedClock(), idGen: () => `id-${++n}` });
    expect(s.jobs.create({ executor: 'x', payload: {} }, 5).id).toBe('id-1');
    expect(s.webhooks.add({ name: 'n', url: 'u', events: [], secretEnv: 'S', active: true })!.id).toBe('id-2');
    expect(s.events.append({ type: 'job.queued', data: {} }).id).toBe('id-3');
    s.close();
  });

  it('defaults ids to uuids', () => {
    const s = t.open(t.url());
    expect(s.jobs.create({ executor: 'x', payload: {} }, 5).id).toMatch(/^[0-9a-f-]{36}$/);
    s.close();
  });
});
