// Migration 14 (issue #78): webhook subscriptions live in the database, nothing else. The `webhooks`
// table had been a projection of a config document; the migration makes the document's subscriptions
// the table's rows and removes the document. Persisted state is the user's: a subscription in the
// document reaches the table, and a document that does not load leaves the table as it was.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const DOC = 'webhooks.yaml';

/** A store at version 13 holding `doc` as the webhooks document and the given rows, then migrated. */
function migrateFrom13(doc: string | undefined, rows: [id: string, name: string, secretEnv: string][] = []) {
  const url = t.url();
  t.open(url).close();
  const raw = openDb(url);
  for (const [id, name, secretEnv] of rows) {
    raw.run("INSERT INTO webhooks (id, name, url, events, secret_env, active, created_at) VALUES (?, ?, 'http://127.0.0.1:1/old', '[\"*\"]', ?, 1, '2026-10-01T00:00:00.000Z')", id, name, secretEnv);
  }
  for (const [id] of rows) {
    const body = { id: `d-${id}`, subscriptionId: id, eventSeq: 1, eventType: 'job.finished', status: 'pending', attempts: 0, nextAttemptAt: 'x', createdAt: 'x', updatedAt: 'x' };
    raw.run("INSERT INTO deliveries (id, subscription_id, status, next_attempt_at, body) VALUES (?, ?, 'pending', 'x', ?)", body.id, id, JSON.stringify(body));
  }
  if (doc !== undefined) raw.run("INSERT INTO config_documents (name, text, updated_at) VALUES (?, ?, 'x')", DOC, doc);
  raw.run('UPDATE schema_version SET version = 13');
  raw.close();
  t.open(url).close();
  const after = openDb(url);
  try {
    return {
      rows: after.all('SELECT id, name, url, events, secret_env, active FROM webhooks ORDER BY seq'),
      deliveries: Object.fromEntries(after.all('SELECT id, status, body FROM deliveries').map((r) => [r.id, [r.status, JSON.parse(String(r.body)).status]])),
      document: after.get('SELECT text FROM config_documents WHERE name = ?', DOC),
    };
  } finally {
    after.close();
  }
}

describe('migration 14 (webhook subscriptions in the database)', () => {
  it('makes the document\'s subscriptions the rows: changed ones updated in place, new ones added, others removed with their open deliveries failed; the document goes', () => {
    const doc = `version: 1
webhooks:
  - name: kept
    url: http://127.0.0.1:2/kept
    events: ["job.finished"]
    secretEnv: WEBHOOK_SECRET_KEPT
    active: false
  - name: new
    url: https://example.invalid/new
    events: ["*"]
    secretEnv: WEBHOOK_SECRET_NEW
`;
    const { rows, deliveries, document } = migrateFrom13(doc, [['id-kept', 'kept', ''], ['id-gone', 'gone', 'WEBHOOK_SECRET_GONE']]);
    expect(rows).toEqual([
      { id: 'id-kept', name: 'kept', url: 'http://127.0.0.1:2/kept', events: '["job.finished"]', secret_env: 'WEBHOOK_SECRET_KEPT', active: 0 },
      { id: expect.any(String), name: 'new', url: 'https://example.invalid/new', events: '["*"]', secret_env: 'WEBHOOK_SECRET_NEW', active: 1 },
    ]);
    expect(deliveries).toEqual({ 'd-id-kept': ['pending', 'pending'], 'd-id-gone': ['failed', 'failed'] });
    expect(document).toBeUndefined();
  });

  it.each([
    ['not YAML', 'version: 1\nwebhooks: [\n'],
    ['the wrong shape', 'version: 2\nwebhooks: nope\n'],
    ['an entry without secretEnv', 'version: 1\nwebhooks:\n  - name: x\n    url: http://127.0.0.1:1/x\n    events: ["*"]\n'],
  ])('a document that does not load (%s) leaves the rows as they were; the document goes', (_what, doc) => {
    const { rows, document } = migrateFrom13(doc, [['id-a', 'a', 'WEBHOOK_SECRET_A']]);
    expect(rows).toEqual([{ id: 'id-a', name: 'a', url: 'http://127.0.0.1:1/old', events: '["*"]', secret_env: 'WEBHOOK_SECRET_A', active: 1 }]);
    expect(document).toBeUndefined();
  });

  it('with no document, the rows stay', () => {
    const { rows } = migrateFrom13(undefined, [['id-a', 'a', 'WEBHOOK_SECRET_A']]);
    expect(rows.map((r) => r.name)).toEqual(['a']);
  });
});
