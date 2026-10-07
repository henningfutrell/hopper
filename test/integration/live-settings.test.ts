// Every setting saved in the UI applies without restarting the hopper (issue #356). The job sources,
// usage sources and notifiers were the last restart roles: now a save through POST /ui/api/plugins is
// in place when the answer comes back, and the next job (or the next read, the next event) uses it. A job running at
// the time of the save keeps running. The other roles and settings have their own live tests:
// escalation levels (escalation-levels-edit), executors (executors), machines (machines-edit),
// routing rules (routing), job rules (job-rules), question gates (question-gates), webhooks
// (webhooks-edit), sign-in and realms (realms-edit).
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, PluginsReport } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
type Reply = PluginsReport & { error: string };

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
let server: Server | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  const s = server;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  server = undefined;
  cleanup?.();
});

async function start(gh: FakeGitHub, plugins: Record<string, unknown> = {}, secrets: Record<string, string | undefined> = {}): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, secrets, seams: { github: gh, grokbotBaseMs: 20 }, plugins: { jobSources: [], usageSources: [], notifiers: [], ...plugins } });
  return { a: t, token: await t.login() };
}

/** A loopback Grok Bot routine receiver: the bodies it was sent. */
async function receiver(): Promise<{ url: string; hits: Record<string, unknown>[] }> {
  const hits: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => { hits.push(JSON.parse(raw) as Record<string, unknown>); res.end(); });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/routine`, hits };
}

const version = async (a: TestApp): Promise<string> => (await a.api<PluginsReport>('GET', '/api/plugins')).body.config.version;

async function edit(a: TestApp, token: string, e: Record<string, unknown>): Promise<Reply> {
  const r = await a.ui<Reply>('/ui/api/plugins', { ...e, version: await version(a) }, { token });
  expect(r.status, r.body.error).toBe(200);
  return r.body;
}

const ghOptions = (extra: Record<string, unknown> = {}) => ({
  enabled: true, pollSeconds: 3600, repos: [REPO], authors: ['owner'], executor: 'scripted', defaultCwd: '/tmp', ...extra,
});
const issueBody = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (a: TestApp, url: string): Promise<Job | undefined> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url);
const cwdOf = (j: Job) => (j.spec.payload as { defaultCwd?: string }).defaultCwd;

describe('every setting applies without a restart (issue #356)', () => {
  it('a job source switched on in the UI pulls the next job; an options change applies to the next one; no restart pending', async () => {
    const gh = createFakeGitHub();
    const { a, token } = await start(gh, { jobSources: [{ name: 'github', plugin: 'github-gh', options: ghOptions({ enabled: false }) }] });
    const first = gh.createIssue({ repo: REPO, author: 'owner', body: issueBody({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, first.url)).toBeUndefined();
    await edit(a, token, { action: 'options', role: 'job-source', name: 'github', options: ghOptions() });
    await a.sync();
    const job1 = await waitFor(() => jobFor(a, first.url), { what: 'the job of the first issue' });
    expect(cwdOf(job1)).toBe('/tmp');
    expect((await a.api('GET', '/api/sources')).body.sources).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'github', state: 'ok' })]));

    await edit(a, token, { action: 'options', role: 'job-source', name: 'github', options: ghOptions({ defaultCwd: '/var/tmp' }) });
    const second = gh.createIssue({ repo: REPO, author: 'owner', body: issueBody({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    const job2 = await waitFor(() => jobFor(a, second.url), { what: 'the job of the second issue' });
    expect(cwdOf(job2)).toBe('/var/tmp');
    expect(JSON.stringify((await a.api('GET', '/api/plugins')).body)).not.toMatch(/restart pending/);
  });

  it('a usage source changed in the UI is read at once; removed, it is no longer read', async () => {
    const gh = createFakeGitHub();
    const printing = (used: number) => [process.execPath, '-e', `console.log(JSON.stringify({ readings: [{ used: ${used}, limit: 100, unit: "%" }] }))`];
    const { a, token } = await start(gh, { usageSources: [{ name: 'budget', plugin: 'command-usage', options: { command: printing(42) } }] });
    const reading = (used: number) => waitFor(async () => {
      const u = (await a.api<{ readings: { source: string; used: number }[] }>('GET', '/api/usage')).body;
      return u.readings.some((r) => r.source === 'budget' && r.used === used) ? u : undefined;
    }, { what: `a budget reading of ${used}` });
    await reading(42);
    await edit(a, token, { action: 'options', role: 'usage-source', name: 'budget', options: { command: printing(77) } });
    await reading(77);
    await edit(a, token, { action: 'remove', role: 'usage-source', name: 'budget' });
    const after = (await a.api<{ readings: { source: string }[]; sources: { name: string }[] }>('GET', '/api/usage')).body;
    expect(after.readings.some((r) => r.source === 'budget')).toBe(false);
    expect(after.sources.some((s) => s.name === 'budget')).toBe(false);
  });

  it('a notifier added in the UI tells of the next human question', async () => {
    const gh = createFakeGitHub();
    const hook = await receiver();
    const { a, token } = await start(gh, {}, { GROKBOT_WEBHOOK_URL: hook.url, GROKBOT_WEBHOOK_KEY: 'sekrit' });
    const r = await edit(a, token, { action: 'add', role: 'notifier', plugin: 'grokbot-routine', name: 'grok-bot' });
    expect(r.notifiers).toEqual({ instances: [expect.objectContaining({ instance: expect.objectContaining({ name: 'grok-bot' }), active: 'grokbot-routine' })] });
    const job = await a.pull({ op: 'ask', message: 'Is this risky?' });
    await a.waitForQuestion(job.id, (q) => q.tier === 'human');
    await waitFor(() => (hook.hits.length > 0 ? true : undefined), { what: 'the routine webhook' });
  });

  it('no running job is ended by a save: job sources, usage sources and notifiers changed around it', async () => {
    const gh = createFakeGitHub();
    const { a, token } = await start(gh, {
      jobSources: [{ name: 'github', plugin: 'github-gh', options: ghOptions() }],
      notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine' }],
      usageSources: [{ name: 'budget', plugin: 'command-usage', options: { command: [process.execPath, '-e', '0'] } }],
    });
    const issue = gh.createIssue({ repo: REPO, author: 'owner', body: issueBody({ op: 'sleep', ms: 60_000 }), labels: ['hopper'] });
    await a.sync();
    const job = await waitFor(() => jobFor(a, issue.url), { what: 'the job' });
    await a.waitForStatus(job.id, 'running');
    await edit(a, token, { action: 'options', role: 'job-source', name: 'github', options: ghOptions({ defaultCwd: '/var/tmp' }) });
    await edit(a, token, { action: 'options', role: 'notifier', name: 'grok-bot', options: { urlEnv: 'OTHER_WEBHOOK_URL' } });
    await edit(a, token, { action: 'remove', role: 'usage-source', name: 'budget' });
    await edit(a, token, { action: 'remove', role: 'job-source', name: 'github' });
    await a.sync();
    expect((await a.job(job.id)).status).toBe('running');
    const ended = (await a.events(`jobId=${job.id}`)).filter((e) => ['job.failed', 'job.cancelled', 'job.finished'].includes(e.type));
    expect(ended).toEqual([]);
    // The removed source still answers for its running job: it is listed until that job ends.
    expect((await a.api('GET', '/api/sources')).body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'github', activeJobs: 1, detail: expect.objectContaining({ paused: 'removed from the plugins config' }) }),
    ]));
  });
});
