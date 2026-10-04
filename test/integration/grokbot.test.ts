// The Grok Bot routine webhook: a real loopback receiver, a real env file, the real composition root.
// Since phase 5 slice 5 it is the built-in notifier plugin grokbot-routine; the behaviour is unchanged.
// Both upgrade orders end with Grok Bot configured: a plugins.yaml written before slice 5 (no
// `notifiers` section) means the built-in grok-bot instance; a boot with no plugins.yaml writes
// `notifiers` from the removed JOB_HOPPER_GROKBOT_WEBHOOK_FILE (or the default file).
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
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

async function start(env: Record<string, string> = {}, plugins?: Record<string, unknown> | false): Promise<{ a: TestApp; file: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const file = join(db.dbPath, '..', 'grokbot-webhook.env');
  t = await startTestApp({ dbPath: db.dbPath, env, seams: { grokbotBaseMs: 20 }, ...(plugins === undefined ? {} : { plugins }) });
  return { a: t, file };
}
const writeEnv = (file: string, url: string, key = 'sekrit') => writeFileSync(file, `GROKBOT_WEBHOOK_URL=${url}\nGROKBOT_WEBHOOK_KEY=${key}\n`, { mode: 0o600 });
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
  it('file absent: a human question sends nothing', async () => {
    const r = await receiver();
    const { a } = await start();
    await humanQuestion(a);
    await settle();
    expect(r.hits).toHaveLength(0);
  });

  it('a finished job sends nothing', async () => {
    const r = await receiver();
    const { a, file } = await start();
    writeEnv(file, r.url);
    const job = await a.pull({ op: 'echo' }, SRC);
    await a.waitForStatus(job.id, 'finished');
    await settle();
    expect(r.hits).toHaveLength(0);
  });

  it('a failed job sends nothing', async () => {
    const r = await receiver();
    const { a, file } = await start();
    writeEnv(file, r.url);
    const job = await a.pull({ op: 'fail', message: 'boom' }, SRC);
    await a.waitForStatus(job.id, 'failed');
    await settle();
    expect(r.hits).toHaveLength(0);
  });

  it('a question escalated to the human posts once with bearer key, question text and id; the answer and assess stages do not', async () => {
    const r = await receiver();
    const { a, file } = await start();
    writeEnv(file, r.url);
    const hard = await a.pull(ask('Which colour?'), { title: 'one' });
    await a.waitForStatus(hard.id, 'finished'); // opus drafts, fable lets it through: escalated to opus and fable only
    const { job: human, q } = await humanQuestion(a);
    const hit = await waitFor(() => r.hits.find((h) => h.body.kind === 'question.escalated'), { what: 'escalation post' });
    await settle();
    expect(hit.headers.authorization).toBe('Bearer sekrit');
    expect(hit.headers['content-type']).toMatch(/application\/json/);
    expect(hit.body).toMatchObject({ source: 'job-hopper', jobId: human.id, question: 'Is this risky?', questionId: q.id, issueTitle: SRC.title, issueUrl: SRC.url });
    expect(typeof hit.body.at).toBe('string');
    expect(typeof hit.body.answerUrl).toBe('string');
    expect(r.hits).toHaveLength(1);
    expect(r.hits.some((h) => h.body.jobId === hard.id)).toBe(false);
  });

  it('re-notifications do not post again, and the failure that ends the wait posts nothing', async () => {
    const r = await receiver();
    const { a, file } = await start({ JOB_HOPPER_HUMAN_RENOTIFY_MS: '100', JOB_HOPPER_HUMAN_TIMEOUT_MS: '450' });
    writeEnv(file, r.url);
    const job = await a.pull(ask('Is this risky?'));
    await a.waitForStatus(job.id, 'failed');
    const events = (await a.events()).filter((e) => e.jobId === job.id && e.type === 'question.escalated' && e.data.target === 'human');
    expect(events.length).toBeGreaterThanOrEqual(3);
    await settle();
    expect(r.hits.filter((h) => h.body.kind === 'question.escalated')).toHaveLength(1);
    expect(r.hits).toHaveLength(1);
  });

  it('a file created after start is honoured', async () => {
    const r = await receiver();
    const { a, file } = await start();
    await humanQuestion(a, 'first risky?');
    await settle();
    expect(r.hits).toHaveLength(0);
    writeEnv(file, r.url);
    const { job: second } = await humanQuestion(a, 'second risky?');
    await waitFor(() => r.hits.find((h) => h.body.jobId === second.id), { what: 'post for second job' });
  });

  it('retries a 500 and delivers on the 200', async () => {
    const r = await receiver([500]);
    const { a, file } = await start();
    writeEnv(file, r.url);
    await humanQuestion(a);
    await waitFor(() => r.hits.length >= 2, { what: 'retry' });
    await settle();
    expect(r.hits).toHaveLength(2);
  });

  it('does not retry a 401', async () => {
    const r = await receiver([401, 200]);
    const { a, file } = await start();
    writeEnv(file, r.url);
    await humanQuestion(a);
    await waitFor(() => r.hits.length >= 1, { what: 'first post' });
    await new Promise((x) => setTimeout(x, 300));
    expect(r.hits).toHaveLength(1);
  });
});

