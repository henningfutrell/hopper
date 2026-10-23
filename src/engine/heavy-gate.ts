// The heavy-step gate of one user's jobs (issue #2622 part 3, design.md "The heavy-step gate"): a job's client asks it
// before a heavy step (`POST /job/heavy`, src/http/job-heavy.ts). It keeps, in memory, the steps it let run, each on a lease
// the client renews while its command runs; a step whose job stopped renewing it is let go when its lease ends, so a job
// that died holds no slot. The rule is the decider's (src/decider/heavy-steps.ts); the machine is the job's lane's. Part 5:
// at each renew the gate reads its host again and sheds (`heavyShed`): under memory pressure the renew of the newest step
// that runs answers `pause`, and its client stops the step until a renew answers none. Part 7: it also keeps, in memory, the
// steps that wait, while their jobs ask again, so the Machines page shows what runs, what is paused and what waits, and why.
import { HEAVY_RETRY_S, heavyCommandText, heavyKindOf, heavyNeedOf, type HeavyKind, type HeavyStepView } from '../domain/heavy-steps.ts';
import type { Clock, IdGen } from '../domain/ports.ts';
import type { Job, MachineSnapshot } from '../domain/types.ts';
import { heavyAdmits, heavyHostOf, heavyShed, type HeavyStep } from '../decider/heavy-steps.ts';

/** How long a slot lasts with no renewal; the client renews it every HEAVY_RENEW_S, so a pause reaches it within 30 s. */
export const HEAVY_LEASE_MS = 60_000;
export const HEAVY_RENEW_S = 10;
/** A wait is shown while its job asks again within this time; it asks every HEAVY_RETRY_S. */
export const HEAVY_WAIT_SEEN_MS = 3 * HEAVY_RETRY_S * 1000;

/** The gate's answer to a take: run with no slot (and why), run with this slot, or wait (and why). */
export type HeavyAnswer = { light: string } | { slot: string; renewS: number } | { wait: string; retryS: number };

export interface HeavyGate {
  take(job: Job, argv: readonly string[]): Promise<HeavyAnswer>;
  /**
   * Keep the job's slot for another lease; `ok` false: it is not the job's, or it was let go. `pause`: the step is paused
   * for memory pressure, and why (part 5); absent, it runs.
   */
  renew(job: Job, slot: string): Promise<{ ok: boolean; pause?: string }>;
  /** Let the job's slot go; false: it is not the job's, or it was let go already. */
  release(job: Job, slot: string): boolean;
  /** The steps that hold a slot now. */
  held(): HeavyStep[];
  /** Part 7: the steps that hold a slot, then those that wait, oldest first, each with why it is paused or waits. */
  view(): HeavyStepView[];
}

export function createHeavyGate(o: {
  clock: Clock; idGen: IdGen; machines: () => Promise<MachineSnapshot[]>;
  /** The machine the job runs on: its lane's. */
  machineOf: (job: Job) => string | undefined;
  /** The memory peaks of the job's repository's recent jobs (part 4); absent or failing: the estimate of its kind. */
  peaks?: (job: Job) => Promise<number[]>;
}): HeavyGate {
  const slots = new Map<string, HeavyStep & { host: string; until: number; reason?: string }>();
  /** Part 5: when the shed last paused or let run a step of each host. */
  const changed = new Map<string, number>();
  /** Part 7: each job's step that waits, by job: since its first ask, and when it last asked. */
  const waits = new Map<string, HeavyStepView & { seen: number }>();
  const now = (): number => o.clock.now().getTime();
  const expire = (): void => {
    for (const [id, s] of slots) if (s.until <= now()) slots.delete(id);
    for (const [id, w] of waits) if (now() - w.seen > HEAVY_WAIT_SEEN_MS) waits.delete(id);
  };
  const waited = (job: Job, machineId: string, kind: HeavyKind, command: string, reason: string, at: number): void => {
    const was = waits.get(job.id);
    const since = was && was.command === command ? was.since : new Date(at).toISOString();
    waits.set(job.id, { jobId: job.id, machineId, kind, command, since, waiting: true, reason, seen: at });
  };
  const own = (job: Job, slot: string) => { expire(); const s = slots.get(slot); return s && s.jobId === job.id ? s : undefined; };
  const hostOf = async (job: Job) => {
    const machineId = o.machineOf(job);
    const machines = await o.machines();
    const machine = machines.find((m) => m.id === machineId);
    return { machineId, machine, host: machine ? heavyHostOf(machine, machines, now()) : undefined };
  };
  return {
    async take(job, argv) {
      const command = heavyCommandText(argv);
      const kind = heavyKindOf(argv);
      if (!kind) return { light: `${command} is no heavy step` };
      const { machineId, machine, host } = await hostOf(job);
      if (!host) { waits.delete(job.id); return { light: `${machineId ?? 'its machine'} has no memory reading the gate counts` }; }
      const need = heavyNeedOf(kind, await (o.peaks?.(job) ?? Promise.resolve([])).catch(() => []));
      // No await from here to the slot's set: two takes at once each see the other's slot.
      const at = now();
      expire();
      const held = [...slots.values()].filter((s) => s.host === host.key);
      const admits = heavyAdmits(host, held, kind, need.bytes, at, need.recorded);
      if (!admits.ok) { waited(job, machine!.id, kind, command, admits.reason, at); return { wait: admits.reason, retryS: HEAVY_RETRY_S }; }
      waits.delete(job.id);
      const id = o.idGen();
      slots.set(id, { id, jobId: job.id, machineId: machine!.id, kind, bytes: need.bytes, recorded: need.recorded, command, since: new Date(at).toISOString(), host: host.key, until: at + HEAVY_LEASE_MS });
      return { slot: id, renewS: HEAVY_RENEW_S };
    },
    async renew(job, slot) {
      if (!own(job, slot)) return { ok: false };
      const { host } = await hostOf(job).catch(() => ({ host: undefined }));
      const s = own(job, slot);
      if (!s) return { ok: false };
      const at = now();
      s.until = at + HEAVY_LEASE_MS;
      const held = [...slots.values()].filter((x) => x.host === s.host);
      const plan = host?.key === s.host ? heavyShed(host, held, at, changed.get(s.host)) : undefined;
      if (plan) {
        const target = slots.get('pause' in plan ? plan.pause : plan.resume)!;
        if ('pause' in plan) Object.assign(target, { paused: new Date(at).toISOString(), reason: plan.reason });
        else { delete target.paused; delete target.reason; }
        changed.set(s.host, at);
      }
      return { ok: true, ...(s.paused && s.reason ? { pause: s.reason } : {}) };
    },
    release(job, slot) {
      return own(job, slot) !== undefined && slots.delete(slot);
    },
    held() {
      expire();
      return [...slots.values()].map(({ host: _host, until: _until, reason: _reason, ...s }) => s);
    },
    view() {
      expire();
      const held = [...slots.values()].map(({ id: _id, host: _host, until: _until, ...s }): HeavyStepView => s);
      const waiting = [...waits.values()].map(({ seen: _seen, ...w }) => w);
      const bySince = (a: HeavyStepView, b: HeavyStepView): number => a.since.localeCompare(b.since) || a.jobId.localeCompare(b.jobId);
      return [...held.sort(bySince), ...waiting.sort(bySince)];
    },
  };
}
