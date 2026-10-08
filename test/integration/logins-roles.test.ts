// Issue #477: what the Logins view reads. A login's URL and code go only to a UI session whose role may act on
// it (operator or admin): a viewer's session reads the login without them, as a loopback read does. The
// warning before a code runs out is the user's setting (`warnSec`, admin), read with the logins.
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeConfig } from '../support/files.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 100 } }];
const CODE = 'WDJB-MJHT';
const AUTH: FakeTurn = {
  output: ['● gh waits for a login.', '  HOPPER_AUTH_PENDING', '  tool: gh', '  url: https://github.com/login/device', `  code: ${CODE}`, '  expires_in: 900'],
  background: { work: '1 shell', polls: 1_000_000 },
};

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(signIn?: unknown): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  if (signIn) writeConfig(db.dbPath, 'sign-in', signIn);
  t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS }, seams: { herdr: createFakeHerdrClient({ session: 'jh-test', turns: [AUTH] }) } });
  return t;
}

const loginsOf = async (a: TestApp, token: string) =>
  (await a.api('GET', '/api/logins', undefined, { 'x-hopper-session': token })).body as { now: string; settings: Record<string, unknown>; logins: Record<string, unknown>[] };

describe('the logins as the Logins view reads them', () => {
  it('a viewer\'s session reads a pending login without its URL or code; an admin\'s reads them', async () => {
    const a = await start({ version: 1, local: { enabled: true }, none: { role: 'viewer' } });
    await a.pull({}, { executor: 'herdr-claude', prompt: 'Push the branch' });
    const admin = await a.login();
    await waitFor(async () => (await loginsOf(a, admin)).logins.some((l) => l.status === 'pending'), { timeoutMs: 8000 });
    expect((await loginsOf(a, admin)).logins[0]).toMatchObject({ userCode: CODE, verificationUrl: 'https://github.com/login/device' });

    const viewer = ((await a.ui('/ui/auth/none', {})).body as { token: string }).token;
    expect((await a.api('GET', '/ui/api/session', undefined, { 'x-hopper-session': viewer })).body).toMatchObject({ user: { role: 'viewer' } });
    const seen = await loginsOf(a, viewer);
    expect(seen.logins[0]).toMatchObject({ status: 'pending', tool: 'gh', codeKept: true });
    expect(seen.logins[0]).not.toHaveProperty('userCode');
    expect(seen.logins[0]).not.toHaveProperty('verificationUrl');
    const one = (await a.api('GET', `/api/logins/${String(seen.logins[0]!.id)}`, undefined, { 'x-hopper-session': viewer })).body;
    expect(one).not.toHaveProperty('userCode');
  });

  it('the warning before a code runs out is a setting: 60 seconds by default, changed by an admin, kept with onExpiry', async () => {
    const a = await start();
    const token = await a.login();
    expect((await loginsOf(a, token)).settings).toEqual({ onExpiry: 'fail', warnSec: 60 });
    expect((await a.ui('/ui/api/logins/settings', { warnSec: 120 }, { token })).body).toEqual({ onExpiry: 'fail', warnSec: 120 });
    expect((await a.ui('/ui/api/logins/settings', { onExpiry: 'hold' }, { token })).body).toEqual({ onExpiry: 'hold', warnSec: 120 });
    expect((await loginsOf(a, token)).settings).toEqual({ onExpiry: 'hold', warnSec: 120 });
    expect((await a.ui('/ui/api/logins/settings', { warnSec: 0 }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/logins/settings', {}, { token })).status).toBe(400);
  });
});
