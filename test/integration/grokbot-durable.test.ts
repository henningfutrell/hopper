// The Grok Bot routine notifier's durable delivery (issue #1587): each notification is a notifier delivery row with its key,
// so a stop during a send loses nothing, a start sends what is due, and the receiver dedupes by the key. A real loopback
// receiver and the real composition root, started twice on one database.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

interface Hit { headers: IncomingHttpHeaders; body: Record<string, unknown>; answered: boolean }

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
let server: Server | undefined;

/** A receiver that holds the first `hold` posts without an answer, then answers 200; it dedupes by the delivery key. */
async function receiver(hold = 0): Promise<{ url: string; hits: Hit[]; taken: () => Record<string, unknown>[] }> {
  const hits: Hit[] = [];
  let held = hold;
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const hit: Hit = { headers: req.headers, body: JSON.parse(raw) as Record<string, unknown>, answered: false };
      hits.push(hit);
      if (held > 0) { held--; return; }
      hit.answered = true;
      res.statusCode = 200;
      res.end();
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const taken = () => {
    const keys = new Map<string, Record<string, unknown>>();
    for (const h of hits) if (h.answered) keys.set(String(h.headers['x-hopper-delivery']), h.body);
    return [...keys.values()];
  };
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/routine`, hits, taken };
}

const SRC = { title: 'Fix the shed', url: 'https://example.invalid/issues/7' };
const settle = () => new Promise((x) => setTimeout(x, 300));

afterEach(async () => {
  await t?.stop();
  t = undefined;
  const s = server;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  server = undefined;
  cleanup?.();
});

describe('Grok Bot routine notifier: durable delivery (issue #1587)', () => {
  it('a stop during a send loses nothing: the next start sends it, and the receiver takes it once by its key', async () => {
    const r = await receiver(1);
    const db = tempDbPath();
    cleanup = db.cleanup;
    const secrets: Record<string, string | undefined> = { GROKBOT_WEBHOOK_URL: r.url, GROKBOT_WEBHOOK_KEY: 'sekrit' };
    const start = () => startTestApp({ dbPath: db.dbPath, secrets, seams: { grokbot: { baseMs: 20 } } });
    t = await start();
    const job = await t.pull({ op: 'echo' }, SRC);
    await t.waitForStatus(job.id, 'finished');
    await waitFor(() => r.hits.find((h) => h.body.kind === 'job.finished'), { what: 'the held post' });
    await t.stop();
    expect(r.taken()).toEqual([]);

    t = await start();
    await waitFor(() => r.taken().find((b) => b.kind === 'job.finished'), { what: 'the post after the start' });
    const posts = r.hits.filter((h) => h.body.kind === 'job.finished');
    expect(posts.length).toBe(2);
    expect(posts[0]!.headers['x-hopper-delivery']).toBe(posts[1]!.headers['x-hopper-delivery']);
    expect(r.taken()).toEqual([expect.objectContaining({ kind: 'job.finished', jobId: job.id })]);

    // Delivered: a later start sends it no more.
    await t.stop();
    t = await start();
    await settle();
    expect(r.hits.filter((h) => h.body.kind === 'job.finished')).toHaveLength(2);
  });
});
