// A checkpoint's parts scrubbed of secrets (issue #921), off the event loop (issue #1154): an agent session's log may be
// tens of MiB, and unpacking it, masking it line by line and packing it again held the hopper's one event loop for
// seconds, every CHECKPOINT_EVERY_MS for each job at work. The scrub runs in a worker thread of its own
// (checkpoint-scrub-worker.ts), one a checkpoint, which ends with it.
import { Worker } from 'node:worker_threads';
import { gunzipSync, gzipSync } from 'node:zlib';
import { scrubPatch, scrubSessionLog } from '../secrets/mask.ts';

/** The most a scrubbed part may grow to once unpacked: a checkpoint is at most 10 MiB compressed. */
const MAX_UNPACKED = 512 * 1024 * 1024;

/** A checkpoint's parts, each gzip: the patch of the work not pushed, and the agent session's log when there is one. */
export interface CheckpointParts { patch: Buffer; session?: Buffer }

/** A part scrubbed of secrets (`scrub`), compressed again. `latin1` keeps a patch's bytes as they were. */
const scrubbed = (gz: Uint8Array, scrub: (text: string) => string, encoding: BufferEncoding): Buffer =>
  gzipSync(Buffer.from(scrub(gunzipSync(gz, { maxOutputLength: MAX_UNPACKED }).toString(encoding)), encoding));

/** The parts scrubbed here, on the calling thread: what the worker runs. */
export function scrubParts(t: { patch: Uint8Array; session?: Uint8Array | undefined }): CheckpointParts {
  return { patch: scrubbed(t.patch, scrubPatch, 'latin1'), ...(t.session ? { session: scrubbed(t.session, scrubSessionLog, 'utf8') } : {}) };
}

const asBuffer = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

/** The parts scrubbed in a worker thread; rejects with the worker's error. */
export function scrubCheckpoint(t: CheckpointParts): Promise<CheckpointParts> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./checkpoint-scrub-worker.ts', import.meta.url), { workerData: t });
    let answered = false;
    worker.once('message', (m: { patch: Uint8Array; session?: Uint8Array } | { error: string }) => {
      answered = true;
      if ('error' in m) reject(new Error(m.error));
      else resolve({ patch: asBuffer(m.patch), ...(m.session ? { session: asBuffer(m.session) } : {}) });
    });
    worker.once('error', (e) => { answered = true; reject(e); });
    worker.once('exit', (code) => { if (!answered) reject(new Error(`the checkpoint's scrub ended with code ${code} and no answer`)); });
  });
}
