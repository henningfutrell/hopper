// The thread that sees the event loop held while it is held (event-loop-held.ts, issue #1383). The main thread writes a
// beat each tick into shared memory; when no beat came for `heldMs`, the main thread is held: this thread pauses it
// through the inspector, reads where it runs, resumes it at once, logs that and posts it to the main thread, which names
// it with the stall when the loop is free again. Once a held spell, at most `samples` times, `sampleMs` apart.
// Given a port, it also answers the health port (event-loop-held.ts): from the beat alone, so it answers while the main
// thread is held.
import { writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Session } from 'node:inspector';
import { parentPort, workerData } from 'node:worker_threads';
import { frameOf, healthAnswer, heldLine, type HeldData, type HeldMessage, type HeldSample } from './event-loop-held.ts';

const d = workerData as HeldData;
const beat = new BigInt64Array(d.beat);
const post = (m: HeldMessage): void => { parentPort!.postMessage(m); };

let server: Server | undefined;
if (d.health) {
  const h = d.health;
  server = createServer((req, res) => {
    const port = (server!.address() as { port: number }).port;
    // A loopback host only, as the Host guard (host-guard.ts): a page another name points here reads nothing.
    const host = req.headers.host ?? '';
    const answer = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { answer(421, { error: 'not a loopback host' }); return; }
    if ((req.url ?? '').split('?')[0] !== '/api/health') { answer(404, { error: 'the health port answers GET /api/health only' }); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { answer(405, { error: 'GET only' }); return; }
    const a = healthAnswer({ now: Date.now(), beatAt: Number(Atomics.load(beat, 0)), heldMs: d.heldMs, version: h.version, startedAt: h.startedAt });
    answer(a.status, a.body);
  });
  server.on('error', (e: Error) => { post({ health: { problem: e.message } }); });
  server.listen(h.port, '127.0.0.1', () => { post({ health: { port: (server!.address() as { port: number }).port } }); });
}

const session = new Session();
let inspector = true;
try { session.connectToMainThread(); } catch (e) {
  // No inspector in this Node: the health port still answers; the held loop is not read.
  inspector = false;
  writeSync(2, `hopper: the event loop cannot be read while it is held: ${(e as Error).message}\n`);
}

let pausing = false, spell = 0n, taken = 0, lastTaken = 0;
/** Each script's URL by its id: a paused frame names its script by id only. Sent again at each enable. */
const scripts = new Map<string, string>();
session.on('Debugger.scriptParsed', (m) => { scripts.set(m.params.scriptId, m.params.url); });

session.on('Debugger.paused', (m) => {
  // Resume first: the main thread waits on this thread while it is paused.
  session.post('Debugger.resume', () => { session.post('Debugger.disable', () => { scripts.clear(); }); });
  pausing = false;
  const frames = m.params.callFrames.slice(0, d.frames)
    .map((f) => frameOf(f.functionName, f.url || (scripts.get(f.location.scriptId) ?? ''), f.location.lineNumber + 1));
  const sample: HeldSample = { beat: Number(spell), heldMs: Date.now() - Number(spell), frames };
  if (d.log) writeSync(2, `${heldLine(sample)}\n`);
  post({ sample });
});

const timer = setInterval(() => {
  const last = Atomics.load(beat, 0), now = Date.now();
  if (last !== spell) { spell = last; taken = 0; }
  if (!inspector || pausing || taken >= d.samples || now - Number(last) < d.sampleMs || now - lastTaken < d.sampleMs) return;
  pausing = true;
  taken++;
  lastTaken = now;
  session.post('Debugger.enable', () => { session.post('Debugger.pause'); });
}, d.checkMs);

parentPort!.on('message', (m: string) => {
  if (m !== 'end') return;
  clearInterval(timer);
  server?.close();
  if (inspector) session.disconnect();
  parentPort!.close();
});
