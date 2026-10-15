// Usage and accounts through the real daemon (design.md "Usage and accounts (issue #18)"):
// the claude-plan usage source against a fake `claude` (never the real one) throttles lanes
// through the decider; GET /api/usage reports readings, source states, limits and the lane
// effect per machine; GET /api/accounts names who each part acts as — the Claude account and
// the GitHub identities of the job sources — and never a token.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { CONNECTED_VIA, NOT_SIGNED_IN, SIGNED_IN_ANSWER, SIGNED_IN_BY, type Job, type LoginView, type Question, type PartAccount, type ToolAccount, type UsageReport } from '../../src/domain/types.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { NO_ASSIGNEE } from '../../src/sources/compose.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { appSecrets, BOT, jobSourcesDoc } from '../support/github-app.ts';
import { waitFor } from '../support/wait.ts';

const FAKE_CLAUDE = join(import.meta.dirname, '..', 'plugins', 'fake-claude-plan.mjs');
const REPO = 'owner/hopper-sandbox';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
const saved = process.env.FAKE_PLAN_DIR;
let control: string;

beforeEach(() => {
  control = mkdtempSync(join(tmpdir(), 'jh-fake-plan-'));
  process.env.FAKE_PLAN_DIR = control;
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
  if (saved === undefined) delete process.env.FAKE_PLAN_DIR; else process.env.FAKE_PLAN_DIR = saved;
});

