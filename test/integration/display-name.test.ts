// The instance's display name (issue #465, design.md "The instance's display name"): Settings → Version, the hopper's
// admin's. The instance id it shows beside it is made once and kept in the database. A real daemon over the real database.
//   Scenario: a fresh hopper shows its instance id and no display name; the admin sets, changes and clears the name; the
//     name and the id are kept across a restart; each change is an event
//   Scenario: a body that is not `{ displayName: string }` of 80 characters at most, after trimming, is 400
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

type View = { instanceId: string; displayName: string };

describe("the instance's display name", () => {
  it('shows the instance id and no name at first; the admin sets, changes and clears it; both are kept across a restart; each change is an event', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({ dbPath: db.dbPath });
    let token = await t.login();
    const view = async (): Promise<View> => (await t!.api('GET', '/api/display-name', undefined, { 'x-hopper-session': token })).body as View;
    const first = await view();
    expect(first.instanceId).toMatch(/^[0-9a-f]{16}$/);
    expect(first.displayName).toBe('');

    expect(await t.ui<View>('/ui/api/display-name', { displayName: '  Home box  ' }, { token })).toMatchObject({ status: 200, body: { instanceId: first.instanceId, displayName: 'Home box' } });
    expect((await t.ui('/ui/api/display-name', { displayName: 'Home box' }, { token })).status).toBe(200);
    expect((await t.ui<View>('/ui/api/display-name', { displayName: 'Lab' }, { token })).body.displayName).toBe('Lab');
    expect((await t.events('types=display_name.changed')).map((e) => e.data)).toEqual([
      { from: '', to: 'Home box', by: expect.any(String) },
      { from: 'Home box', to: 'Lab', by: expect.any(String) },
    ]);

    await t.stop();
    t = await startTestApp({ dbPath: db.dbPath });
    token = await t.login();
    expect(await view()).toEqual({ instanceId: first.instanceId, displayName: 'Lab' });
    expect((await t.ui<View>('/ui/api/display-name', { displayName: '' }, { token })).body).toEqual({ instanceId: first.instanceId, displayName: '' });
    expect(await view()).toEqual({ instanceId: first.instanceId, displayName: '' });
  });

  it('refuses a body that is not { displayName: string } of 80 characters at most', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({ dbPath: db.dbPath });
    const token = await t.login();
    for (const bad of [{}, { displayName: 3 }, { displayName: 'x', extra: 1 }, { displayName: 'x'.repeat(81) }, { displayName: 'a\nb' }]) {
      expect((await t.ui('/ui/api/display-name', bad, { token })).status, JSON.stringify(bad)).toBe(400);
    }
  });
});
