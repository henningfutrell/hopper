// The queue from the command line (issues #374, #874, design.md "Operator actions from the CLI"): `hopper queue list`, the
// waiting jobs, each held one with why it is held, then the jobs on their own wait, each with what it waits on (issue #1780);
// `hopper queue order`, the user order; `hopper queue gate`, the queue gate.
import { parseArgs } from 'node:util';
import { QUEUE_GATE_MODES, type Job, type QueueGate } from './domain/types.ts';
import { waitOnLabel } from './domain/wait-on.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const QUEUE_USAGE = `  hopper queue list                                  the waiting jobs, first to run first: each its state, and why it is held or waits;
                                                     then the jobs on their own wait, each with what it waits on (waitsOn, waitsFor)
  hopper queue order <id>...                         the user order: these waiting jobs, first to last, before every other
  hopper queue gate <mode> [--per-hour <n>|none]     the queue gate: ${QUEUE_GATE_MODES.join(' or ')}; auto-accept at most <n> an hour`;

/**
 * What a job on its own wait waits on, in words (issue #1780): `waitsOn`, its typed `wait.on`; `waitsFor`, its `for:` text;
 * `waitingSince`; `strandedSince`, when its agent session ended (issue #1779). None for any other job.
 */
export function ownWaitOf(job: Job): Record<string, string> {
  const w = job.status === 'waiting_on' ? job.wait : undefined;
  return w ? { waitsOn: w.on ? waitOnLabel(w.on) : 'nothing recorded', waitsFor: w.for, waitingSince: w.since, ...(w.strandedAt ? { strandedSince: w.strandedAt } : {}) } : {};
}

/** A waiting job in short (issue #874): what it is, where it stands, and why it is held (`holdReason`), waits (`waitReason`) or what it waits on. */
function jobInShort(job: Job): Record<string, unknown> {
  return {
    id: job.id, title: job.source?.title ?? job.spec.goal, status: job.status, priority: job.priority,
    ...(job.accepted === false ? { accepted: false } : {}), ...(job.laneId ? { lane: job.laneId } : {}),
    ...(job.holdReason ? { holdReason: job.holdReason } : {}), ...(job.waitReason ? { waitReason: job.waitReason } : {}), ...ownWaitOf(job),
  };
}

function perHour(raw: string): number | null {
  if (raw === 'none') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new OperatorRefusal(`--per-hour must be a whole number of at least 1, or none; not ${raw}`);
  return n;
}

export function queueCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'per-hour': { type: 'string' } } });
  const [verb, ...rest] = positionals;
  if (verb === 'list' && rest.length === 0 && values['per-hour'] === undefined) {
    return { role: 'viewer', path: '/api/queue', pick: (q) => { const { waiting, waitingOn } = q as { waiting: Job[]; waitingOn: Job[] }; return [...waiting, ...waitingOn].map(jobInShort); } };
  }
  if (verb === 'order' && values['per-hour'] === undefined) {
    if (rest.length === 0) throw usage('queue order <id>...');
    return { role: 'operator', path: '/ui/api/queue/order', body: async () => ({ jobIds: rest }) };
  }
  if (verb === 'gate' && rest.length === 1) {
    const mode = rest[0]!;
    if (!(QUEUE_GATE_MODES as readonly string[]).includes(mode)) throw new OperatorRefusal(`unknown queue gate ${mode}; one of ${QUEUE_GATE_MODES.join(', ')}`);
    const raw = values['per-hour'];
    const limit = raw === undefined ? undefined : perHour(raw);
    // Without --per-hour the throttle stays as it is.
    return { role: 'admin', path: '/ui/api/queue-gate', body: async (get) => ({
      mode, autoAcceptPerHour: limit !== undefined ? limit : ((await get('/api/queue')) as { gate: QueueGate }).gate.autoAcceptPerHour,
    }) };
  }
  throw usage('queue list | hopper queue order <id>... | hopper queue gate <mode> [--per-hour <n>|none]');
}
