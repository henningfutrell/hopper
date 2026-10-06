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
      detection: expect.objectContaining({ status: 'needs-setup' }), active: 'grokbot-routine',
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
