// Issue #476: a herdr-claude job that waits on a device login goes to the logins, never to the questions. Its URL
// and code reach only a UI session of the user; no event, progress line or question carries them. The job waits
// without nudges; Claude going on completes the login. Expiry fails the job (or holds it), cancel and a new code
// are typed into its pane, and a second code for the same tool updates the login.
import { afterEach, describe, expect, it } from 'vitest';
import type { EscalationLevel, SourceItem } from '../../src/domain/ports.ts';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 100 } }];
const CODE = 'WDJB-MJHT';
const DONE: FakeTurn = { steps: ['● Pushing'], output: ['● Pushed the branch.', '  HOPPER_DONE'] };

/** A turn that ends on a login while gh waits in the background; the work wakes Claude after `polls` polls, unless never. */
const authTurn = (o: { code?: string; expiresIn?: number; polls?: number; wakes?: boolean } = {}): FakeTurn => ({
  output: [
    '● Bash(gh auth login --web &)',
    `  ⎿  ! First copy your one-time code: ${o.code ?? CODE}`,
    '     Open this URL to continue in your web browser: https://github.com/login/device',
    '● gh waits for a login.',
    '  HOPPER_AUTH_PENDING',
    '  tool: gh',
    '  url: https://github.com/login/device',
    `  code: ${o.code ?? CODE}`,
    `  expires_in: ${o.expiresIn ?? 900}`,
  ],
  background: { work: '1 shell', polls: o.polls ?? 1_000_000, ...(o.wakes === false ? { wakes: false } : {}) },
});

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

const item = (over: Partial<SourceItem> = {}) => ({ executor: 'herdr-claude', prompt: 'Push the branch', ...over });

async function loginsOf(a: TestApp, token?: string) {
  return (await a.api('GET', '/api/logins', undefined, token ? { 'x-hopper-session': token } : {})).body as { now: string; logins: Record<string, unknown>[] };
}

async function pendingLogin(a: TestApp) {
  await waitFor(async () => (await loginsOf(a)).logins.some((l) => l.status === 'pending'), { timeoutMs: 8000 });
  return (await loginsOf(a)).logins[0]!;
}

