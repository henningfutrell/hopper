// The heavy-step gate of one user's jobs (issue #2622 part 3, design.md "The heavy-step gate"): a job's client asks it
// before a heavy step (`POST /job/heavy`, src/http/job-heavy.ts). It keeps, in memory, the steps it let run, each on a lease
// the client renews while its command runs; a step whose job stopped renewing it is let go when its lease ends, so a job
// that died holds no slot. The rule is the decider's (src/decider/heavy-steps.ts); the machine is the job's lane's.
import { HEAVY_RETRY_S, heavyCommandText, heavyKindOf, heavyNeedOf } from '../domain/heavy-steps.ts';
import type { Clock, IdGen } from '../domain/ports.ts';
import type { Job, MachineSnapshot } from '../domain/types.ts';
import { heavyAdmits, heavyHostOf, type HeavyStep } from '../decider/heavy-steps.ts';

/** How long a slot lasts with no renewal; the client renews it every HEAVY_RENEW_S. */
export const HEAVY_LEASE_MS = 60_000;
export const HEAVY_RENEW_S = 20;

/** The gate's answer to a take: run with no slot (and why), run with this slot, or wait (and why). */
export type HeavyAnswer = { light: string } | { slot: string; renewS: number } | { wait: string; retryS: number };

export interface HeavyGate {
  take(job: Job, argv: readonly string[]): Promise<HeavyAnswer>;
  /** Keep the job's slot for another lease; false: it is not the job's, or it was let go. */
  renew(job: Job, slot: string): boolean;
  /** Let the job's slot go; false: it is not the job's, or it was let go already. */
  release(job: Job, slot: string): boolean;
  /** The steps that hold a slot now. */
  held(): HeavyStep[];
}

export function createHeavyGate(o: {
  clock: Clock; idGen: IdGen; machines: () => Promise<MachineSnapshot[]>;
  /** The machine the job runs on: its lane's. */
  machineOf: (job: Job) => string | undefined;
  /** The memory peaks of the job's repository's recent jobs (part 4); absent or failing: the estimate of its kind. */
  peaks?: (job: Job) => Promise<number[]>;
}): HeavyGate {
  const slots = new Map<string, HeavyStep & { host: string; until: number }>();
  const now = (): number => o.clock.now().getTime();
  const expire = (): void => { for (const [id, s] of slots) if (s.until <= now()) slots.delete(id); };
  const own = (job: Job, slot: string) => { expire(); const s = slots.get(slot); return s && s.jobId === job.id ? s : undefined; };
  return {
    async take(job, argv) {
      const command = heavyCommandText(argv);
      const kind = heavyKindOf(argv);
      if (!kind) return { light: `${command} is no heavy step` };
      const machineId = o.machineOf(job);
      const machines = await o.machines();
      const machine = machines.find((m) => m.id === machineId);
      const at = now();
      const host = machine ? heavyHostOf(machine, machines, at) : undefined;
      if (!host) return { light: `${machineId ?? 'its machine'} has no memory reading the gate counts` };
      const need = heavyNeedOf(kind, await (o.peaks?.(job) ?? Promise.resolve([])).catch(() => []));
      // No await from here to the slot's set: two takes at once each see the other's slot.
      expire();
      const held = [...slots.values()].filter((s) => s.host === host.key);
      const admits = heavyAdmits(host, held, kind, need.bytes, at, need.recorded);
      if (!admits.ok) return { wait: admits.reason, retryS: HEAVY_RETRY_S };
      const id = o.idGen();
      slots.set(id, { id, jobId: job.id, machineId: machine!.id, kind, bytes: need.bytes, recorded: need.recorded, command, since: new Date(at).toISOString(), host: host.key, until: at + HEAVY_LEASE_MS });
      return { slot: id, renewS: HEAVY_RENEW_S };
    },
    renew(job, slot) {
      const s = own(job, slot);
      if (s) s.until = now() + HEAVY_LEASE_MS;
      return s !== undefined;
    },
    release(job, slot) {
      return own(job, slot) !== undefined && slots.delete(slot);
    },
    held() {
      expire();
      return [...slots.values()].map(({ host: _host, until: _until, ...s }) => s);
    },
  };
}
