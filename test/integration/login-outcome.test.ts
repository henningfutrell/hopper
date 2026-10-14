// Issue #1110: only the requester knows whether a login worked. A running job reports the outcome of its login
// (`POST /job/login`, its proxy token; `sh "$HOPPER_LOGIN"`), which ends the login with no person: completed, or
// failed with the reason. A failed re-check of a completed login reopens it with the reason. A person may dismiss an
// open login, an event; a resolved login leaves the active list.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Login } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { PROTOCOL_LINES } from '../../src/job-rules/index.ts';
import { LOGIN_SCRIPT } from '../../src/logins/script.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 100, promptSteadyMs: 100 } }];
const CODE = 'WDJB-MJHT';

/** A turn that ends on a codex login while it waits in the background, and stays so. */
const AUTH: FakeTurn = {
  output: [
    '● Bash(codex login --device-auth &)',
    '  ⎿  Follow these steps to sign in with ChatGPT using device code authorization:',
    '     1. Open this link in your browser and sign in to your account',
    '        https://auth.openai.com/codex/device',
    '     2. Enter this one-time code (expires in 15 minutes)',
    `        ${CODE}`,
    '● codex waits for a login.',
    '  HOPPER_AUTH_PENDING',
    '  tool: codex',
    '  url: https://auth.openai.com/codex/device',
    `  code: ${CODE}`,
    '  expires_in: 900',
  ],
  background: { work: '1 shell', polls: 1_000_000 },
};

async function start(herdr: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS }, seams: { herdr } });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/** A running job that waits on its codex login, the login, and the job's proxy token. */
async function waiting(a: TestApp) {
  const job = await a.pull({}, { executor: 'herdr-claude', prompt: 'Push the branch' });
  await waitFor(() => a.user().store.logins.list({ status: ['pending'] }).length > 0, { timeoutMs: 8000, what: 'the login reported' });
  const login = a.user().store.logins.list({ jobId: job.id })[0]!;
  const proxy = proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id);
  return { job, login, proxy };
}

/** What `hopper-login` sends: a form, the job's proxy token. */
const report = (a: TestApp, bearer: string, form: Record<string, string>) => fetch(`${a.url}/job/login`, {
  method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
});

const loginOf = (a: TestApp, id: string): Login => a.user().store.logins.get(id)!;

async function activeLogins(a: TestApp): Promise<number> {
  const r = await a.api('GET', '/api/sections');
  const s = (r.body as { sections: { kind: string; open: number }[] }).sections.find((x) => x.kind === 'logins');
  return s!.open;
}

describe('the requester reports the outcome of its login (issue #1110)', () => {
  it('completed: the login ends with no person, as the requester\'s word, and leaves the active list', async () => {
    const a = await start(createFakeHerdrClient({ session: 'jh-test', turns: [AUTH] }));
    const { login, proxy } = await waiting(a);
    expect(await activeLogins(a)).toBe(1);

    const r = await report(a, proxy, { outcome: 'completed', tool: 'codex' });
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/^ok: /);
    expect(loginOf(a, login.id)).toMatchObject({ status: 'completed' });
    const [done] = await a.events('types=auth.completed');
    expect(done!.data).toEqual({ loginId: login.id, kind: 'device_code', tool: 'codex', by: 'requester' });
    expect(await activeLogins(a)).toBe(0);
    // The run that waited on it hears it ended.
    expect(a.user().logins.check(login.id)).toEqual({ act: 'ended' });
  });

  it('failed while open: the login fails with the requester\'s reason', async () => {
    const a = await start(createFakeHerdrClient({ session: 'jh-test', turns: [AUTH] }));
    const { login, proxy } = await waiting(a);
    expect((await report(a, proxy, { outcome: 'failed', reason: 'codex says the token is invalid' })).status).toBe(200);
    expect(loginOf(a, login.id)).toMatchObject({ status: 'failed', reason: 'codex says the token is invalid' });
    const [failed] = await a.events('types=auth.failed');
    expect(failed!.data).toMatchObject({ loginId: login.id, reason: 'codex says the token is invalid', by: 'requester' });
  });

  it('a failed re-check of a completed login reopens it with the reason; a new code is then the same login', async () => {
    const a = await start(createFakeHerdrClient({ session: 'jh-test', turns: [AUTH] }));
    const { job, login, proxy } = await waiting(a);
    await report(a, proxy, { outcome: 'completed', tool: 'codex' });
    const r = await report(a, proxy, { outcome: 'failed', tool: 'codex', reason: 'codex login status: not logged in' });
    expect(r.status).toBe(200);
    expect(loginOf(a, login.id)).toMatchObject({ status: 'pending', reason: 'codex login status: not logged in' });
    expect(loginOf(a, login.id).endedAt).toBeUndefined();
    const [reopened] = await a.events('types=auth.reopened');
    expect(reopened!.data).toEqual({ loginId: login.id, kind: 'device_code', tool: 'codex', reason: 'codex login status: not logged in' });
    expect(await activeLogins(a)).toBe(1);
    expect(a.user().logins.view(loginOf(a, login.id), true)).toMatchObject({ codeKept: false });

    // The job reports a new code: the same login takes it.
    a.user().logins.report({ kind: 'device_code', tool: 'codex', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: new Date(Date.now() + 900_000).toISOString() },
      { jobId: job.id, run: 'herdr-claude', renewable: true });
    expect(a.user().store.logins.list({ jobId: job.id })).toHaveLength(1);
    expect(a.user().logins.view(loginOf(a, login.id), true)).toMatchObject({ status: 'pending', codeKept: true, userCode: 'ABCD-EFGH' });

    // It went through this time.
    await report(a, proxy, { outcome: 'completed' });
    expect(loginOf(a, login.id)).toMatchObject({ status: 'completed' });
    expect(loginOf(a, login.id).reason).toBeUndefined();
  });

  it('a late success completes a login the sweep failed; a failure of a failed login changes nothing', async () => {
    const a = await start(createFakeHerdrClient({ session: 'jh-test', turns: [AUTH] }));
    const { login, proxy } = await waiting(a);
    a.user().logins.failed(login.id, 'the run could not take it');
    expect((await report(a, proxy, { outcome: 'failed', reason: 'still no' })).status).toBe(200);
    expect(loginOf(a, login.id)).toMatchObject({ status: 'failed', reason: 'the run could not take it' });
    expect(await report(a, proxy, { outcome: 'completed' }).then((r) => r.status)).toBe(200);
    expect(loginOf(a, login.id)).toMatchObject({ status: 'completed' });
  });

  it('refuses a token that is no running job\'s, a bad call, and a job with no such login', async () => {
    const a = await start(createFakeHerdrClient({ session: 'jh-test', turns: [AUTH] }));
    const { proxy } = await waiting(a);
    expect((await report(a, 'nope', { outcome: 'completed' })).status).toBe(401);
    const bad = await report(a, proxy, { outcome: 'maybe' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/^no: /);
    expect((await report(a, proxy, { outcome: 'failed' })).status).toBe(400);
    const none = await report(a, proxy, { outcome: 'completed', tool: 'gcloud' });
    expect(none.status).toBe(404);
    expect(await none.text()).toContain('gcloud');
  });
});

