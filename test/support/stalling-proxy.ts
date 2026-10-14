// A TCP proxy to the test Postgres that can stop forwarding, as a network that drops packets does
// (issue #1003): the connection stays open and nothing comes back. It runs in a worker thread of its
// own, because a store call blocks the test's thread while it waits for the answer.
import { Worker } from 'node:worker_threads';

const CODE = `
const net = require('node:net');
const { parentPort, workerData } = require('node:worker_threads');
let stalled = false;
const server = net.createServer((client) => {
  const pg = net.connect(workerData.port, workerData.host);
  client.on('data', (d) => { if (!stalled) pg.write(d); });
  pg.on('data', (d) => { if (!stalled) client.write(d); });
  client.on('error', () => pg.destroy());
  pg.on('error', () => client.destroy());
  client.on('close', () => pg.destroy());
  pg.on('close', () => client.destroy());
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
parentPort.on('message', (m) => {
  if (m === 'close') { server.close(); process.exit(0); }
  stalled = m === 'stall';
  parentPort.postMessage({ stalled });
});
`;

export interface StallingProxy {
  /** The Postgres URL through the proxy. */
  url: string;
  /** Stop forwarding (true) or forward again (false). */
  stall(on: boolean): Promise<void>;
  close(): Promise<void>;
}

export async function stallingProxy(target: string): Promise<StallingProxy> {
  const t = new URL(target);
  const worker = new Worker(CODE, { eval: true, workerData: { host: t.hostname, port: Number(t.port || 5432) } });
  const next = (): Promise<Record<string, unknown>> => new Promise((resolve) => worker.once('message', resolve));
  const { port } = await next() as { port: number };
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return {
    url: url.toString(),
    stall: async (on) => { const answer = next(); worker.postMessage(on ? 'stall' : 'go'); await answer; },
    close: async () => { worker.postMessage('close'); await new Promise((resolve) => worker.once('exit', resolve)); },
  };
}
