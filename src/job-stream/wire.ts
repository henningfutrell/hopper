// A stream event on the wire (issue #613): whole when it is small, else a pointer to its result. `wireEvent` alone
// decides, and the result a pointer names is `resultOf` the same event, so the two cannot drift apart. The payload is
// the last field: a shell reader (hopper-skill) finds it at the end of the line.
import type { StreamEvent } from '../domain/job-stream.ts';

/** The route a running job subscribes at. */
export const STREAM_PATH = '/job/stream';
/** Where a pointer's result is fetched: `<RESULT_PATH>/<seq>`. */
export const RESULT_PATH = `${STREAM_PATH}/results`;
/** Above this many bytes, an event goes out as a pointer. */
export const INLINE_MAX = 4096;

/** A pointer to a result: where to fetch it, and its size in bytes. */
export interface ResultRef { url: string; bytes: number }
export type WireEvent = StreamEvent | (Omit<StreamEvent, 'payload'> & { ref: ResultRef });

/** The event in its one key order, the payload last. */
const ordered = (e: StreamEvent): StreamEvent => ({
  seq: e.seq, type: e.type, ...(e.request !== undefined ? { request: e.request } : {}), phase: e.phase, at: e.at, payload: e.payload,
});

/** The result a pointer names: the whole event, as JSON. */
export const resultOf = (e: StreamEvent): string => JSON.stringify(ordered(e));

/** The event, or a pointer to it when its result is over `inlineMax` bytes. */
export function wireEvent(e: StreamEvent, inlineMax: number): WireEvent {
  const whole = ordered(e);
  const bytes = Buffer.byteLength(JSON.stringify(whole));
  if (bytes <= inlineMax) return whole;
  const { payload: _payload, ...rest } = whole;
  return { ...rest, ref: { url: `${RESULT_PATH}/${e.seq}`, bytes } };
}

/** One SSE frame: the seq as its id (what Last-Event-ID answers with), the type as its event name. */
export const sseFrame = (e: StreamEvent, inlineMax: number): string =>
  `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(wireEvent(e, inlineMax))}\n\n`;
