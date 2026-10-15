// Header badges (issue #1181) through the real daemon, store and HTTP server: which dashboard KPI cards show as badges
// in the header is the user's own choice, a viewer's too, kept in the user's settings in the database; the default is
// one Lanes badge; the choice outlives a reload and a restart.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeConfig } from '../support/files.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(dbPath: string): Promise<TestApp> {
  const a = await startTestApp({ dbPath });
  apps.push(a);
  return a;
}

const session = (token: string) => ({ 'x-hopper-session': token });
const badges = async (a: TestApp, token: string) => (await a.api<{ badges: string[] }>('GET', '/api/header-badges', undefined, session(token))).body.badges;

describe('header badges (issue #1181)', () => {
  it('one Lanes badge until the user chooses; a viewer saves their own; the choice outlives a restart', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    writeConfig(db.dbPath, 'sign-in', { version: 1, none: { role: 'viewer' } });
    let a = await boot(db.dbPath);
    let viewer = (await a.ui<{ token: string }>('/ui/auth/none', {})).body.token;
    expect(await badges(a, viewer)).toEqual(['lanes']);

    const saved = await a.ui<{ badges: string[] }>('/ui/api/header-badges', { badges: ['failed', 'inFlight', 'failed'] }, { token: viewer });
    expect(saved.status).toBe(200);
    // In the cards' order, each once.
    expect(saved.body.badges).toEqual(['inFlight', 'failed']);
    expect(await badges(a, viewer)).toEqual(['inFlight', 'failed']);
    expect((await a.ui('/ui/api/header-badges', { badges: [] }, { token: viewer })).status).toBe(200);
    expect(await badges(a, viewer)).toEqual([]);
    expect((await a.ui('/ui/api/header-badges', { badges: ['lanes', 'waiting'] }, { token: viewer })).status).toBe(200);

    expect((await a.ui('/ui/api/header-badges', { badges: ['uptime'] }, { token: viewer })).status).toBe(400);
    expect((await a.ui('/ui/api/header-badges', {}, { token: viewer })).status).toBe(400);
    expect(await badges(a, viewer)).toEqual(['lanes', 'waiting']);

    await a.stop();
    apps.splice(0);
    a = await boot(db.dbPath);
    viewer = (await a.ui<{ token: string }>('/ui/auth/none', {})).body.token;
    expect(await badges(a, viewer)).toEqual(['lanes', 'waiting']);
  });
});
