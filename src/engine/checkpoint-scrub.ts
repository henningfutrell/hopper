// A checkpoint's parts scrubbed of secrets (issue #921), off the event loop (issue #1154): an agent session's log may be
// tens of MiB, and unpacking it, masking it line by line and packing it again held the hopper's one event loop for
// seconds, every CHECKPOINT_EVERY_MS for each job at work. The scrub runs in a worker thread of its own
// (checkpoint-scrub-worker.ts), one a checkpoint, which ends with it. The same unpack counts the session's token use
// (issue #2302, the token ledger): counts only, read before the scrub, so a mask never hides a count.
import { Worker } from 'node:worker_threads';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sessionTokenUse, type SessionTokenUse } from '../domain/token-usage.ts';
import { scrubPatch, scrubSessionLog } from '../secrets/mask.ts';

/** The most a scrubbed part may grow to once unpacked: a checkpoint is at most 10 MiB compressed. */
const MAX_UNPACKED = 512 * 1024 * 1024;

/**
 * A checkpoint's parts, each gzip: the patch of the work not pushed, and the agent session's log when there is one; with
 * the session's token use once scrubbed (`use`).
 */
export interface CheckpointParts { patch: Buffer; session?: Buffer; use?: SessionTokenUse }

/**
 * What a scrub is given: the parts, and the values of the vault secrets delivered to the job (issue #1957), masked by
 * value. `countOnly`: only the session's token use is wanted, nothing scrubbed or kept (the read as a run ends).
 */
export interface ScrubAsk { patch: Uint8Array; session?: Uint8Array | undefined; held?: readonly string[] | undefined; countOnly?: boolean }

const unpacked = (gz: Uint8Array, encoding: BufferEncoding): string => gunzipSync(gz, { maxOutputLength: MAX_UNPACKED }).toString(encoding);

/** The parts scrubbed here, on the calling thread: what the worker runs. A `countOnly` ask answers an empty patch and the use. */
export function scrubParts(t: ScrubAsk): CheckpointParts {
  const held = t.held ?? [];
  const log = t.session ? unpacked(t.session, 'utf8') : undefined;
  const use = log !== undefined ? { use: sessionTokenUse(log) } : {};
  if (t.countOnly) return { patch: Buffer.alloc(0), ...use };
  // `latin1` keeps a patch's bytes as they were.
  const patch = gzipSync(Buffer.from(scrubPatch(unpacked(t.patch, 'latin1'), held), 'latin1'));
  return { patch, ...(log !== undefined ? { session: gzipSync(Buffer.from(scrubSessionLog(log, held), 'utf8')) } : {}), ...use };
}

const asBuffer = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

/** The parts scrubbed in a worker thread; rejects with the worker's error. */
export function scrubCheckpoint(t: Omit<CheckpointParts, 'use'> & Pick<ScrubAsk, 'held' | 'countOnly'>): Promise<CheckpointParts> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./checkpoint-scrub-worker.ts', import.meta.url), { workerData: t });
    let answered = false;
    worker.once('message', (m: { patch: Uint8Array; session?: Uint8Array; use?: SessionTokenUse } | { error: string }) => {
      answered = true;
      if ('error' in m) reject(new Error(m.error));
      else resolve({ patch: asBuffer(m.patch), ...(m.session ? { session: asBuffer(m.session) } : {}), ...(m.use ? { use: m.use } : {}) });
    });
    worker.once('error', (e) => { answered = true; reject(e); });
    worker.once('exit', (code) => { if (!answered) reject(new Error(`the checkpoint's scrub ended with code ${code} and no answer`)); });
  });
}
