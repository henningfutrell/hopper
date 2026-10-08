// The Grok Bot routine webhook: a real loopback receiver, the webhook url and key read from the
// environment (seams.env: the test's `secrets`, mutable while the app runs), the real composition root.
// It is the built-in notifier plugin grokbot-routine; a plugins config without a `notifiers` section
// means the built-in grok-bot instance, and a database with no plugins config gets the built-in instances.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { readConfig } from '../support/files.ts';
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
  t = await startTestApp({ dbPath: db.dbPath, env, secrets, seams: { grokbotBaseMs: 20 }, ...(plugins === undefined ? {} : { plugins }) });
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

describe('Grok Bot routine webhook', () => {
  it('its key may come from a mounted secret file (GROKBOT_WEBHOOK_KEY_FILE): a plugin reads secrets from the runtime (issue #56)', async () => {
    const r = await receiver();
    const { a, secrets } = await start();
    const file = join(mkdtempSync(join(tmpdir(), 'jh-mounted-')), 'key');
    writeFileSync(file, 'from-file\n', { mode: 0o600 });
    secrets.GROKBOT_WEBHOOK_URL = r.url;
    secrets.GROKBOT_WEBHOOK_KEY_FILE = file;
    await humanQuestion(a);
    const hit = await waitFor(() => r.hits.find((h) => h.body.kind === 'question.escalated'), { what: 'escalation post' });
    expect(hit.headers.authorization).toBe('Bearer from-file');
  });

  it('variables unset: a human question sends nothing', async () => {
    const r = await receiver();
    const { a } = await start();
    await humanQuestion(a);
    await settle();
    expect(r.hits).toHaveLength(0);
  });

  it('a finished job sends nothing', async () => {
    const r = await receiver();
    const { a, secrets } = await start();
    setHook(secrets, r.url);
    const job = await a.pull({ op: 'echo' }, SRC);
    await a.waitForStatus(job.id, 'finished');
    await settle();
    expect(r.hits).toHaveLength(0);
  });

  it('a failed job sends nothing', async () => {
    const r = await receiver();
    const { a, secrets } = await start();
    setHook(secrets, r.url);
    const job = await a.pull({ op: 'fail', message: 'boom' }, SRC);
    await a.waitForStatus(job.id, 'failed');
    await settle();
    expect(r.hits).toHaveLength(0);
  });

  it('a question escalated to the human posts once with bearer key, question text and id; the answer and assess stages do not', async () => {
    const r = await receiver();
    const { a, secrets } = await start();
    setHook(secrets, r.url);
    const hard = await a.pull(ask('Which colour?'), { title: 'one' });
    await a.waitForStatus(hard.id, 'finished'); // opus drafts, fable lets it through: escalated to opus and fable only
    const { job: human, q } = await humanQuestion(a);
    const hit = await waitFor(() => r.hits.find((h) => h.body.kind === 'question.escalated'), { what: 'escalation post' });
    await settle();
    expect(hit.headers.authorization).toBe('Bearer sekrit');
    expect(hit.headers['content-type']).toMatch(/application\/json/);
    expect(hit.body).toMatchObject({ source: 'hopper', jobId: human.id, question: 'Is this risky?', questionId: q.id, issueTitle: SRC.title, issueUrl: SRC.url });
    expect(typeof hit.body.at).toBe('string');
    expect(typeof hit.body.answerUrl).toBe('string');
    expect(r.hits).toHaveLength(1);
    expect(r.hits.some((h) => h.body.jobId === hard.id)).toBe(false);
  });

  it('re-notifications do not post again, and the failure that ends the wait posts nothing', async () => {
    const r = await receiver();
    const { a, secrets } = await start({ HOPPER_HUMAN_RENOTIFY_MS: '100', HOPPER_HUMAN_TIMEOUT_MS: '450' });
    setHook(secrets, r.url);
    const job = await a.pull(ask('Is this risky?'));
    await a.waitForStatus(job.id, 'failed');
    const events = (await a.events()).filter((e) => e.jobId === job.id && e.type === 'question.escalated' && e.data.target === 'human');
    expect(events.length).toBeGreaterThanOrEqual(3);
    await settle();
    expect(r.hits.filter((h) => h.body.kind === 'question.escalated')).toHaveLength(1);
    expect(r.hits).toHaveLength(1);
  });

  it('variables set after start are honoured', async () => {
    const r = await receiver();
    const { a, secrets } = await start();
    await humanQuestion(a, 'first risky?');
    await settle();
    expect(r.hits).toHaveLength(0);
    setHook(secrets, r.url);
    const { job: second } = await humanQuestion(a, 'second risky?');
    await waitFor(() => r.hits.find((h) => h.body.jobId === second.id), { what: 'post for second job' });
  });

  it('retries a 500 and delivers on the 200', async () => {
    const r = await receiver([500]);
    const { a, secrets } = await start();
    setHook(secrets, r.url);
    await humanQuestion(a);
    await waitFor(() => r.hits.length >= 2, { what: 'retry' });
    await settle();
    expect(r.hits).toHaveLength(2);
  });

  it('does not retry a 401', async () => {
    const r = await receiver([401, 200]);
    const { a, secrets } = await start();
    setHook(secrets, r.url);
    await humanQuestion(a);
    await waitFor(() => r.hits.length >= 1, { what: 'first post' });
    await new Promise((x) => setTimeout(x, 300));
    expect(r.hits).toHaveLength(1);
  });
});