describe('a job that waits on a device login', () => {
  it('goes to the logins, never the questions; the URL and code reach only a UI session; Claude going on completes it and the job finishes', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [authTurn({ polls: 60 }), DONE] });
    const a = await start(herdr);
    const job = await a.pull({}, item());
    const login = await pendingLogin(a);
    expect(login).toMatchObject({ kind: 'device_code', tool: 'gh', status: 'pending', jobId: job.id, run: 'herdr-claude', renewable: true, codeKept: true });
    expect(login).not.toHaveProperty('userCode');
    const token = await a.login();
    const seen = (await loginsOf(a, token)).logins[0]!;
    expect(seen).toMatchObject({ verificationUrl: 'https://github.com/login/device', userCode: CODE });
    expect((await a.api('GET', `/api/logins/${String(login.id)}`, undefined, { 'x-hopper-session': token })).body).toMatchObject({ userCode: CODE });
    expect((await a.api('GET', `/api/logins/${String(login.id)}`)).body).not.toHaveProperty('userCode');
    expect((await a.job(job.id)).status).toBe('running');

    await a.waitForStatus(job.id, 'finished', 8000);
    expect(await a.questionsOf(job.id)).toEqual([]);
    expect(herdr.prompts).toHaveLength(1);
    const after = (await loginsOf(a, token)).logins[0]!;
    expect(after).toMatchObject({ status: 'completed', codeKept: false });
    expect(after).not.toHaveProperty('userCode');
    const events = (await a.events()).filter((e) => e.jobId === job.id);
    expect(events.map((e) => e.type).filter((type) => type.startsWith('auth.') || type.startsWith('question.'))).toEqual(['auth.pending', 'auth.completed']);
    expect(events.find((e) => e.type === 'auth.pending')!.data).toMatchObject({ loginId: login.id, kind: 'device_code', tool: 'gh', run: 'herdr-claude' });
    // Not in any event — the webhook body is the event —, nor in the job's progress.
    expect(JSON.stringify(await a.events())).not.toContain(CODE);
    expect(JSON.stringify(await a.job(job.id))).not.toContain(CODE);
  });

  it('expiry with no word from the machine fails the job, its reason the expiry; the expired login then ends with it (issue #529)', async () => {
    const a = await start(createFakeHerdrClient({ session: 'jh-test', turns: [authTurn({ expiresIn: 1, wakes: false }), DONE] }));
    const job = await a.pull({}, item());
    const failed = await a.waitForStatus(job.id, 'failed', 8000);
    expect(failed.error).toMatch(/the gh login expired at .* before it was completed/);
    // Nothing waits on it any more: it leaves the open logins, so no Cancel or New code is offered that does nothing.
    const login = await waitFor(async () => { const l = (await loginsOf(a)).logins[0]!; return l.status === 'failed' ? l : undefined; }, { timeoutMs: 8000 });
    expect(login.reason).toMatch(/^the job ended/);
    const types = (await a.events()).filter((e) => e.jobId === job.id).map((e) => e.type).filter((x) => x.startsWith('auth.'));
    expect(types).toEqual(['auth.pending', 'auth.expired', 'auth.failed']);
  });

  it('with onExpiry hold, the expired login waits for a new code, which the same login takes', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [authTurn({ expiresIn: 1, wakes: false }), authTurn({ code: 'QRST-2345', polls: 60 }), DONE] });
    const a = await start(herdr);
    const token = await a.login();
    expect((await a.ui('/ui/api/logins/settings', { onExpiry: 'hold' }, { token })).body).toEqual({ onExpiry: 'hold', warnSec: 60 });
    const job = await a.pull({}, item());
    const login = await pendingLogin(a);
    await waitFor(async () => (await loginsOf(a)).logins[0]!.status === 'expired', { timeoutMs: 8000 });
    expect((await a.job(job.id)).status).toBe('running');
    expect((await a.ui(`/ui/api/logins/${String(login.id)}/new-code`, {}, { token })).status).toBe(200);
    await waitFor(() => herdr.prompts.length === 2, { timeoutMs: 8000 });
    expect(herdr.prompts[1]!.text).toContain('asked for a new code for the gh login');
    await waitFor(async () => (await loginsOf(a, token)).logins[0]!.userCode === 'QRST-2345', { timeoutMs: 8000 });
    const logins = (await loginsOf(a, token)).logins;
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ id: login.id, status: 'pending' });
    await a.waitForStatus(job.id, 'finished', 8000);
    const pending = (await a.events()).filter((e) => e.type === 'auth.pending');
    expect(pending.map((e) => e.data.renewed)).toEqual([undefined, true]);
  });

  it('cancel ends the login and tells the job, which goes on', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [authTurn(), DONE] });
    const a = await start(herdr);
    const job = await a.pull({}, item());
    const login = await pendingLogin(a);
    const token = await a.login();
    expect((await a.ui(`/ui/api/logins/${String(login.id)}/cancel`, {}, { token })).body).toMatchObject({ status: 'cancelled' });
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.prompts[1]!.text).toContain('The user cancelled the gh login');
    expect((await loginsOf(a, token)).logins[0]).toMatchObject({ status: 'cancelled', codeKept: false });
    expect((await a.ui(`/ui/api/logins/${String(login.id)}/cancel`, {}, { token })).status).toBe(409);
    expect((await a.events()).filter((e) => e.type.startsWith('auth.')).map((e) => e.type)).toEqual(['auth.pending', 'auth.cancelled']);
  });

  it('a login the job reports without its code is said back to it, never taken; a job cancelled while it waits fails the login', async () => {
    const noCode = { ...authTurn(), output: authTurn().output.filter((l) => !l.includes('code: ')) };
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [noCode, authTurn()] });
    const a = await start(herdr);
    const job = await a.pull({}, item());
    await waitFor(() => herdr.prompts.length === 2, { timeoutMs: 8000 });
    expect(herdr.prompts[1]!.text).toContain('could not be taken: a device login needs the code to enter');
    const login = await pendingLogin(a);
    const token = await a.login();
    expect((await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token })).status).toBe(200);
    await waitFor(async () => (await loginsOf(a)).logins[0]!.status === 'failed', { timeoutMs: 8000 });
    expect((await loginsOf(a)).logins[0]).toMatchObject({ id: login.id, reason: expect.stringContaining('the job ended') });
  });
});

describe('an escalation level\'s run that waits on a login', () => {
  it('reports it with the question, never as an answer or a question of its own; the run failing climbs the question as any error does', async () => {
    const level: EscalationLevel = {
      name: 'opus',
      async answer(req) {
        const id = req.logins!.report({ kind: 'device_code', tool: 'gh', verificationUrl: 'https://github.com/login/device', userCode: CODE, expiresAt: new Date(Date.now() + 900_000).toISOString() }, { renewable: false });
        req.logins!.failed(id, 'the run ended: claude exited 1');
        return { error: 'claude exited 1' };
      },
    };
    const db = tempDbPath();
    cleanup = db.cleanup;
    t = await startTestApp({ dbPath: db.dbPath, seams: { levels: [level] } });
    const job = await t.pull({ op: 'ask', message: 'Which?' });
    const q = await t.waitForQuestion(job.id, (x) => x.tier === 'human');
    const [login] = (await loginsOf(t)).logins;
    expect(login).toMatchObject({ questionId: q.id, run: 'opus', renewable: false, status: 'failed', reason: 'the run ended: claude exited 1' });
    expect(login).not.toHaveProperty('jobId');
    expect(await t.questionsOf(job.id)).toHaveLength(1);
    expect((await t.events()).filter((e) => e.type.startsWith('auth.')).map((e) => [e.type, e.data.questionId])).toEqual([['auth.pending', q.id], ['auth.failed', undefined]]);
  });
});
