// The Grok Bot routine webhook: a real loopback receiver, a real env file, the real composition root.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
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

async function start(env: Record<string, string> = {}): Promise<{ a: TestApp; file: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const file = join(db.dbPath, '..', 'grokbot-webhook.env');
  t = await startTestApp({ dbPath: db.dbPath, env, seams: { grokbotBaseMs: 20 } });
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