/** `Oct 5, 9am (UTC)` two days from now, so no window has reset during the test. */
function resetsIn2Days(): string {
  const d = new Date(Date.now() + 2 * 86_400_000);
  return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}, 9am (UTC)`;
}

type Plugins = Record<string, unknown>;

async function boot(o: { plugins: Plugins; secrets?: Record<string, string | undefined>; seams?: Parameters<typeof startTestApp>[0]['seams'] }) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: o.plugins, ...(o.secrets ? { secrets: o.secrets } : {}), ...(o.seams ? { seams: o.seams } : {}) });
  apps.push(a);
  return a;
}

const usage = async (a: TestApp) => (await a.api<UsageReport>('GET', '/api/usage')).body;
const accounts = async (a: TestApp) => (await a.api<{ accounts: PartAccount[] }>('GET', '/api/accounts')).body.accounts;

describe('claude-plan through the composition root', () => {
  it('a session at 80% caps 4 lanes at 2; the week of one model at 99% does not throttle; GET /api/usage says so', async () => {
    const when = resetsIn2Days();
    writeFileSync(join(control, 'result.txt'), [
      'You are currently using your subscription to power your Claude Code usage', '',
      `Current session: 80% used · resets ${when}`,
      `Current week (all models): 30% used · resets ${when}`,
      `Current week (Fable): 99% used · resets ${when}`,
    ].join('\n'));
    // The scripted executor runs the pulled jobs and stands in for Claude Code: the budget names it.
    const a = await boot({ plugins: { machines: lanes(4), usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE, executors: ['scripted'] } }] } });

    const report = await waitFor(async () => { const u = await usage(a); return u.readings.some((r) => r.source === 'claude') && u.sources[0]?.account ? u : undefined; }, { what: 'claude readings and account' });
    expect(report.readings.filter((r) => r.source === 'claude').map((r) => [r.window, r.used, r.limit, r.unit, r.informational ?? false])).toEqual([
      ['session', 80, 100, '%', false], ['week', 30, 100, '%', false], ['week (Fable)', 99, 100, '%', true],
    ]);
    expect(report.sources).toEqual([
      { name: 'claude', refreshedAt: expect.any(String), accountReadAt: expect.any(String), executors: ['scripted'], signIn: true, account: { service: 'claude', identity: 'user@example.com', detail: { plan: 'max', organization: 'Example Org', authMethod: 'claude.ai', machine: 'local' } } },
      { name: 'fake' },
    ]);
    expect(report.limits).toEqual({ soft: 0.7, hard: 0.95, defaults: { soft: 0.7, hard: 0.95 }, set: false });
    // The machine's lanes stay open for its other executor; the scripted executor's jobs are capped at 2.
    expect(report.machines).toEqual([{
      machineId: 'local', label: expect.any(String), online: true, maxLanes: 4, usedFrac: 0, cap: 4, band: 'free',
      executors: [{ executor: 'test', usedFrac: 0, cap: 4, band: 'free' }, { executor: 'scripted', usedFrac: 0.8, cap: 2, band: 'soft' }],
    }]);

    const jobs: Job[] = [];
    for (let i = 0; i < 4; i++) jobs.push(await a.pull({ op: 'sleep', ms: 3000 }));
    await waitFor(async () => (await a.api('GET', '/api/queue')).body.running.length === 2, { what: 'two running' });
    const held = await waitFor(async () => { const j = await a.job(jobs[3]!.id); return j.waitReason ? j : undefined; });
    expect(held).toMatchObject({ status: 'queued', waitReason: expect.stringContaining('executor scripted\'s lane cap on local is 2 (usage soft limit') });
    expect((await a.api('GET', '/api/queue')).body.running).toHaveLength(2);

    const plugins = (await a.api('GET', '/api/plugins')).body;
    expect(plugins.usageSources.instances).toEqual([expect.objectContaining({ instance: expect.objectContaining({ name: 'claude', plugin: 'claude-plan' }), active: 'claude-plan' })]);
  });

  it('GET /api/accounts: the Claude account the usage source reads for — email, plan, organization; never an id or a token', async () => {
    const a = await boot({ plugins: { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] } });
    const list = await waitFor(async () => { const l = await accounts(a); return l.some((x) => x.service === 'claude') ? l : undefined; }, { what: 'the claude account' });
    expect(list).toEqual([{ role: 'usage-source', instance: 'claude', service: 'claude', identity: 'user@example.com', detail: { plan: 'max', organization: 'Example Org', authMethod: 'claude.ai', machine: 'local' } }]);
    const raw = JSON.stringify(await a.api('GET', '/api/accounts'));
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('org-1');
  });

  it('claude unavailable: no claude readings, the reason in GET /api/usage, lanes uncapped', async () => {
    writeFileSync(join(control, 'mode'), 'header-only');
    const a = await boot({ plugins: { machines: lanes(4), usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] } });
    const report = await waitFor(async () => { const u = await usage(a); return u.sources[0]?.problem !== 'not read yet' ? u : undefined; }, { what: 'the first read' });
    expect(report.sources[0]).toMatchObject({ name: 'claude', problem: expect.stringMatching(/^usage unavailable: /) });
    expect(report.readings.filter((r) => r.source === 'claude')).toEqual([]);
    expect(report.machines[0]).toMatchObject({ cap: 4, band: 'free' });
  });
});

const toolAccounts = async (a: TestApp) => (await a.api<{ accounts: ToolAccount[] }>('GET', '/api/tool-accounts')).body.accounts;

async function hopper(a: TestApp, argv: string[], stdin = '') {
  const out: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => stdin, out: (x) => out.push(x), err: () => {} };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join('') };
}

describe('tool accounts (issue #1128)', () => {
  it('GET /api/tool-accounts: the Claude account, the machine signed in as it, its week windows; hopper accounts prints the same; never a token', async () => {
    const when = resetsIn2Days();
    writeFileSync(join(control, 'result.txt'), [`Current session: 80% used · resets ${when}`, `Current week (all models): 30% used · resets ${when}`].join('\n'));
    const a = await boot({ plugins: { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE, executors: ['scripted'] } }] } });
    const list = await waitFor(async () => { const l = await toolAccounts(a); return l[0]?.spend.length ? l : undefined; }, { what: 'the tool account and its spend' });
    expect(list).toEqual([{
      service: 'claude', identity: 'user@example.com', detail: { plan: 'max', organization: 'Example Org', authMethod: 'claude.ai' }, login: 'signed-in',
      machines: [{ machineId: 'local', label: expect.any(String), source: 'claude', login: 'signed-in', readAt: expect.any(String), signIn: true }],
      spend: [expect.objectContaining({ source: 'claude', window: 'week', used: 30, limit: 100, unit: '%', machineId: 'local' })],
    }]);
    const raw = JSON.stringify(list);
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('org-1');

    const out = await hopper(a, ['accounts']);
    expect(out.code).toBe(0);
    expect((JSON.parse(out.out) as { accounts: ToolAccount[] }).accounts.map((x) => [x.identity, x.login])).toEqual([['user@example.com', 'signed-in']]);
    expect((await hopper(a, ['accounts', 'extra'])).code).toBe(2);
  });

  it('a machine whose claude is signed out: an entry with no identity, signed out, why, and that no account is known there (issue #1269)', async () => {
    writeFileSync(join(control, 'mode'), 'logged-out');
    const a = await boot({ plugins: { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] } });
    const list = await waitFor(async () => { const l = await toolAccounts(a); return l.length ? l : undefined; }, { what: 'the signed-out machine' });
    expect(list).toEqual([{ service: 'claude', detail: {}, login: 'signed-out', spend: [],
      machines: [{ machineId: 'local', label: expect.any(String), source: 'claude', login: 'signed-out', problem: 'not logged in', readAt: expect.any(String), signIn: true, lastAccount: null }] }]);
  });
});

describe('tool sign-in (issue #1128)', () => {
  const pendingSignIn = async (a: TestApp, token: string) => {
    const r = await a.ui<LoginView>('/ui/api/tool-accounts/sign-in', { source: 'claude' }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'paste_code', tool: 'claude', status: 'pending', run: 'sign-in', machineId: 'local', renewable: false, host: 'claude.com' });
    // The URL only to a UI session's read, never in the start's answer.
    expect(r.body.verificationUrl).toBeUndefined();
    return r.body;
  };

  it('a signed-out machine is signed in again from the hopper: its URL to a UI session, the code pasted back, the account read again', async () => {
    writeFileSync(join(control, 'mode'), 'logged-out');
    const a = await boot({ plugins: { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] } });
    await waitFor(async () => ((await toolAccounts(a))[0]?.login === 'signed-out' ? true : undefined), { what: 'the signed-out machine' });
    const token = await a.login();
    const login = await pendingSignIn(a, token);
    const read = (await a.api<LoginView>('GET', `/api/logins/${login.id}`, undefined, { 'x-hopper-session': token })).body;
    expect(read).toMatchObject({ verificationUrl: 'https://claude.com/cai/oauth/authorize?code=true&state=fake', codeKept: true });
    expect(read.userCode).toBeUndefined();
    // Without a session (the loopback read): no URL.
    expect((await a.api<LoginView>('GET', `/api/logins/${login.id}`)).body.verificationUrl).toBeUndefined();

    const done = await a.ui<LoginView>(`/ui/api/logins/${login.id}/code`, { code: 'good-code' }, { token });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: login.id, status: 'completed' });
    const list = await waitFor(async () => { const l = await toolAccounts(a); return l[0]?.login === 'signed-in' ? l : undefined; }, { what: 'the account read again' });
    expect(list[0]).toMatchObject({ identity: 'user@example.com', machines: [expect.objectContaining({ machineId: 'local', login: 'signed-in' })] });
    const types = (await a.events('types=auth.pending,auth.completed')).map((e) => [e.type, e.machineId, e.data.kind, e.data.run]);
    expect(types).toEqual(expect.arrayContaining([['auth.pending', 'local', 'paste_code', 'sign-in'], ['auth.completed', 'local', 'paste_code', undefined]]));
    expect(JSON.stringify(await a.events())).not.toContain('good-code');
  });

  it('a job held because claude is signed out on its machine goes on once the sign-in from the hopper completes; another question stays', async () => {
    writeFileSync(join(control, 'mode'), 'logged-out');
    // The source limits another executor's jobs: the scripted jobs stand in for ones placed before the read said signed out.
    const a = await boot({ plugins: { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE, executors: ['herdr-claude'] } }] } });
    const token = await a.login();
    const held = await a.pull({ op: 'ask', message: `${NOT_SIGNED_IN}.\n\nA hard screen` });
    const other = await a.pull({ op: 'ask', message: 'Is this risky?' });
    const q = await a.waitForQuestion(held.id, (x) => x.tier === 'human');
    expect(q.raisedBy?.machineId).toBe('local');
    const kept = await a.waitForQuestion(other.id, (x) => x.tier === 'human');
    const login = await pendingSignIn(a, token);
    expect((await a.ui<LoginView>(`/ui/api/logins/${login.id}/code`, { code: 'good-code' }, { token })).body.status).toBe('completed');
    const answered = await a.waitForQuestion(held.id, (x) => x.status === 'answered');
    expect(answered).toMatchObject({ answeredBy: SIGNED_IN_BY, answer: SIGNED_IN_ANSWER });
    expect((await a.waitForStatus(held.id, 'finished')).result).toEqual({ answer: SIGNED_IN_ANSWER });
    expect((await a.api<Question>('GET', `/api/questions/${kept.id}`)).body.status).toBe('open');
    expect(answered.attempts.at(-1)).toMatchObject({ tier: SIGNED_IN_BY, role: 'fixed', outcome: 'accepted' });
    expect(answered.attempts.at(-1)!.reason).toContain(login.id);
    const settled = (await a.events('types=question.answered')).filter((e) => e.jobId === held.id);
    expect(settled.map((e) => e.data.by)).toEqual([SIGNED_IN_BY]);
  });

  it('failover (part 5): a machine signed out takes no new job of its executors; the job is held with why, and starts once it is signed in', async () => {
    writeFileSync(join(control, 'mode'), 'logged-out');
    const a = await boot({ plugins: { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE, executors: ['scripted'] } }] } });
    await waitFor(async () => ((await toolAccounts(a))[0]?.login === 'signed-out' ? true : undefined), { what: 'the signed-out machine' });
    const token = await a.login();
    const job = await a.pull({ op: 'echo', message: 'hi' });
    const held = await waitFor(async () => { const j = (await a.api<Job>('GET', `/api/jobs/${job.id}`)).body; return j.holdReason ? j : undefined; }, { what: 'the hold' });
    expect(held).toMatchObject({ status: 'held', holdReason: 'no machine running executor scripted is signed in: local (claude signed out): sign it in from Accounts' });
    const login = await pendingSignIn(a, token);
    expect((await a.ui<LoginView>(`/ui/api/logins/${login.id}/code`, { code: 'good-code' }, { token })).body.status).toBe('completed');
    await a.waitForStatus(job.id, 'finished');
  });

  it('a wrong code fails the login with the tool\'s reason; a new sign-in cancels the one before; a code to an ended one is 409', async () => {
    writeFileSync(join(control, 'mode'), 'logged-out');
    const a = await boot({ plugins: { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] } });
    const token = await a.login();
    const first = await pendingSignIn(a, token);
    const failed = await a.ui<LoginView>(`/ui/api/logins/${first.id}/code`, { code: 'wrong-code' }, { token });
    expect(failed.body).toMatchObject({ status: 'failed', reason: 'Login failed: Request failed with status code 400' });
    expect((await a.ui(`/ui/api/logins/${first.id}/code`, { code: 'good-code' }, { token })).status).toBe(409);

    const second = await pendingSignIn(a, token);
    const third = await pendingSignIn(a, token);
    expect(a.user().store.logins.get(second.id)!.status).toBe('cancelled');
    expect((await a.ui(`/ui/api/logins/${third.id}/code`, { code: 'a b' }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/tool-accounts/sign-in', { source: 'nope' }, { token })).status).toBe(404);
    expect((await a.ui('/ui/api/tool-accounts/sign-in', { source: 'claude', email: 'not an email' }, { token })).status).toBe(400);
    expect((await a.ui(`/ui/api/logins/${third.id}/code`, { code: 'good-code' }, { token })).body).toMatchObject({ status: 'completed' });
  });

  it('after a restart the sign-in it waited on is gone: its login fails, to be started again', async () => {
    writeFileSync(join(control, 'mode'), 'logged-out');
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const plugins = { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] };
    const first = await startTestApp({ dbPath: db.dbPath, plugins });
    const login = await pendingSignIn(first, await first.login());
    await first.stop();
    const again = await startTestApp({ dbPath: db.dbPath, plugins });
    apps.push(again);
    const failed = await waitFor(() => { const l = again.user().store.logins.get(login.id); return l?.status === 'failed' ? l : undefined; }, { timeoutMs: 15000, what: 'the sign-in failed after the restart' });
    expect(failed.reason).toBe('the hopper restarted while the sign-in waited: start it again');
  });

  it('from the command line: hopper accounts sign-in, sign-in-url and code (on stdin)', async () => {
    writeFileSync(join(control, 'mode'), 'logged-out');
    const a = await boot({ plugins: { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] } });
    const started = await hopper(a, ['accounts', 'sign-in', 'claude']);
    expect(started.code).toBe(0);
    const login = JSON.parse(started.out) as LoginView;
    expect(login).toMatchObject({ kind: 'paste_code', status: 'pending', machineId: 'local' });
    const url = await hopper(a, ['accounts', 'sign-in-url', login.id]);
    expect(JSON.parse(url.out)).toEqual({ status: 'pending', expiresAt: login.expiresAt, url: 'https://claude.com/cai/oauth/authorize?code=true&state=fake' });
    expect((await hopper(a, ['accounts', 'code', login.id])).code).toBe(2);
    const done = await hopper(a, ['accounts', 'code', login.id], 'good-code\n');
    expect(done.code).toBe(0);
    expect(JSON.parse(done.out)).toMatchObject({ id: login.id, status: 'completed' });
  });

  it('a tool that shows no URL: 502 with why, and no login', async () => {
    writeFileSync(join(control, 'mode'), 'login-no-url');
    const a = await boot({ plugins: { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] } });
    const r = await a.ui<{ error: string }>('/ui/api/tool-accounts/sign-in', { source: 'claude' }, { token: await a.login() });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).toContain('the sign-in did not start: the sign-in ended before it showed its URL: fake: cannot sign in here');
    expect(a.user().store.logins.list()).toEqual([]);
  });
});

describe('GitHub accounts of the job sources', () => {
  it('the connected account\'s source, not connected, says so; the app source then has no account to take issues for (issue #387)', async () => {
    const gh = createFakeGitHub();
    const app = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [REPO] } });
    const a = await boot({ plugins: { jobSources: jobSourcesDoc() }, secrets: appSecrets(), seams: { github: gh, githubApp: app } });
    await a.sync();
    const list = await accounts(a);
    expect(list).toContainEqual({ role: 'job-source', instance: 'github', service: 'github', detail: { via: CONNECTED_VIA }, problem: 'GitHub is not connected: Sources → Connect GitHub' });
    expect(list).toContainEqual(expect.objectContaining({ instance: 'github-app', problem: NO_ASSIGNEE }));
  });

  it('the app source acts as its bot on its installation repos', async () => {
    const app = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [REPO] } });
    const a = await boot({ plugins: { jobSources: jobSourcesDoc({ github: false }) }, secrets: appSecrets(), seams: { githubApp: app } });
    connectGitHub(a, [REPO]);
    await a.sync();
    expect(await accounts(a)).toContainEqual({ role: 'job-source', instance: 'github-app', service: 'github', identity: BOT, detail: { via: 'GitHub App', installedRepos: [REPO] } });
  });

  it('the connected account\'s source names the account it acts as', async () => {
    const gh = createFakeGitHub({ login: 'owner' });
    const a = await boot({ plugins: { jobSources: jobSourcesDoc({ github: {} }) }, seams: { github: gh } });
    connectGitHub(a, [REPO]);
    await a.sync();
    expect(await accounts(a)).toContainEqual({ role: 'job-source', instance: 'github', service: 'github', identity: 'owner', detail: { via: CONNECTED_VIA } });
  });
});
