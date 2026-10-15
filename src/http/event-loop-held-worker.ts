// The thread that sees the event loop held while it is held (event-loop-held.ts, issue #1383). The main thread writes a
// beat each tick into shared memory; when no beat came for `heldMs`, the main thread is held: this thread pauses it
// through the inspector, reads where it runs, resumes it at once, logs that and posts it to the main thread, which names
// it with the stall when the loop is free again. Once a held spell, at most `samples` times, `heldMs` apart.
import { writeSync } from 'node:fs';
import { Session } from 'node:inspector';
import { parentPort, workerData } from 'node:worker_threads';
import { frameOf, heldLine, type HeldData, type HeldSample } from './event-loop-held.ts';

const d = workerData as HeldData;
const beat = new BigInt64Array(d.beat);
const session = new Session();
session.connectToMainThread();

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
  parentPort!.postMessage(sample);
});

const timer = setInterval(() => {
  const last = Atomics.load(beat, 0), now = Date.now();
  if (last !== spell) { spell = last; taken = 0; }
  if (pausing || taken >= d.samples || now - Number(last) < d.heldMs || now - lastTaken < d.heldMs) return;
  pausing = true;
  taken++;
  lastTaken = now;
  session.post('Debugger.enable', () => { session.post('Debugger.pause'); });
}, d.checkMs);

parentPort!.on('message', (m: string) => {
  if (m !== 'end') return;
  clearInterval(timer);
  session.disconnect();
  parentPort!.close();
});
