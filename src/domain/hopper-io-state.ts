// The hopper.io state snapshot (issue #466 part 1, design.md "The hopper.io state snapshot"): what an instance may send
// on its cloud link for the dashboard, and how it is made from the instance's own state. The allow-list of
// docs/hopper-io-security.md R5 is this schema: counts, closed enums and an opaque machine key, never free text. Pure:
// `sentAt` and the machine key are passed in. Nothing here sends anything.
import { z } from 'zod';
import { QUEUE_GATE_MODES, type QueueGate } from './queue-gate.ts';
import type { QuestionStatus } from './questions.ts';
import type { Lane, MachineSnapshot } from './types.ts';
import { UPDATE_CHANNELS, type UpdateChannel } from './update.ts';

/**
 * Why a machine takes no new job, in the decider's order (`idleReason`, src/decider/lanes.ts). A closed list: the
 * machine's own problem text (`workTreeProblem`, `addressProblem`, `herdrProblem`) can hold paths and host names, so
 * only its kind goes out.
 */
export const HOPPER_IO_NOT_TAKING = ['no-lanes', 'offline', 'leaving', 'drained', 'template-waiting', 'disk-low', 'work-tree', 'address', 'herdr'] as const;
export type HopperIoNotTaking = (typeof HOPPER_IO_NOT_TAKING)[number];

/**
 * The kinds of executor a machine offers (issue #465 item 4): the built-in executor plugins' ids, and `other` for any
 * other plugin. A machine's executors are instance names the plugins config gives them, which can hold a host name, so
 * only the plugin's kind goes out. A new built-in executor is listed here (the test checks the list).
 */
export const HOPPER_IO_EXECUTORS = ['herdr-claude', 'claude', 'codex', 'cursor-agent', 'opencode', 'omp', 'command', 'kubernetes', 'test', 'other'] as const;
export type HopperIoExecutor = (typeof HOPPER_IO_EXECUTORS)[number];
const KNOWN_EXECUTORS: ReadonlySet<string> = new Set(HOPPER_IO_EXECUTORS.filter((e) => e !== 'other'));

const strict = z.strictObject;
const count = z.number().int().min(0);

/** The snapshot, version 1, closed at every level: a key outside it is refused. A new field bumps `schema`. */
export const HOPPER_IO_STATE_SCHEMA = strict({
  schema: z.literal(2),
  sentAt: z.iso.datetime(),
  instance: strict({ version: z.string().regex(/^(?:[0-9a-f]{4,8}|unknown)$/), channel: z.enum(UPDATE_CHANNELS) }),
  queue: strict({ waiting: count, running: count, locked: count, gate: z.enum(QUEUE_GATE_MODES) }),
  attention: strict({ questionsAwaitingOwner: count, jobsLocked: count, machinesOffline: count }),
  machines: z.array(strict({
    key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    online: z.boolean(),
    lanesInUse: count,
    lanes: count,
    executors: z.array(z.enum(HOPPER_IO_EXECUTORS)).max(HOPPER_IO_EXECUTORS.length),
    takesJobs: z.boolean(),
    notTaking: z.enum(HOPPER_IO_NOT_TAKING).optional(),
  })).max(500),
});
export type HopperIoState = z.infer<typeof HOPPER_IO_STATE_SCHEMA>;
export type HopperIoMachine = HopperIoState['machines'][number];

/**
 * What the snapshot is made from: the instance's machines and lanes (GET /api/machines), its queue (GET /api/queue), its
 * open questions, a parked job's too (GET /api/questions, issue #2634), its installed version and channel (GET /api/update).
 * `machineKey`: an opaque, stable key for a machine id, never the id itself (the cloud link derives it, issue #464).
 */
export interface HopperIoStateInputs {
  sentAt: string;
  installed: { commit: string } | undefined;
  channel: UpdateChannel;
  machines: readonly MachineSnapshot[];
  lanes: readonly Pick<Lane, 'machineId' | 'state'>[];
  queue: { waiting: readonly unknown[]; running: readonly unknown[]; locked: readonly unknown[]; gate: QueueGate };
  questions: readonly { id: string; jobId: string; status: QuestionStatus; tier: string }[];
  machineKey: (machineId: string) => string;
  /** The plugin id of a configured executor instance, by its name; undefined: no such instance. */
  executorPlugin: (executor: string) => string | undefined;
}

/** The kinds of executor `names` are, each once, in name order; an unknown plugin or name is `other`. */
function executorKinds(names: readonly string[], pluginOf: (executor: string) => string | undefined): HopperIoExecutor[] {
  const kinds = new Set(names.map((n): HopperIoExecutor => { const p = pluginOf(n); return p !== undefined && KNOWN_EXECUTORS.has(p) ? p as HopperIoExecutor : 'other'; }));
  return [...kinds].sort();
}

/** Why `m` takes no new job, in the decider's order; undefined: it takes jobs. */
export function notTaking(m: MachineSnapshot): HopperIoNotTaking | undefined {
  if (m.maxLanes === 0) return 'no-lanes';
  if (!m.online) return 'offline';
  if (m.leaving) return 'leaving';
  if (m.drained) return 'drained';
  if (m.template?.waiting) return 'template-waiting';
  if (m.disk?.low) return 'disk-low';
  if (m.workTreeProblem !== undefined) return 'work-tree';
  if (m.addressProblem !== undefined) return 'address';
  if (m.herdrProblem !== undefined) return 'herdr';
  return undefined;
}

/** The snapshot of `i`: only what the schema holds, every field built here, nothing copied through. */
export function projectHopperIoState(i: HopperIoStateInputs): HopperIoState {
  const machines = i.machines.map((m): HopperIoMachine => {
    const why = notTaking(m);
    return {
      key: i.machineKey(m.id),
      online: m.online,
      lanesInUse: i.lanes.filter((l) => l.machineId === m.id && l.state !== 'idle').length,
      lanes: m.maxLanes,
      executors: executorKinds(m.executors, i.executorPlugin),
      takesJobs: why === undefined,
      ...(why ? { notTaking: why } : {}),
    };
  });
  return {
    schema: 2,
    sentAt: i.sentAt,
    instance: { version: i.installed ? i.installed.commit.slice(0, 8) : 'unknown', channel: i.channel },
    queue: { waiting: i.queue.waiting.length, running: i.queue.running.length, locked: i.queue.locked.length, gate: i.queue.gate.mode },
    attention: {
      questionsAwaitingOwner: i.questions.filter((q) => q.status === 'open' && q.tier === 'human').length,
      jobsLocked: i.queue.locked.length,
      machinesOffline: i.machines.filter((m) => !m.online).length,
    },
    machines,
  };
}
