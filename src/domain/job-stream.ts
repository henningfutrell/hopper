// The job stream (issue #613, design.md "The job stream"): what a running job subscribes to instead of asking again
// and again. Each stream event is a type and a payload; the part that emits a type owns it and its payload, and the
// hopper reads only its phase. A watch is one request the job waits on, with a deadline. Both are kept in the user's
// database, so a restart loses neither.

/** Where a stream event leaves its request: the hopper reads this, never the payload. */
export const STREAM_PHASES = ['started', 'progress', 'waiting', 'done', 'failed', 'expired'] as const;
export type StreamPhase = (typeof STREAM_PHASES)[number];

/** The phases that end a request: its watch ends, and a stream of that request alone closes. */
export const ENDING_PHASES: readonly StreamPhase[] = ['done', 'failed', 'expired'];

/** One stream event, as the database keeps it: the job's, in order (`seq`), of one request, its payload whole. */
export interface StreamEvent {
  seq: number;
  type: string;
  /** The request it is of (a skill request's id), when it is of one. */
  request?: string;
  phase: StreamPhase;
  at: string;
  /** The emitter's: any JSON value. */
  payload: unknown;
}

/** One stream event to keep. */
export interface NewStreamEvent { jobId: string; type: string; request?: string; phase: StreamPhase; payload: unknown }

/** A request a job waits on (issue #613): open until an event of an ending phase, its deadline, or the job's end. */
export interface Watch {
  /** The request's id: its stream events carry it. */
  id: string;
  jobId: string;
  /** When the hopper ends it as expired. */
  deadline: string;
  /** What the part that opened it needs to answer it again (a skill request's fields). Opaque to the stream. */
  body: Record<string, string>;
  openedAt: string;
  /** How it ended; absent while open. */
  ended?: StreamPhase;
}

export interface JobStreamRepository {
  /** Keeps an event and its watch's end, when its phase ends one, in one step. */
  append(e: NewStreamEvent): StreamEvent;
  /** The job's events after `afterSeq`, in order; of one request when `request` is given. */
  since(jobId: string, afterSeq: number, limit: number, request?: string): StreamEvent[];
  get(jobId: string, seq: number): StreamEvent | undefined;
  open(w: Omit<Watch, 'ended'>): void;
  watch(id: string): Watch | undefined;
  /** The open watches, of one job when given, the earliest deadline first. */
  openWatches(jobId?: string): Watch[];
  /** Ends a watch still open: true when this call ended it. */
  end(id: string, how: StreamPhase): boolean;
  /** Called after each append is committed. */
  subscribe(l: (jobId: string, e: StreamEvent) => void): () => void;
}
