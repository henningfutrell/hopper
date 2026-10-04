import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { spec, useTempStore } from './helpers.ts';

const t = useTempStore();

// Schema v2 as shipped: the tables migration 3 touches.
const V2 = `
  CREATE TABLE jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
    created_at TEXT NOT NULL, body TEXT NOT NULL);
  CREATE INDEX jobs_status ON jobs (status);
  CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
    at TEXT NOT NULL, job_id TEXT, lane_id TEXT, machine_id TEXT, decision_id TEXT, data TEXT NOT NULL, question_id TEXT);
  CREATE INDEX events_type ON events (type, seq);
  CREATE TABLE webhooks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
    events TEXT NOT NULL, secret TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

describe('migration 3 (sources, schema versions, webhook names)', () => {
  it('upgrades a v2 file in place, keeping jobs, events and webhooks', () => {
    const path = t.path();
    mkdirSync(dirname(path), { recursive: true });
    const raw = new DatabaseSync(path);
    raw.exec(V2);
    const job = { id: 'j1', spec, priority: 5, status: 'queued', approved: false, createdAt: 'c', updatedAt: 'c', attempts: 0 };
    raw.prepare('INSERT INTO jobs (id, status, created_at, body) VALUES (?, ?, ?, ?)').run('j1', 'queued', 'c', JSON.stringify(job));
    raw.prepare('INSERT INTO events (id, type, at, job_id, data) VALUES (?, ?, ?, ?, ?)').run('e1', 'job.queued', 'at', 'j1', '{"k":1}');
    raw.prepare('INSERT INTO webhooks (id, url, events, secret, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run('w1', 'u1', '["*"]', 's1', 'c');
    raw.prepare('INSERT INTO webhooks (id, url, events, secret, active, created_at) VALUES (?, ?, ?, ?, 0, ?)').run('w2', 'u2', '[]', 's2', 'c');
    raw.exec('PRAGMA user_version = 2');
    raw.close();

    const s = t.open(path);
    expect(s.jobs.get('j1')).toEqual(job);
    expect(s.jobs.getBySourceKey('x')).toBeUndefined();
    expect(s.events.since(0)).toEqual([{ schemaVersion: 1, seq: 1, id: 'e1', type: 'job.queued', at: 'at', jobId: 'j1', data: { k: 1 } }]);
    expect(s.webhooks.list().map((w) => [w.id, w.name, w.url, w.active])).toEqual([
      ['w1', 'legacy-w1', 'u1', true], ['w2', 'legacy-w2', 'u2', false],
    ]);
    // New rows work on the migrated file.
    s.jobs.create(spec, 5, { source: 'github', kind: 'github', key: 'k1' });
    expect(s.events.append({ type: 'job.queued', data: {} }).schemaVersion).toBe(1);
    s.close();

    const after = new DatabaseSync(path);
    expect(after.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION });
    after.close();
  });
});
