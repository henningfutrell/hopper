// The source email match (issue #1380, design.md "The source email match"): an instance setting, on by default, that the
// hopper's admin turns off in Settings → Sign-in. A real daemon over the real database.
//   Scenario: a fresh hopper has it on; the admin turns it off and on; it is kept across a restart; each change is an event
//   Scenario: a body that is not `{ on: boolean }` is 400
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

describe('the source email match setting', () => {
  it('is on by default; the admin turns it off and on; it is kept across a restart; each change is an event', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({ dbPath: db.dbPath });
    let token = await t.login();
    const view = async () => (await t!.api('GET', '/api/source-email-match', undefined, { 'x-hopper-session': token })).body;
    expect(await view()).toEqual({ on: true });

    const off = await t.ui<{ on: boolean }>('/ui/api/source-email-match', { on: false }, { token });
    expect(off).toMatchObject({ status: 200, body: { on: false } });
    expect((await t.ui('/ui/api/source-email-match', { on: false }, { token })).status).toBe(200);
    expect((await t.events('types=source_email_match.changed')).map((e) => e.data)).toEqual([{ on: false, by: expect.any(String) }]);

    await t.stop();
    t = await startTestApp({ dbPath: db.dbPath });
    token = await t.login();
    expect(await view()).toEqual({ on: false });
    expect((await t.ui('/ui/api/source-email-match', { on: true }, { token })).body).toEqual({ on: true });
    expect(await view()).toEqual({ on: true });
  });

  it('refuses a body that is not { on: boolean }', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({ dbPath: db.dbPath });
    const token = await t.login();
    for (const bad of [{}, { on: 'off' }, { on: true, extra: 1 }]) {
      expect((await t.ui('/ui/api/source-email-match', bad, { token })).status, JSON.stringify(bad)).toBe(400);
    }
  });
});
