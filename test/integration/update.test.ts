// Self-update through the HTTP edge (issue #44): GET /api/update reads, POST /ui/api/update checks,
// applies and sets the channel and auto-update — behind the UI session. The boot after an apply
// reports update.applied. The update repository is a real git repo; the build and the restart are seams.
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateStatus } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';
import { copyBuilder, createInstall, createUpstream, readInstall, tempDir } from '../update/support.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

function world() {
  const root = tempDir('jh-update-it-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const up = createUpstream(root);
  const c1 = up.commit('first', 'v1');
  const c2 = up.commit('second', 'v2');
  return { root, up, c1, c2, dbPath: db.dbPath, appDir: createInstall(root, up.dir, c1) };
}

describe('self-update over HTTP', () => {
  it('is unavailable for a daemon run from a checkout (no install.json)', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const app = await startTestApp({ dbPath: db.dbPath });
    apps.push(app);
    const s = (await app.api<UpdateStatus>('GET', '/api/update')).body;
    expect(s).toMatchObject({ state: 'unavailable', channel: 'main', autoUpdate: false });
  });

  it('checks, sets auto-update and the channel, and applies only with a UI session', async () => {
    const w = world();
    const restarts: number[] = [];
    const app = await startTestApp({ dbPath: w.dbPath, seams: { update: { appDir: w.appDir, builder: copyBuilder(), restart: async () => { restarts.push(1); } } } });
    apps.push(app);
    expect((await app.ui('/ui/api/update', { action: 'check' })).status).toBe(403);
    const token = await app.login();
    const checked = await app.ui<UpdateStatus>('/ui/api/update', { action: 'check' }, { token });
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ state: 'available', target: { commit: w.c2, ref: 'main' }, installed: { commit: w.c1 } });
    expect(checked.body.changes.map((c) => c.subject)).toEqual(['second']);
    expect((await app.api<UpdateStatus>('GET', '/api/update')).body.state).toBe('available');

    const set = await app.ui<UpdateStatus>('/ui/api/update', { action: 'settings', channel: 'release' }, { token });
    expect(set.body.channel).toBe('release');
    expect((await app.ui('/ui/api/update', { action: 'settings', channel: 'nightly' }, { token })).status).toBe(400);
    await app.ui('/ui/api/update', { action: 'settings', channel: 'main' }, { token });
    await waitFor(async () => (await app.api<UpdateStatus>('GET', '/api/update')).body.target?.ref === 'main');

    const applied = await app.ui<UpdateStatus>('/ui/api/update', { action: 'apply' }, { token });
    expect(applied.status).toBe(200);
    expect(applied.body.state).toBe('applying');
    await waitFor(() => restarts.length === 1);
    expect(readInstall(w.appDir).commit).toBe(w.c2);
    expect((await app.ui('/ui/api/update', { action: 'apply' }, { token })).status).toBe(409);
    expect((await app.events()).filter((e) => e.type.startsWith('update.')).map((e) => e.type)).toEqual(['update.available', 'update.started']);
  });

  it('reports update.applied on the boot after, and keeps the settings and the queue', async () => {
    const w = world();
    const restarts: number[] = [];
    const seams = { update: { appDir: w.appDir, builder: copyBuilder(), restart: async () => { restarts.push(1); } } };
    const first = await startTestApp({ dbPath: w.dbPath, seams });
    apps.push(first);
    const token = await first.login();
    await first.ui('/ui/api/update', { action: 'settings', autoUpdate: true }, { token });
    const queued = await first.pull({ op: 'echo' }, { key: 'k-before' });
    await first.ui('/ui/api/update', { action: 'check' }, { token });
    await waitFor(() => restarts.length === 1);
    await first.stop();
    apps.splice(apps.indexOf(first), 1);

    const second = await startTestApp({ dbPath: w.dbPath, seams });
    apps.push(second);
    const applied = await waitFor(async () => (await second.events()).find((e) => e.type === 'update.applied'));
    expect(applied.data).toEqual({ from: w.c1, to: w.c2, ref: 'main' });
    const s = (await second.api<UpdateStatus>('GET', '/api/update')).body;
    expect(s).toMatchObject({ autoUpdate: true, installed: { commit: w.c2 } });
    expect((await second.job(queued.id)).id).toBe(queued.id);
  });
});
