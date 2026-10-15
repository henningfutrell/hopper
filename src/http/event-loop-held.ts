// Where the event loop is held, read while it is held (issue #1383). The watchdog (event-loop.ts) sees a stall only when
// the loop is free again, and then the code that held it has ended. A worker thread of its own
// (event-loop-held-worker.ts) watches a beat the main thread writes each tick; when the beat stops for HELD_MS it pauses
// the main thread through the inspector, reads the top of its stack, and resumes it. It logs that at once — the log
// says the loop is held while it is, not only after — and the watchdog names the code with the stall. Frames name the
// function and the file in the hopper's tree (`src/…`, `node_modules/…`, `node:…`), never an absolute path.
import { Worker } from 'node:worker_threads';

/** No beat for this long: the loop is held, and the worker reads where. */
export const HELD_MS = 5000;
/** How often the worker looks at the beat. */
const CHECK_MS = 1000;
/** How many reads a held spell takes at most, HELD_MS apart: one stall of minutes names what it ran over time. */
const SAMPLES = 3;
/** How many frames a read names, from the top. */
const FRAMES = 8;

/** One read of where the held loop ran: the beat it was held since (ms), how long then, the frames from the top. */
export interface HeldSample { beat: number; heldMs: number; frames: string[] }

/** What the worker is given. */
export interface HeldData { beat: SharedArrayBuffer; heldMs: number; checkMs: number; samples: number; frames: number; log: boolean }

const TREE = /\/((?:src|node_modules|ui|scripts|test)\/.*)$/;

/** A frame as the log and the event name it: `fn (src/x.ts:12)`. A path outside the hopper's tree is its file name only. */
export function frameOf(fn: string, url: string, line: number): string {
  const name = fn || '(anonymous)';
  if (!url) return `${name} (native)`;
  if (url.startsWith('node:')) return `${name} (${url}:${line})`;
  const path = url.replace(/^file:\/\//, '');
  const file = TREE.exec(path)?.[1] ?? path.slice(path.lastIndexOf('/') + 1);
  return `${name} (${file}:${line})`;
}

export const heldLine = (s: HeldSample): string =>
  `hopper: the event loop is held for ${(s.heldMs / 1000).toFixed(1)} s now; it runs ${s.frames.length ? s.frames.join(' ← ') : 'no JavaScript (native code or the garbage collector)'}`;

export interface HeldWatch {
  /** The main thread's beat, each tick of the watchdog: the time it wrote (ms since the epoch). */
  beat(): number;
  /** The reads taken while the loop was held since the beat `at`, oldest first. */
  of(at: number): HeldSample[];
  end(): Promise<void>;
}

export interface HeldOptions { heldMs?: number; checkMs?: number; samples?: number; log?: boolean }

/** The worker that reads where the loop is held; `undefined` when it cannot start (no inspector in this Node). */
export function watchHeld(o: HeldOptions = {}): HeldWatch | undefined {
  const shared = new SharedArrayBuffer(8), beat = new BigInt64Array(shared);
  Atomics.store(beat, 0, BigInt(Date.now()));
  const data: HeldData = { beat: shared, heldMs: o.heldMs ?? HELD_MS, checkMs: o.checkMs ?? CHECK_MS, samples: o.samples ?? SAMPLES, frames: FRAMES, log: o.log ?? true };
  let worker: Worker;
  try {
    worker = new Worker(new URL('./event-loop-held-worker.ts', import.meta.url), { workerData: data });
  } catch (e) {
    console.warn(`hopper: the event loop cannot be read while it is held: ${(e as Error).message}`);
    return undefined;
  }
  worker.unref();
  const samples: HeldSample[] = [];
  worker.on('message', (s: HeldSample) => { samples.push(s); if (samples.length > 3 * SAMPLES) samples.shift(); });
  worker.on('error', (e: Error) => { console.warn(`hopper: the thread that reads a held event loop ended: ${e.message}`); });
  return {
    beat: () => { const now = Date.now(); Atomics.store(beat, 0, BigInt(now)); return now; },
    of: (at) => samples.filter((s) => s.beat === at),
    end: async () => { worker.postMessage('end'); await worker.terminate(); },
  };
}
