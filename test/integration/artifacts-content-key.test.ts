// Issue #673: a content URL survives a restart. The key it is signed under is kept in the owner's vault system scope
// (issue #657), sealed under the master key, made on the first read that signs one; a restart opens it again, so a URL
// a viewer holds keeps working until its own expiry. The real composition root, store and HTTP server.
//
// Feature: content URLs survive a restart
//   Scenario: a content URL signed before a restart loads after it, within its expiry
//     Given a hopper with a master key, and an artifact
//     When the owner reads it, the hopper restarts, and the owner's browser loads the content URL it was given
//     Then the content loads
//     And the key is a system secret of the owner's, sealed: no row, event or answer carries it in clear
//   Scenario: limited (no master key given, secrets kept): the key lives only in the process, and the log says so once
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactsView } from '../../src/domain/types.ts';
import { openDb } from '../../src/store/db.ts';
import { ownerSchemaUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

async function start(dbPath: string, secrets: Record<string, string | undefined>): Promise<{ a: TestApp; session: string }> {
  t = await startTestApp({ dbPath, plugins: { machines: [] }, secrets });
  return { a: t, session: await t.login() };
}

const read = async (a: TestApp, session: string): Promise<ArtifactsView> =>
  (await a.api<ArtifactsView>('GET', '/api/artifacts', undefined, { 'x-hopper-session': session })).body;

function put(a: TestApp): void {
  a.user().store.artifacts.add({
    id: 'chart-1', userId: a.user().user.id, jobId: 'job-1', title: 'chart', name: 'chart.txt', type: 'text/plain', kind: 'text',
    size: 6, sha256: 'x', createdAt: new Date().toISOString(),
  }, Buffer.from('chart\n'));
}

function vaultRows(a: TestApp): Record<string, unknown>[] {
  const db = openDb(ownerSchemaUrlFor(a.dbPath));
  try { return db.all('SELECT * FROM vault_secrets ORDER BY seq'); } finally { db.close(); }
}

describe('content URLs survive a restart (issue #673)', () => {
  it('a content URL signed before a restart loads after it; its key is a sealed system secret', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    let { a, session } = await start(db.dbPath, { HOPPER_MASTER_KEY: KEY });
    put(a);
    const url = (await read(a, session)).artifacts[0]!.contentUrl;
    expect((await fetch(a.url + url)).status).toBe(200);
    const row = vaultRows(a).find((r) => r.name === 'system/artifact-content-key');
    expect(row).toBeDefined();
    expect(a.user().store.events.recent(1000).map((e) => e.type)).toContain('vault.secret_set');

    await a.stop();
    t = undefined;
    ({ a, session } = await start(db.dbPath, { HOPPER_MASTER_KEY: KEY }));
    const res = await fetch(a.url + url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('chart\n');
    // The next read signs under the same key; no second key was made.
    expect(vaultRows(a).filter((r) => r.name === 'system/artifact-content-key')).toHaveLength(1);
    expect((await read(a, session)).artifacts[0]!.contentUrl).toMatch(/\?v=/);
    // A changed signature still loads nothing.
    expect((await fetch(a.url + url.replace(/\.[A-Za-z0-9_-]+$/, '.x'))).status).toBe(404);
  });

  it('limited — secrets kept, no master key given —: the key lives only in the process, the log says so, and URLs end at a restart', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const first = await start(db.dbPath, { HOPPER_MASTER_KEY: KEY });
    put(first.a);
    const before = (await read(first.a, first.session)).artifacts[0]!.contentUrl;
    await first.a.stop();
    t = undefined;
    // Issue #659: with secrets kept and no key given the hopper runs limited, and opens no secret.
    const { a, session } = await start(db.dbPath, { HOPPER_MASTER_KEY: undefined });
    expect((await fetch(a.url + before)).status).toBe(404);
    const now = (await read(a, session)).artifacts[0]!.contentUrl;
    await read(a, session);
    expect((await fetch(a.url + now)).status).toBe(200);
    expect(logged.filter((l) => l.includes('content URLs end at a restart'))).toHaveLength(1);
    // The stored key is left as it is.
    expect(vaultRows(a).filter((r) => r.name === 'system/artifact-content-key')).toHaveLength(1);
  });
});
