// The worker thread a checkpoint is scrubbed in (checkpoint-scrub.ts, issue #1154): it scrubs the parts it is given,
// answers them once, and ends.
import { parentPort, workerData } from 'node:worker_threads';
import { scrubParts, type ScrubAsk } from './checkpoint-scrub.ts';

try {
  // Copied, not transferred: zlib's buffers may not be transferable, and a part is at most a few MiB packed.
  parentPort!.postMessage(scrubParts(workerData as ScrubAsk));
} catch (e) {
  parentPort!.postMessage({ error: (e as Error).message });
}
