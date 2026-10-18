// A TCP proxy to the test Postgres that can stop forwarding, as a network that drops packets does
// (issue #1003): the connection stays open and nothing comes back. It runs in a worker thread of its
// own, because a store call blocks the test's thread while it waits for the answer.
// It can also drop a connection at a statement (issue #1954, the crash harness): at the nth statement whose SQL holds a
// text, it ends that connection before Postgres reads it (`after: false`: the statement never ran), or once Postgres
// answered it (`after: true`: it ran and committed, and its caller never hears so).
import { Worker } from 'node:worker_threads';

const CODE = `
const net = require('node:net');
const { parentPort, workerData } = require('node:worker_threads');
let stalled = false, drop;
const server = net.createServer((client) => {
  const pg = net.connect(workerData.port, workerData.host);
  let answered = false;
  const cut = () => { client.destroy(); pg.destroy(); parentPort.postMessage({ dropped: true }); };
  client.on('data', (d) => {
    if (drop && d.includes(drop.at) && --drop.left === 0) {
      const after = drop.after;
      drop = undefined;
      if (!after) { cut(); return; }
      answered = true;
    }
    if (!stalled) pg.write(d);
  });
  pg.on('data', (d) => {
    if (answered) { cut(); return; }
    if (!stalled) client.write(d);
  });
  client.on('error', () => pg.destroy());
  pg.on('error', () => client.destroy());
  client.on('close', () => pg.destroy());
  pg.on('close', () => client.destroy());
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
parentPort.on('message', (m) => {
  if (m === 'close') { server.close(); process.exit(0); }
  if (typeof m === 'object') { drop = { at: Buffer.from(m.at), left: m.nth, after: m.after }; parentPort.postMessage({ armed: true }); return; }
  stalled = m === 'stall';
  parentPort.postMessage({ stalled });
});
`;

export interface StallingProxy {
  /** The Postgres URL through the proxy. */
  url: string;
  /** Stop forwarding (true) or forward again (false). */
  stall(on: boolean): Promise<void>;
  /** Drops the connection at the `nth` statement (from now) whose SQL holds `at`: before Postgres reads it, or after it answered. Resolves when armed; `dropped` when it happened. */
  drop(o: { at: string; nth?: number; after: boolean }): Promise<{ dropped: Promise<void> }>;
  close(): Promise<void>;
}

export async function stallingProxy(target: string): Promise<StallingProxy> {
  const t = new URL(target);
  const worker = new Worker(CODE, { eval: true, workerData: { host: t.hostname, port: Number(t.port || 5432) } });
  /** The next message that has `key`. */
  const next = (key: string): Promise<Record<string, unknown>> => new Promise((resolve) => {
    const on = (m: Record<string, unknown>): void => { if (key in m) { worker.off('message', on); resolve(m); } };
    worker.on('message', on);
  });
  const { port } = await next('port') as { port: number };
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return {
    url: url.toString(),
    stall: async (on) => { const answer = next('stalled'); worker.postMessage(on ? 'stall' : 'go'); await answer; },
    drop: async ({ at, nth = 1, after }) => {
      const armed = next('armed'), dropped = next('dropped').then(() => undefined);
      worker.postMessage({ at, nth, after });
      await armed;
      return { dropped };
    },
    close: async () => { worker.postMessage('close'); await new Promise((resolve) => worker.once('exit', resolve)); },
  };
}
