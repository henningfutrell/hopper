// hopper.io's instance states (issue #465 item 4, docs/design.md "Instance states at hopper.io"): the last state snapshot
// each registered instance sent on its link, kept in memory only, never in the store, under the account the instance is
// registered to (R3). hopper.io checks each snapshot against its own closed schema and a size cap (R7) before it keeps
// it. The schema is a copy of the instance's (src/domain/hopper-io-state.ts `HOPPER_IO_STATE_SCHEMA`): cloud/ may not
// import it (docs/design.md "Directories and what each must not know"), and test/cloud/instance-states.test.ts holds the
// two to one JSON Schema. A removal, an unlink, a move to another account and an account deletion drop the snapshot; a
// restart of hopper.io loses them all, and each instance sends a new one when it connects.
import { z } from 'zod';

/** The most bytes of one snapshot: a snapshot of 500 machines, each with every executor kind, fits. */
export const SNAPSHOT_MAX_BYTES = 192 * 1024;
/** The most instance states hopper.io keeps, so memory stays bounded (R7). */
export const STATES_MAX = 10_000;

const EXECUTORS = ['herdr-claude', 'claude', 'codex', 'cursor-agent', 'opencode', 'omp', 'command', 'kubernetes', 'test', 'other'] as const;
const NOT_TAKING = ['no-lanes', 'offline', 'leaving', 'drained', 'template-waiting', 'disk-low', 'work-tree', 'address', 'herdr'] as const;
const strict = z.strictObject;
const count = z.number().int().min(0);

/** The instance's state snapshot, `schema: 2`, closed at every level: the same shape the instance sends. */
export const INSTANCE_STATE_SCHEMA = strict({
  schema: z.literal(2),
  sentAt: z.iso.datetime(),
  instance: strict({ version: z.string().regex(/^(?:[0-9a-f]{4,8}|unknown)$/), channel: z.enum(['dev', 'beta', 'stable']) }),
  queue: strict({ waiting: count, running: count, locked: count, gate: z.enum(['auto-accept', 'review']) }),
  attention: strict({ questionsAwaitingOwner: count, jobsLocked: count, machinesOffline: count }),
  machines: z.array(strict({
    key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    online: z.boolean(),
    lanesInUse: count,
    lanes: count,
    executors: z.array(z.enum(EXECUTORS)).max(EXECUTORS.length),
    takesJobs: z.boolean(),
    notTaking: z.enum(NOT_TAKING).optional(),
  })).max(500),
});
export type InstanceState = z.infer<typeof INSTANCE_STATE_SCHEMA>;

/** The last snapshot of an instance, and when hopper.io got it. */
export interface KeptState { state: InstanceState; receivedAt: Date }

/** The snapshot in `text`, when it is JSON of at most SNAPSHOT_MAX_BYTES in the closed schema; else undefined. */
export function instanceState(text: string): InstanceState | undefined {
  if (Buffer.byteLength(text) > SNAPSHOT_MAX_BYTES) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return undefined; }
  const m = INSTANCE_STATE_SCHEMA.safeParse(raw);
  return m.success ? m.data : undefined;
}

export interface InstanceStates {
  /** Keeps `state` as the instance's last, under the account it is registered to. 'full': STATES_MAX others are kept. */
  keep(o: { githubUserId: string; installId: string; state: InstanceState; now: Date }): 'kept' | 'full';
  /** The instance's last snapshot, only while it was kept under `githubUserId`. */
  of(githubUserId: string, installId: string): KeptState | undefined;
  /** Drops the instance's snapshot: it was removed, unlinked or registered under another account. */
  drop(installId: string): void;
  /** Drops every snapshot of the account's instances: the account is deleted. */
  dropAccount(githubUserId: string): void;
}

export function createInstanceStates(): InstanceStates {
  const all = new Map<string, KeptState & { githubUserId: string }>();
  return {
    keep({ githubUserId, installId, state, now }) {
      if (!all.has(installId) && all.size >= STATES_MAX) return 'full';
      all.set(installId, { githubUserId, state, receivedAt: now });
      return 'kept';
    },
    of(githubUserId, installId) {
      const k = all.get(installId);
      return k && k.githubUserId === githubUserId ? { state: k.state, receivedAt: k.receivedAt } : undefined;
    },
    drop(installId) { all.delete(installId); },
    dropAccount(githubUserId) { for (const [id, k] of all) if (k.githubUserId === githubUserId) all.delete(id); },
  };
}