/** Runs `hopper-login` as a job does: the script and the job's proxy token in a credentials dir. */
function hopperLogin(url: string, proxy: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'job-credentials-'));
  writeFileSync(join(dir, 'token'), `${proxy}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'login'), LOGIN_SCRIPT, { mode: 0o700 });
  return new Promise((resolve) => {
    execFile('sh', [join(dir, 'login'), ...args], {
      cwd: dir, env: { PATH: process.env.PATH, HOPPER_URL: url, HOPPER_TOKEN_FILE: join(dir, 'token'), TMPDIR: dir } as NodeJS.ProcessEnv, encoding: 'utf8',
    }, (err, stdout) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout }));
  });
}

describe('hopper-login, the job\'s command (issue #1110)', () => {
  it('the job rules tell a job to say what came of its login', () => {
    const line = PROTOCOL_LINES.find((l) => l.includes('HOPPER_AUTH_PENDING'))!;
    expect(line).toContain('sh "$HOPPER_LOGIN" completed <tool>');
    expect(line).toContain('sh "$HOPPER_LOGIN" failed <tool> --reason');
  });

  it('completes the job\'s login, reopens it with a reason, and refuses a bad call', async () => {
    const a = await start(createFakeHerdrClient({ session: 'jh-test', turns: [AUTH] }));
    const { login, proxy } = await waiting(a);
    const done = await hopperLogin(a.url, proxy, ['completed', 'codex']);
    expect(done).toEqual({ code: 0, stdout: 'ok: the codex login is completed\n' });
    expect(loginOf(a, login.id).status).toBe('completed');
    const again = await hopperLogin(a.url, proxy, ['failed', '--reason', 'gh auth status: not logged in']);
    expect(again.code).toBe(0);
    expect(loginOf(a, login.id)).toMatchObject({ status: 'pending', reason: 'gh auth status: not logged in' });
    expect((await hopperLogin(a.url, proxy, ['failed'])).code).toBe(2);
    expect((await hopperLogin(a.url, proxy, ['done'])).code).toBe(2);
    const none = await hopperLogin(a.url, proxy, ['completed', 'gcloud']);
    expect(none.code).toBe(1);
    expect(none.stdout).toMatch(/^no: /);
  });
});

describe('a person dismisses a login (issue #1110)', () => {
  it('ends an open login as dismissed, an event, and the run hears it ended; an ended login cannot be dismissed', async () => {
    const a = await start(createFakeHerdrClient({ session: 'jh-test', turns: [AUTH] }));
    const { login } = await waiting(a);
    const token = await a.login();
    const r = await a.ui<Login>(`/ui/api/logins/${login.id}/dismiss`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: login.id, status: 'dismissed' });
    const [dismissed] = await a.events('types=auth.dismissed');
    expect(dismissed!.data).toEqual({ loginId: login.id, kind: 'device_code', tool: 'codex', by: 'user' });
    expect(a.user().logins.check(login.id)).toEqual({ act: 'ended' });
    expect(await activeLogins(a)).toBe(0);
    expect((await a.ui(`/ui/api/logins/${login.id}/dismiss`, {}, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/logins/nope/dismiss', {}, { token })).status).toBe(404);
  });
});
