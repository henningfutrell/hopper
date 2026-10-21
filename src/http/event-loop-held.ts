// Where the event loop is held, read while it is held (issue #1383). The watchdog (event-loop.ts) sees a stall only when
// the loop is free again, and then the code that held it has ended. A worker thread of its own
// (event-loop-held-worker.ts) watches a beat the main thread writes each tick; when the beat stops for HELD_SAMPLE_MS it pauses
// the main thread through the inspector, reads the top of its stack, and resumes it. It logs that at once — the log
// says the loop is held while it is, not only after — and the watchdog names the code with the stall. Frames name the
// function and the file in the hopper's tree (`src/…`, `node_modules/…`, `node:…`), never an absolute path.
// The health port (issue #1383): the same thread, given a port (HOPPER_HEALTH_PORT), answers `GET /api/health` there, on
// 127.0.0.1 only, so the hopper answers its health while its loop is held too: 503 and how long the loop is held then. It
// reads the beat only: it answers the instance's version and uptime, never a user's, and it changes and records nothing.
import { Worker } from 'node:worker_threads';

/** No beat for this long: the loop is held, and the health port answers 503. */
export const HELD_MS = 5000;
/**
 * No beat for this long: the worker reads where the loop runs (issue #2367). Below HELD_MS, so a stall of 2–4 s names its
 * code too; the read pauses the main thread for a moment only.
 */
export const HELD_SAMPLE_MS = 2000;
/** How often the worker looks at the beat. */
const CHECK_MS = 1000;
/** How many reads a held spell takes at most, HELD_SAMPLE_MS apart: one stall of minutes names what it ran over time. */
const SAMPLES = 4;
/** How many frames a read names, from the top. */
const FRAMES = 8;

/** One read of where the held loop ran: the beat it was held since (ms), how long then, the frames from the top. */
export interface HeldSample { beat: number; heldMs: number; frames: string[] }

/** The health port's settings: the port on 127.0.0.1 (0: any free one) and the version it answers. */
export interface HealthPortOptions { port: number; version: string }

/** What the worker is given; `startedAt`, the process's start (ms since the epoch) for the health port's uptime. */
export interface HeldData { beat: SharedArrayBuffer; heldMs: number; sampleMs: number; checkMs: number; samples: number; frames: number; log: boolean; health?: HealthPortOptions & { startedAt: number } }

/** What the worker posts: a read of the held loop, or the health port's port (absent: it could not listen). */
export type HeldMessage = { sample: HeldSample } | { health: { port?: number; problem?: string } };

/** The health port's answer when the beat is `beatAt` and the time is `now`: held for `heldMs` or more is 503. */
export function healthAnswer(o: { now: number; beatAt: number; heldMs: number; version: string; startedAt: number }): { status: number; body: { ok: boolean; version: string; uptimeS: number; eventLoopHeldMs?: number } } {
  const uptimeS = Math.floor((o.now - o.startedAt) / 1000), held = o.now - o.beatAt;
  if (held < o.heldMs) return { status: 200, body: { ok: true, version: o.version, uptimeS } };
  return { status: 503, body: { ok: false, version: o.version, uptimeS, eventLoopHeldMs: held } };
}

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
  /** The health port's port once it listens; `undefined` when none was asked for or it could not listen. */
  healthPort(): Promise<number | undefined>;
  end(): Promise<void>;
}

export interface HeldOptions { heldMs?: number; sampleMs?: number; checkMs?: number; samples?: number; log?: boolean; health?: HealthPortOptions }

/** The worker that reads where the loop is held; `undefined` when it cannot start (no inspector in this Node). */
export function watchHeld(o: HeldOptions = {}): HeldWatch | undefined {
  const shared = new SharedArrayBuffer(8), beat = new BigInt64Array(shared);
  Atomics.store(beat, 0, BigInt(Date.now()));
  const data: HeldData = {
    beat: shared, heldMs: o.heldMs ?? HELD_MS, sampleMs: o.sampleMs ?? HELD_SAMPLE_MS, checkMs: o.checkMs ?? CHECK_MS, samples: o.samples ?? SAMPLES, frames: FRAMES, log: o.log ?? true,
    ...(o.health ? { health: { ...o.health, startedAt: Date.now() - Math.round(process.uptime() * 1000) } } : {}),
  };
  let worker: Worker;
  try {
    worker = new Worker(new URL('./event-loop-held-worker.ts', import.meta.url), { workerData: data });
  } catch (e) {
    console.warn(`hopper: the event loop cannot be read while it is held: ${(e as Error).message}`);
    return undefined;
  }
  worker.unref();
  const samples: HeldSample[] = [];
  let listening: (port: number | undefined) => void = () => undefined;
  const health = o.health ? new Promise<number | undefined>((resolve) => { listening = resolve; }) : Promise.resolve(undefined);
  worker.on('message', (m: HeldMessage) => {
    if ('health' in m) {
      if (m.health.problem) console.warn(`hopper: the health port cannot answer: ${m.health.problem}`);
      listening(m.health.port);
      return;
    }
    samples.push(m.sample);
    if (samples.length > 3 * SAMPLES) samples.shift();
  });
  worker.on('error', (e: Error) => { console.warn(`hopper: the thread that reads a held event loop ended: ${e.message}`); listening(undefined); });
  return {
    beat: () => { const now = Date.now(); Atomics.store(beat, 0, BigInt(now)); return now; },
    of: (at) => samples.filter((s) => s.beat === at),
    healthPort: () => health,
    end: async () => { worker.postMessage('end'); await worker.terminate(); },
  };
}