describe('Grok Bot as the grokbot-routine notifier plugin (phase 5, slice 5)', () => {
  it('a plugins.yaml without a notifiers section (slice 4 installed first): the built-in grok-bot instance posts; /api/plugins lists it', async () => {
    const r = await receiver();
    const { a, file } = await start();
    expect(parse(readFileSync(join(a.dataDir, 'plugins.yaml'), 'utf8'))).not.toHaveProperty('notifiers');
    expect((await a.api('GET', '/api/plugins')).body.notifiers.instances).toEqual([{
      instance: { name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: file } },
      detection: expect.objectContaining({ status: 'needs-setup' }), active: 'grokbot-routine',
    }]);
    writeEnv(file, r.url);
    await humanQuestion(a);
    await waitFor(() => r.hits.length === 1, { what: 'escalation post' });
  });

  it('no plugins.yaml (slice 5 installed straight over the old unit): the migration writes notifiers from JOB_HOPPER_GROKBOT_WEBHOOK_FILE, and it posts', async () => {
    const r = await receiver();
    const db = tempDbPath();
    cleanup = db.cleanup;
    const elsewhere = join(db.dbPath, '..', 'secrets', 'grok.env');
    mkdirSync(join(elsewhere, '..'), { recursive: true });
    writeEnv(elsewhere, r.url);
    t = await startTestApp({ dbPath: db.dbPath, plugins: false, env: { JOB_HOPPER_GROKBOT_WEBHOOK_FILE: elsewhere }, seams: { grokbotBaseMs: 20 } });
    expect(parse(readFileSync(join(t.dataDir, 'plugins.yaml'), 'utf8')).notifiers).toEqual([
      { name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: elsewhere } },
    ]);
    await humanQuestion(t);
    await waitFor(() => r.hits.length === 1, { what: 'escalation post' });
  });

  it('no plugins.yaml and no variable: the migration writes the default env file beside plugins.yaml', async () => {
    const { a, file } = await start({}, false);
    expect(parse(readFileSync(join(a.dataDir, 'plugins.yaml'), 'utf8')).notifiers).toEqual([
      { name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: file } },
    ]);
  });

  it('a notifiers section naming another env file: that file is read', async () => {
    const r = await receiver();
    const db = tempDbPath();
    cleanup = db.cleanup;
    const other = join(db.dbPath, '..', 'other.env');
    writeEnv(other, r.url, 'other-key');
    writeEnv(join(db.dbPath, '..', 'grokbot-webhook.env'), r.url, 'wrong-key');
    t = await startTestApp({ dbPath: db.dbPath, plugins: { notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: other } }] }, seams: { grokbotBaseMs: 20 } });
    await humanQuestion(t);
    const hit = await waitFor(() => r.hits[0], { what: 'escalation post' });
    expect(hit.headers.authorization).toBe('Bearer other-key');
  });

  it('notifiers: [] → nothing posted, even with the env file in place', async () => {
    const r = await receiver();
    const { a, file } = await start({}, { notifiers: [] });
    writeEnv(file, r.url);
    await humanQuestion(a);
    await settle();
    expect(r.hits).toHaveLength(0);
    expect((await a.api('GET', '/api/plugins')).body.notifiers.instances).toEqual([]);
  });

  it('a notifier that cannot run is dropped with its reason in /api/plugins; the daemon boots and the others run', async () => {
    const r = await receiver();
    const db = tempDbPath();
    cleanup = db.cleanup;
    const file = join(db.dbPath, '..', 'grokbot-webhook.env');
    writeEnv(file, r.url);
    t = await startTestApp({ dbPath: db.dbPath, seams: { grokbotBaseMs: 20 }, plugins: { notifiers: [
      { name: 'nope', plugin: 'no-such-notifier' },
      { name: 'bad', plugin: 'grokbot-routine', options: { envFile: 42 } },
      { name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: file } },
    ] } });
    const instances = (await t.api('GET', '/api/plugins')).body.notifiers.instances;
    expect(instances.map((i: { instance: { name: string }; active: string | null }) => [i.instance.name, i.active])).toEqual([['nope', null], ['bad', null], ['grok-bot', 'grokbot-routine']]);
    expect(instances[0].reason).toMatch(/unknown notifier plugin no-such-notifier/);
    expect(instances[1].reason).toMatch(/envFile/);
    await humanQuestion(t);
    await waitFor(() => r.hits.length === 1, { what: 'escalation post' });
  });
});
