// The Grok Bot routine's actions and payload (issue #378): a real loopback receiver, the routine's URL
// and key from the runtime (seams.env: the test's `secrets`, mutable while the app runs), the real
// composition root and the UI session's routes.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

interface Hit { headers: IncomingHttpHeaders; body: Record<string, unknown> }

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
let server: Server | undefined;

/** Receiver answering the scripted statuses in order, then 200. */
async function receiver(statuses: number[] = []): Promise<{ url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const queue = [...statuses];
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      res.statusCode = queue.shift() ?? 200;
      res.end();
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/routine`, hits };
}

type Secrets = Record<string, string | undefined>;

async function start(env: Record<string, string> = {}, plugins?: Record<string, unknown> | false): Promise<{ a: TestApp; secrets: Secrets }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const secrets: Secrets = {};
  t = await startTestApp({ dbPath: db.dbPath, env, secrets, seams: { grokbot: { baseMs: 20 } }, ...(plugins === undefined ? {} : { plugins }) });
  return { a: t, secrets };
}
const setHook = (secrets: Secrets, url: string, key = 'sekrit', names = { url: 'GROKBOT_WEBHOOK_URL', key: 'GROKBOT_WEBHOOK_KEY' }) => {
  secrets[names.url] = url;
  secrets[names.key] = key;
};
const ask = (message: string) => ({ op: 'ask', message });
const SRC = { title: 'Fix the shed', url: 'https://example.invalid/issues/7' };

afterEach(async () => {
  await t?.stop();
  t = undefined;
  const s = server;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  server = undefined;
  cleanup?.();
});

const humanQuestion = async (a: TestApp, text = 'Is this risky?') => {
  const job = await a.pull(ask(text), SRC);
  const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
  return { job, q };
};
const settle = () => new Promise((x) => setTimeout(x, 200));

// Issue #378: a test event, the questions open before the routine was configured, a payload a
// receiver can route on, and a URL and key that change without a restart (mounted files, read at
// each use).
describe('Grok Bot routine: test event, open questions, payload (issue #378)', () => {
  const notifierAction = async (a: TestApp, action: string, name = 'grok-bot') =>
    a.ui<Record<string, unknown>>('/ui/api/notifiers', { action, name }, { token: await a.login() });

  it('the question payload carries the machine, lane, priority, labels, repo and issue number, what detected it and how long it has been open', async () => {
    const r = await receiver();
    const { a, secrets } = await start();
    setHook(secrets, r.url);
    const job = await a.pull(ask('Is this risky?'), { ...SRC, priority: 70, labels: ['hopper', 'area:ui'], repo: 'acme/shed', number: 7 });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const hit = await waitFor(() => r.hits.find((h) => h.body.kind === 'question.escalated'), { what: 'escalation post' });
    const now = await a.job(job.id);
    const machineId = now.resumeOn ?? now.laneId?.split('/')[0];
    expect(machineId).toBeTruthy();
    expect(hit.body).toMatchObject({
      machineId, priority: 70, labels: ['hopper', 'area:ui'], repo: 'acme/shed', issueNumber: 7,
      detectedBy: q.detectedBy, askedAt: q.createdAt, offered: false,
    });
    expect(hit.body).toHaveProperty('laneId');
    expect(typeof hit.body.openSeconds).toBe('number');
    expect(hit.body.openSeconds as number).toBeGreaterThanOrEqual(0);
  });

  it('Send test event: one marked test payload with the bearer key; the answer is the HTTP result', async () => {
    const r = await receiver([401]);
    const { a, secrets } = await start();
    setHook(secrets, r.url);
    const first = await notifierAction(a, 'test');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: false, status: 401 });
    expect(r.hits).toHaveLength(1);
    const second = await notifierAction(a, 'test');
    expect(second.body).toMatchObject({ ok: true, status: 200 });
    expect(r.hits[1]!.headers.authorization).toBe('Bearer sekrit');
    expect(r.hits[1]!.body).toMatchObject({ source: 'hopper', kind: 'test', test: true });
    expect(typeof r.hits[1]!.body.at).toBe('string');
  });

  it('Send test event with the variables unset: nothing sent, the answer names what is missing', async () => {
    const r = await receiver();
    const { a } = await start();
    const res = await notifierAction(a, 'test');
    expect(res.body).toMatchObject({ ok: false });
    expect(String(res.body.detail)).toMatch(/GROKBOT_WEBHOOK_URL/);
    expect(r.hits).toHaveLength(0);
  });

  it('an unknown notifier, or one without the action, is refused', async () => {
    await receiver();
    const { a } = await start();
    expect((await notifierAction(a, 'test', 'nope')).status).toBe(404);
    expect((await notifierAction(a, 'explode')).status).toBe(400);
  });

  it('/api/plugins lists the actions a notifier offers', async () => {
    const { a } = await start();
    expect((await a.api('GET', '/api/plugins')).body.notifiers.instances[0].actions).toEqual(['test', 'send-open']);
  });

  it('questions open before the routine was configured are sent once it is, once each; a later question goes as before', async () => {
    const r = await receiver();
    const db = tempDbPath();
    cleanup = db.cleanup;
    const secrets: Secrets = {};
    t = await startTestApp({ dbPath: db.dbPath, secrets, seams: { grokbot: { baseMs: 20, watchMs: 50 } } });
    const { job: one } = await humanQuestion(t, 'first risky?');
    const { job: two } = await humanQuestion(t, 'second risky?');
    await settle();
    expect(r.hits).toHaveLength(0);
    setHook(secrets, r.url);
    await waitFor(() => r.hits.length >= 2, { what: 'open questions offered' });
    await settle();
    expect(r.hits.map((h) => h.body.jobId).sort()).toEqual([one.id, two.id].sort());
    expect(r.hits.every((h) => h.body.kind === 'question.escalated' && h.body.offered === true)).toBe(true);
    const { job: three } = await humanQuestion(t, 'third risky?');
    await waitFor(() => r.hits.find((h) => h.body.jobId === three.id), { what: 'post for the third' });
    await settle();
    expect(r.hits).toHaveLength(3);
  });

  it('Send open questions now: every question open at the human, again on each press', async () => {
    const r = await receiver();
    const { a, secrets } = await start();
    setHook(secrets, r.url);
    await humanQuestion(a, 'first risky?');
    await humanQuestion(a, 'second risky?');
    await waitFor(() => r.hits.length === 2, { what: 'the live posts' });
    const res = await notifierAction(a, 'send-open');
    expect(res.body).toMatchObject({ ok: true, sent: 2, failed: 0 });
    expect(r.hits).toHaveLength(4);
    expect(r.hits.slice(2).every((h) => h.body.offered === true)).toBe(true);
  });

  it('URL and key from mounted files named at start but written later: sent without a restart', async () => {
    const r = await receiver();
    const dir = mkdtempSync(join(tmpdir(), 'jh-mounted-'));
    const db = tempDbPath();
    cleanup = db.cleanup;
    const secrets: Secrets = { GROKBOT_WEBHOOK_URL_FILE: join(dir, 'url'), GROKBOT_WEBHOOK_KEY_FILE: join(dir, 'key') };
    t = await startTestApp({ dbPath: db.dbPath, secrets, seams: { grokbot: { baseMs: 20, watchMs: 50 } } });
    expect((await t.api('GET', '/api/plugins')).body.notifiers.instances[0].detection.status).toBe('needs-setup');
    const { job } = await humanQuestion(t);
    await settle();
    expect(r.hits).toHaveLength(0);
    writeFileSync(join(dir, 'url'), `${r.url}\n`, { mode: 0o600 });
    writeFileSync(join(dir, 'key'), 'later\n', { mode: 0o600 });
    const hit = await waitFor(() => r.hits.find((h) => h.body.jobId === job.id), { what: 'post once the files exist' });
    expect(hit.headers.authorization).toBe('Bearer later');
  });
});

// A user's secrets carry the user's secret prefix (issue #158): the routine's variables of a user added
// later are HOPPER_USER_<ID>_GROKBOT_WEBHOOK_URL and _KEY. What the notifier says is missing must name
// those, or the owner sets a variable the hopper never reads.
describe('Grok Bot routine of a user with a secret prefix', () => {
  it('needs-setup and the test event name the prefixed variables; the prefixed variables are the ones read', async () => {
    const r = await receiver();
    const { a, secrets } = await start();
    const u = await a.addUser('Second Person');
    const prefix = `HOPPER_USER_${u.id.toUpperCase()}_`;
    setHook(secrets, r.url);
    const before = a.user(u.id).plugins.report().notifiers.instances[0]!;
    expect(before.detection.status).toBe('needs-setup');
    expect(before.detection.reason).toContain(`${prefix}GROKBOT_WEBHOOK_URL`);
    expect(before.detection.command).toContain(`${prefix}GROKBOT_WEBHOOK_KEY_FILE`);
    const refused = await a.user(u.id).plugins.notifierAction('grok-bot', 'test');
    expect(refused).toMatchObject({ ok: true, result: { ok: false } });
    expect(refused.ok && refused.result.detail).toContain(`${prefix}GROKBOT_WEBHOOK_URL`);
    expect(r.hits).toHaveLength(0);
    setHook(secrets, r.url, 'theirs', { url: `${prefix}GROKBOT_WEBHOOK_URL`, key: `${prefix}GROKBOT_WEBHOOK_KEY` });
    expect(await a.user(u.id).plugins.notifierAction('grok-bot', 'test')).toMatchObject({ ok: true, result: { ok: true, status: 200 } });
    expect(r.hits[0]!.headers.authorization).toBe('Bearer theirs');
  });
});
