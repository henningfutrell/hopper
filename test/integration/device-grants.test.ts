// Issue #892: a grant minted by device approval. An agent with no credential asks for a grant and shows a user code; a
// person enters the code in Settings → API tokens, sees what the agent asks for, and approves or denies; the agent polls
// with its device code and gets the grant's first pair once. Real daemon, real HTTP server; OpenFGA is a double at its port.
//
// Feature: grants by device approval
//   Scenario: an agent asks, a person approves, the agent gets its pair once and refreshes it
//   Scenario: a person denies; the agent is told, and the request is gone
//   Scenario: the approval checks the ask as a mint does; an API token may not approve; an unknown code is 404
//   Scenario: the operator CLI shows, approves and denies a request
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { rawRequest } from '../support/http.ts';
import { runCli, type CliIo } from '../../src/cli.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) await c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: createFakeAuthorizationServer() } });
  return t;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any; text: string };
const parsed = (r: { status: number; text: string }): Answer => ({ status: r.status, text: r.text, body: r.text ? JSON.parse(r.text) : undefined });
const post = async (a: TestApp, path: string, body: unknown, token?: string): Promise<Answer> => parsed(await rawRequest(a.url, {
  method: 'POST', path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
}));
const ask = (a: TestApp, body: Record<string, unknown> = {}) => post(a, '/ui/auth/device-grant', { label: 'Grok Bot', holder: 'grok-bot', scopes: ['*:read'], ...body });
const poll = (a: TestApp, deviceCode: string) => post(a, '/ui/auth/device-grant/poll', { deviceCode });
async function person(a: TestApp, session: string, body: Record<string, unknown>): Promise<Answer> {
  const r = await a.ui('/ui/api/api-tokens', body, { token: session });
  return { status: r.status, body: r.body, text: JSON.stringify(r.body) };
}

describe('grants by device approval (issue #892)', () => {
  it('an agent asks, a person approves, and the agent gets the grant\'s first pair once', async () => {
    const a = await boot();
    const asked = await ask(a, { role: 'operator' });
    expect(asked.status, asked.text).toBe(200);
    const { deviceCode, userCode } = asked.body as { deviceCode: string; userCode: string };
    expect(asked.body).toMatchObject({ verificationPath: '/#users-access/api-tokens', verificationPathComplete: `/#users-access/api-tokens/${userCode}`, interval: 5 });

    const waiting = await poll(a, deviceCode);
    expect(waiting.status, waiting.text).toBe(200);
    expect(waiting.body).toMatchObject({ state: 'waiting', interval: 5 });

    const session = await a.login();
    const seen = await a.api('GET', `/api/api-tokens/device/${userCode}`, undefined, { 'x-hopper-session': session });
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body).toMatchObject({ userCode, ask: { label: 'Grok Bot', holder: 'grok-bot', role: 'operator', scopes: ['*:read'] } });
    expect(JSON.stringify(seen.body)).not.toContain(deviceCode);

    const approved = await person(a, session, { action: 'approve-device', code: userCode });
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body).toEqual({ userCode, state: 'approved' });

    const granted = await poll(a, deviceCode);
    expect(granted.status, granted.text).toBe(200);
    expect(granted.body).toMatchObject({
      state: 'granted', grant: expect.stringMatching(/^[0-9a-f]{16}$/), token: expect.stringMatching(/^hopper_at_/), refresh: expect.stringMatching(/^hopper_rt_/),
      view: { label: 'Grok Bot', holder: 'grok-bot', role: 'operator', scopes: ['*:read'], box: false },
    });
    expect((await rawRequest(a.url, { method: 'GET', path: '/api/queue', headers: { authorization: `Bearer ${granted.body.token}` } })).status).toBe(200);
    const refreshed = await post(a, '/ui/auth/token/refresh', { refresh: granted.body.refresh });
    expect(refreshed.status, refreshed.text).toBe(200);

    expect((await poll(a, deviceCode)).status).toBe(401);
    const listed = await a.api('GET', '/api/api-tokens', undefined, { 'x-hopper-session': session });
    expect(listed.body.grants).toEqual([expect.objectContaining({ id: granted.body.grant, holder: 'grok-bot' })]);
  });

  it('a person denies: the agent is told once, and the request is gone', async () => {
    const a = await boot();
    const { deviceCode, userCode } = (await ask(a)).body as { deviceCode: string; userCode: string };
    const session = await a.login();
    expect((await person(a, session, { action: 'deny-device', code: userCode })).body).toEqual({ userCode, state: 'denied' });
    const denied = await poll(a, deviceCode);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/denied/);
    expect((await poll(a, deviceCode)).status).toBe(401);
    expect((await a.api('GET', `/api/api-tokens/device/${userCode}`, undefined, { 'x-hopper-session': session })).status).toBe(404);
  });

  it('the approval checks the ask as a mint does; an API token may not approve; an unknown code is 404', async () => {
    const a = await boot();
    const session = await a.login();
    const bad = (await ask(a, { scopes: ['nope:read'] })).body as { userCode: string };
    const refused = await person(a, session, { action: 'approve-device', code: bad.userCode });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/nope:read/);

    const good = (await ask(a)).body as { deviceCode: string; userCode: string };
    const minted = await person(a, session, { action: 'mint', label: 'other', scopes: ['*'] });
    expect(minted.status, minted.text).toBe(200);
    const byToken = await post(a, '/ui/api/api-tokens', { action: 'approve-device', code: good.userCode }, minted.body.token);
    expect(byToken.status).toBe(403);
    expect((await poll(a, good.deviceCode)).body.state).toBe('waiting');

    expect((await person(a, session, { action: 'approve-device', code: 'BCDF-GHJK' })).status).toBe(404);
    expect((await a.api('GET', '/api/api-tokens/device/BCDF-GHJK', undefined, { 'x-hopper-session': session })).status).toBe(404);
    expect((await poll(a, `hopper_dc_${'0'.repeat(64)}`)).status).toBe(401);
  });

  it('the operator CLI shows, approves and denies a request', async () => {
    const a = await boot();
    const out: string[] = [];
    const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => undefined };
    const hopper = async (argv: string[]) => {
      out.length = 0;
      const code = await runCli([...argv, '--url', a.url], io);
      return { code, out: out.join('') };
    };
    const first = (await ask(a, { role: 'viewer' })).body as { deviceCode: string; userCode: string };
    const shown = await hopper(['token', 'device', first.userCode]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out)).toMatchObject({ userCode: first.userCode, ask: { label: 'Grok Bot', role: 'viewer' } });
    expect((await hopper(['token', 'approve', first.userCode])).code).toBe(0);
    // The CLI's session ends with the call: the grant is minted at the poll, for the CLI's user.
    expect((await poll(a, first.deviceCode)).body).toMatchObject({ state: 'granted', view: { role: 'viewer', holder: 'grok-bot' } });

    const second = (await ask(a)).body as { deviceCode: string; userCode: string };
    expect((await hopper(['token', 'deny', second.userCode])).code).toBe(0);
    expect((await poll(a, second.deviceCode)).status).toBe(403);
    expect((await hopper(['token', 'approve', second.userCode])).code).not.toBe(0);
  });
});