describe('Grok Bot as the grokbot-routine notifier plugin (phase 5, slice 5)', () => {
  it('a plugins config without a notifiers section: the built-in grok-bot instance posts; /api/plugins lists it', async () => {
    const r = await receiver();
    const { a, secrets } = await start();
    expect(readConfig(a.dbPath, 'plugins')).not.toHaveProperty('notifiers');
    expect((await a.api('GET', '/api/plugins')).body.notifiers.instances).toEqual([{
      instance: { name: 'grok-bot', plugin: 'grokbot-routine' },
      detection: expect.objectContaining({ status: 'needs-setup' }), active: 'grokbot-routine', actions: ['test', 'send-open'],
    }]);
    setHook(secrets, r.url);
    await humanQuestion(a);
    await waitFor(() => r.hits.length === 1, { what: 'escalation post' });
  });

  it('no plugins config in the database: the built-in instances are written, grok-bot among them, and it posts', async () => {
    const r = await receiver();
    const { a, secrets } = await start({}, false);
    expect((readConfig(a.dbPath, 'plugins') as { notifiers?: unknown }).notifiers).toEqual([{ name: 'grok-bot', plugin: 'grokbot-routine' }]);
    await a.addThisMachine();
    setHook(secrets, r.url);
    await humanQuestion(a);
    await waitFor(() => r.hits.length === 1, { what: 'escalation post' });
  });

  it('urlEnv and keyEnv name other variables: those are read', async () => {
    const r = await receiver();
    const db = tempDbPath();
    cleanup = db.cleanup;
    const secrets: Secrets = {};
    setHook(secrets, r.url, 'other-key', { url: 'OTHER_URL', key: 'OTHER_KEY' });
    setHook(secrets, r.url, 'wrong-key');
    t = await startTestApp({
      dbPath: db.dbPath, secrets, seams: { grokbotBaseMs: 20 },
      plugins: { notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine', options: { urlEnv: 'OTHER_URL', keyEnv: 'OTHER_KEY' } }] },
    });
    await humanQuestion(t);
    const hit = await waitFor(() => r.hits[0], { what: 'escalation post' });
    expect(hit.headers.authorization).toBe('Bearer other-key');
  });

  it('notifiers: [] → nothing posted, even with the variables set', async () => {
    const r = await receiver();
    const { a, secrets } = await start({}, { notifiers: [] });
    setHook(secrets, r.url);
    await humanQuestion(a);
    await settle();
    expect(r.hits).toHaveLength(0);
    expect((await a.api('GET', '/api/plugins')).body.notifiers.instances).toEqual([]);
  });

  it('a notifier that cannot run is dropped with its reason in /api/plugins; the daemon boots and the others run', async () => {
    const r = await receiver();
    const db = tempDbPath();
    cleanup = db.cleanup;
    const secrets: Secrets = {};
    setHook(secrets, r.url);
    t = await startTestApp({ dbPath: db.dbPath, secrets, seams: { grokbotBaseMs: 20 }, plugins: { notifiers: [
      { name: 'nope', plugin: 'no-such-notifier' },
      { name: 'bad', plugin: 'grokbot-routine', options: { urlEnv: 42 } },
      { name: 'grok-bot', plugin: 'grokbot-routine' },
    ] } });
    const instances = (await t.api('GET', '/api/plugins')).body.notifiers.instances;
    expect(instances.map((i: { instance: { name: string }; active: string | null }) => [i.instance.name, i.active])).toEqual([['nope', null], ['bad', null], ['grok-bot', 'grokbot-routine']]);
    expect(instances[0].reason).toMatch(/unknown notifier plugin no-such-notifier/);
    expect(instances[1].reason).toMatch(/urlEnv/);
    await humanQuestion(t);
    await waitFor(() => r.hits.length === 1, { what: 'escalation post' });
  });

  it('either variable unset: detection is needs-setup and nothing posts', async () => {
    const r = await receiver();
    const { a, secrets } = await start();
    secrets.GROKBOT_WEBHOOK_URL = r.url;
    expect((await a.api('GET', '/api/plugins')).body.notifiers.instances[0].detection.status).toBe('needs-setup');
    await humanQuestion(a);
    await settle();
    expect(r.hits).toHaveLength(0);
  });
});

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
    t = await startTestApp({ dbPath: db.dbPath, secrets, seams: { grokbotBaseMs: 20, grokbotWatchMs: 50 } });
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
    t = await startTestApp({ dbPath: db.dbPath, secrets, seams: { grokbotBaseMs: 20, grokbotWatchMs: 50 } });
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
