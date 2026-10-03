// End-to-end demo against a running daemon: webhook + SSE + a mixed batch of jobs.
// node apps/job-hopper/scripts/demo.ts [--base http://127.0.0.1:4790] [--out <dir>]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

interface JobView {
  id: string;
  priority: number;
  status: string;
  spec: { executor: string; payload: Record<string, unknown>; kind?: string };
  jevAdvice?: { action: string };
}
interface DecisionView { reasons: string[] }

const SUBSCRIBER_PORT = 4795;
const HELD_OR_DONE = ['held', 'finished', 'failed', 'cancelled'];

const { values } = parseArgs({
  options: { base: { type: 'string', default: 'http://127.0.0.1:4790' }, out: { type: 'string' } },
});
const base = values.base as string;
const out = values.out ?? join(tmpdir(), `job-hopper-demo-${Date.now()}`);
mkdirSync(out, { recursive: true });
const sseLog = join(out, 'sse.jsonl');
const hookLog = join(out, 'webhooks.jsonl');
writeFileSync(sseLog, '');
writeFileSync(hookLog, '');

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- SSE reader ----
const sseAbort = new AbortController();
const sseCounts = new Map<string, number>();
async function readSse(): Promise<void> {
  const res = await fetch(`${base}/api/events/stream`, { signal: sseAbort.signal });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let type = '';
      let id = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) type = line.slice(7);
        else if (line.startsWith('id: ')) id = line.slice(4);
      }
      if (!type) continue; // heartbeat comment
      sseCounts.set(type, (sseCounts.get(type) ?? 0) + 1);
      appendFileSync(sseLog, JSON.stringify({ type, seq: id ? Number(id) : undefined }) + '\n');
    }
  }
}

function countLines(file: string): { total: number; allValid: boolean } {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const parsed = lines.map((l) => JSON.parse(l) as { signatureValid: boolean });
  return { total: parsed.length, allValid: parsed.every((p) => p.signatureValid) };
}

async function main(): Promise<number> {
  const secret = randomBytes(16).toString('hex');
  const subscriber = spawn(
    process.execPath,
    [join(import.meta.dirname, 'webhook-subscriber.ts'), '--port', String(SUBSCRIBER_PORT), '--secret', secret, '--log', hookLog],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  let subscriptionId: string | undefined;
  try {
    await sleep(500);
    const sub = await api<{ id: string }>('POST', '/api/webhooks', {
      url: `http://127.0.0.1:${SUBSCRIBER_PORT}/`,
      events: ['*'],
      secret,
    });
    subscriptionId = sub.id;
    console.log(`webhook subscription ${subscriptionId} -> subscriber :${SUBSCRIBER_PORT}`);

    const sseDone = readSse().catch((e: unknown) => {
      if (!sseAbort.signal.aborted) console.error('SSE error:', e);
    });
    await sleep(300);

    const specs = [
      { executor: 'test', payload: { op: 'sleep', ms: 3000 }, priority: 50 },
      { executor: 'test', payload: { op: 'echo', message: 'hello from demo' }, priority: 90 },
      { executor: 'test', payload: { op: 'fail', message: 'failed on purpose' }, priority: 50 },
      { executor: 'test', payload: { op: 'sleep', ms: 1500 }, priority: 10 },
      { executor: 'test', payload: { op: 'sleep', ms: 1500 }, priority: 30 },
      { executor: 'test', payload: { op: 'sleep', ms: 1500 }, priority: 70 },
      { executor: 'test', payload: { op: 'echo', message: 'account job' }, priority: 50, kind: 'account', goal: 'Send the invoice email' },
      { executor: 'test', payload: { op: 'echo', message: 'chat job' }, priority: 50, kind: 'chat' },
    ];
    const ids: string[] = [];
    for (const spec of specs) {
      const job = await api<JobView>('POST', '/api/jobs', { ...spec, submittedBy: 'demo' });
      ids.push(job.id);
    }
    console.log(`pushed ${ids.length} jobs; waiting up to 60 s for the queue to settle`);

    const deadline = Date.now() + 60_000;
    let jobs: JobView[] = [];
    for (;;) {
      jobs = await Promise.all(ids.map((id) => api<JobView>('GET', `/api/jobs/${id}`)));
      if (jobs.every((j) => HELD_OR_DONE.includes(j.status))) break;
      if (Date.now() > deadline) {
        console.error('timeout: jobs still waiting/running after 60 s');
        break;
      }
      await sleep(500);
    }
    await sleep(1500); // let trailing events and deliveries land

    console.log('\nid\t\t\t\texecutor op\tprio\tstatus\tjev action');
    for (const j of jobs) {
      console.log(`${j.id}\t${j.spec.executor} ${String(j.spec.payload.op ?? '')}\t${j.priority}\t${j.status}\t${j.jevAdvice?.action ?? '-'}`);
    }
    const { decisions } = await api<{ decisions: DecisionView[] }>('GET', '/api/decisions?limit=500');
    console.log(`\ndecisions: ${decisions.length}`);
    const last = decisions[0];
    if (last) console.log(`last decision reasons:\n  - ${last.reasons.join('\n  - ')}`);

    console.log('\nSSE events by type:');
    for (const [type, n] of [...sseCounts].sort()) console.log(`  ${type}\t${n}`);
    const sseTotal = [...sseCounts.values()].reduce((a, b) => a + b, 0);
    const hooks = countLines(hookLog);
    console.log(`\nwebhook deliveries received: ${hooks.total}, all signatures valid: ${hooks.allValid}`);
    console.log(`logs: ${sseLog}, ${hookLog}`);

    sseAbort.abort();
    await sseDone;
    if (sseTotal === 0 || hooks.total === 0) {
      console.error('FAIL: SSE or webhooks received nothing');
      return 1;
    }
    return hooks.allValid ? 0 : 1;
  } finally {
    if (subscriptionId) await api('DELETE', `/api/webhooks/${subscriptionId}`).catch((e: unknown) => console.error('unsubscribe failed:', e));
    subscriber.kill('SIGTERM');
    sseAbort.abort();
  }
}

if (!existsSync(join(import.meta.dirname, 'webhook-subscriber.ts'))) throw new Error('webhook-subscriber.ts missing');
main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
