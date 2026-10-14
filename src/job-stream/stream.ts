// One user's job stream (issue #613, design.md "The job stream"): emitting a stream event of a registered type, opening
// a watch on a request, and the sweep that ends a watch at its deadline (`hopper.expired`) or when its job ended
// (`hopper.ended`). What a watch waits on is its opener's: the stream keeps its body and never reads it.
import type { Clock } from '../domain/ports.ts';
import type { JobStreamRepository, StreamEvent, Watch } from '../domain/job-stream.ts';
import { HOPPER_STREAM_TYPES, type StreamTypes } from './types.ts';
import { INLINE_MAX } from './wire.ts';

/** How long a watch waits when its opener says nothing, and the most it may wait. */
export const WATCH_SECONDS = 3600;
export const WATCH_SECONDS_MAX = 86_400;
const SWEEP_MS = 1000;

export interface JobStreamOptions {
  repo: JobStreamRepository;
  types: StreamTypes;
  clock: Clock;
  /** The job's status when it ended (finished, failed, …); undefined while it has not. */
  ended(jobId: string): string | undefined;
  log?: (line: string) => void;
  /** Above this many bytes an event goes out as a pointer; default INLINE_MAX. */
  inlineMax?: number;
  /** How often deadlines are checked; default 1 s. */
  sweepMs?: number;
}

export interface JobStream {
  readonly inlineMax: number;
  /** Keeps an event of a registered type; one of an ending phase ends its request's watch. Throws for an unregistered type. */
  emit(jobId: string, type: string, payload: unknown, request?: string): StreamEvent;
  /** Ends `request`'s watch with an event of an ending phase: the event only when this call ended it, else undefined. */
  finish(jobId: string, request: string, type: string, payload: unknown): StreamEvent | undefined;
  /** Opens a watch on `id`, the job's request, for `seconds` (WATCH_SECONDS unless said; at most WATCH_SECONDS_MAX). */
  open(o: { id: string; jobId: string; seconds?: number; body: Record<string, string> }): Watch;
  repo: JobStreamRepository;
  /** Ends each watch past its deadline, and each whose job ended. */
  sweep(): void;
  start(): void;
  stop(): void;
}

export function createJobStream(o: JobStreamOptions): JobStream {
  const inlineMax = o.inlineMax ?? INLINE_MAX;
  let timer: NodeJS.Timeout | undefined;
  const phaseOf = (type: string) => {
    const phase = o.types.phaseOf(type);
    if (phase === undefined) throw new Error(`stream type ${type} is not registered`);
    return phase;
  };
  const s: JobStream = {
    inlineMax,
    repo: o.repo,
    emit(jobId, type, payload, request) {
      return o.repo.append({ jobId, type, phase: phaseOf(type), payload, ...(request !== undefined ? { request } : {}) });
    },
    finish(jobId, request, type, payload) {
      const phase = phaseOf(type);
      if (o.repo.watch(request)?.ended !== undefined) return undefined;
      const e = o.repo.append({ jobId, request, type, phase, payload });
      return e;
    },
    open(w) {
      const now = o.clock.now();
      const seconds = Math.min(Math.max(1, Math.floor(w.seconds ?? WATCH_SECONDS)), WATCH_SECONDS_MAX);
      const watch: Omit<Watch, 'ended'> = { id: w.id, jobId: w.jobId, body: w.body, openedAt: now.toISOString(), deadline: new Date(now.getTime() + seconds * 1000).toISOString() };
      o.repo.open(watch);
      return watch;
    },
    sweep() {
      const now = o.clock.now().toISOString();
      for (const w of o.repo.openWatches()) {
        const ended = o.ended(w.jobId);
        if (ended !== undefined) {
          s.finish(w.jobId, w.id, 'hopper.ended', `no: job ${w.jobId} is ${ended}: nothing waits on this request any more.\n`);
        } else if (w.deadline <= now) {
          s.finish(w.jobId, w.id, 'hopper.expired', `expired: no answer came before ${w.deadline}, the end of this wait. Go on without it, or ask again to wait longer.\n`);
        }
      }
    },
    start() {
      timer ??= setInterval(() => {
        try { s.sweep(); } catch (e) { o.log?.(`hopper: job stream: the sweep failed: ${(e as Error).message}`); }
      }, o.sweepMs ?? SWEEP_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return s;
}

/** The stream types the hopper itself registers. */
export const registerHopperTypes = (types: StreamTypes): void => types.register('hopper', HOPPER_STREAM_TYPES);
