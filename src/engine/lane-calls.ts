// Decider calls in lane tuning (issue #688, design.md "Lane tuning", "Decider calls"): Jev first (issue #550) for a
// machine's lanes and a waiting job's machine, with the rules as the fallback. `lane-count` is asked when the rules'
// recommendation of a machine changes, over the lanes the rules allow; an applied pick is the machine's recommendation,
// which an admin still applies. `job-machine` is asked once per waiting spell of a job that more than one machine can
// take; an applied pick goes to the decider, which takes it first where the job may go. A pick that comes after the job
// got its machine is compared with that machine at once. Neither is consequential but on a machine the blast-radius
// gate keeps: such a machine is no option of `job-machine`, and its lanes are never Jev's.
import { laneCountOptions } from '../decider/lane-calls.ts';
import { jobCostKind } from '../decider/job-costs.ts';
import type {
  ExpectedCost, Job, JevLanes, LaneLoad, LaneProgress, LaneRecommendation, LaneReliability, MachineSnapshot, MinorDecisionOption, PlacementPick,
} from '../domain/types.ts';
import { consequentialOf } from '../minor-decisions/guard.ts';
import type { EngineContext } from './context.ts';

const LANE_COUNT_INSTRUCTIONS = 'Pick how many lanes (jobs at once) this machine should run. Its resource history, the failures at each lane count, '
  + 'its lanes\' reliability and the usage it burns against the usage limits are given. Fewer lanes when usage is near a limit or the machine '
  + 'shows pressure or failures; more only where the history shows room. Every option is within what the rules found safe.';
const JOB_MACHINE_INSTRUCTIONS = 'Pick the machine this waiting job should run on. Each machine\'s lanes, its last resource reading and its '
  + 'lanes\' reliability are given, and the job\'s expected cost when its history shows one. Prefer a machine with room for the job and '
  + 'reliable lanes.';
/** At most this many `job-machine` asks at once. */
const MAX_PLACEMENT_ASKS = 4;
const WAITING: readonly string[] = ['queued', 'held'];

/** One machine's lanes' reliability, in the words Jev reads. */
const reliabilityOf = (lanes: readonly LaneReliability[], machineId: string) => lanes.filter((l) => l.machineId === machineId).map((l) => ({
  lane: l.laneId, runs: l.runs, failed: l.failed, laneFaults: l.laneFaults, score: Math.round(l.score * 100) / 100,
  ...(l.successRate !== undefined ? { successRate: Math.round(l.successRate * 100) / 100 } : {}),
}));

const resourcesOf = (m: MachineSnapshot) => (m.resources ? {
  ...(m.resources.cpuBusyFrac !== undefined ? { cpuBusy: Math.round(m.resources.cpuBusyFrac * 100) / 100 } : {}),
  ...(m.resources.memTotalBytes > 0 ? { memoryUsed: Math.round((1 - m.resources.memAvailableBytes / m.resources.memTotalBytes) * 100) / 100 } : {}),
} : undefined);

export interface LaneCallDeps {
  gated(machineId: string): boolean;
  /** Every lane's reliability now (issue #535). */
  reliability(): Promise<readonly LaneReliability[]>;
}

/**
 * Ask Jev for a machine's lanes at the rules' recommendation `r`. Its applied pick, or undefined: Jev not asked, not
 * sure, in shadow, or nothing to pick.
 */
export async function askLaneCount(c: EngineContext, d: LaneCallDeps, r: LaneRecommendation, history: { loads: readonly LaneLoad[]; progress: readonly LaneProgress[]; soft: number; hard: number }): Promise<JevLanes | undefined> {
  const options = laneCountOptions(r);
  if (options.length === 0) return undefined;
  const id = r.machineId;
  const out = await c.jevFirst.decide({
    point: 'lane-count', machineId: id, instructions: LANE_COUNT_INSTRUCTIONS, options,
    state: {
      machine: r.label ?? id, configured: r.configured, headroom: r.headroom, rules: { lanes: r.lanes, reason: r.reason, confidence: r.confidence },
      usage: { band: r.usage, usedFrac: Math.round(r.usedFrac * 100) / 100, softLimit: history.soft, hardLimit: history.hard },
      bounds: { minLanes: r.tuning.minLanes, maxLanes: r.tuning.maxLanes },
      laneLoad: history.loads.filter((l) => l.machineId === id).map((l) => ({
        lanesBusy: l.lanesBusy, samples: l.samples, pressured: l.pressured,
        ...(l.cpuAvg !== undefined ? { cpuBusy: Math.round(l.cpuAvg * 100) / 100 } : {}),
        ...(l.memUsedAvgBytes !== undefined && l.memTotalBytes ? { memoryUsed: Math.round((l.memUsedAvgBytes / l.memTotalBytes) * 100) / 100 } : {}),
      })),
      laneProgress: history.progress.filter((p) => p.machineId === id).map((p) => ({ lanesBusy: p.lanesBusy, runs: p.runs, failed: p.failed })),
      laneReliability: reliabilityOf(await d.reliability(), id),
    },
    consequential: consequentialOf([], d.gated(id) ? { gatedMachine: id } : {}),
  });
  if (!out.asked || !out.applied || out.pick === undefined || !options.some((o) => o.id === out.pick)) return undefined;
  return { lanes: Number(out.pick), confidence: out.confidence ?? 0, rulesLanes: r.lanes, configured: r.configured };
}

export interface PlacementPicks {
  /** Ask Jev for a waiting job's machine, once per waiting spell; `since`: when it was seen waiting. Never throws. */
  ask(jobId: string, since: string): void;
  /** Ask for every waiting job not asked yet: after a restart, or past the cap on asks at once. */
  sweep(): void;
  /** The job got a lane, or left the queue: its pick goes, and a later waiting spell asks again. */
  forget(jobId: string): void;
  /** The applied picks of these waiting jobs, for the Decision; undefined: none. */
  input(waiting: readonly Job[]): Record<string, PlacementPick> | undefined;
}

export function createPlacementPicks(c: EngineContext, d: LaneCallDeps & { expected(job: Job): ExpectedCost | undefined }): PlacementPicks {
  const asked = new Set<string>();
  const picks = new Map<string, PlacementPick>();
  let inFlight = 0;

  /** The machine the job got at or after `since`, from its claim. */
  const claimedOn = (jobId: string, since: string): string | undefined =>
    c.store.events.between(['job.claimed'], since).find((e) => e.jobId === jobId)?.machineId;

  async function run(job: Job, since: string): Promise<void> {
    const machines = (await c.machines.list()).filter((m) => m.online && m.executors.includes(job.spec.executor) && !m.workTreeProblem && !d.gated(m.id));
    if (machines.length < 2 || c.stopping()) return;
    const lanes = c.store.lanes.list();
    const reliability = await d.reliability();
    const options: MinorDecisionOption[] = machines.map((m) => {
      const inUse = lanes.filter((l) => l.machineId === m.id && l.state !== 'idle').length;
      return { id: m.id, label: `${m.label} (${m.id}): ${m.maxLanes} lanes, ${inUse} in use` };
    });
    const expected = d.expected(job);
    const out = await c.jevFirst.decide({
      point: 'job-machine', jobId: job.id, instructions: JOB_MACHINE_INSTRUCTIONS, options,
      state: {
        job: {
          executor: job.spec.executor, priority: job.priority, kind: jobCostKind(job.spec), ...(job.source?.repo ? { repo: job.source.repo } : {}),
          ...(expected ? { expectedCost: expected } : {}),
        },
        machines: machines.map((m) => ({
          id: m.id, label: m.label, lanes: m.maxLanes, inUse: lanes.filter((l) => l.machineId === m.id && l.state !== 'idle').length,
          ...(resourcesOf(m) ? { resources: resourcesOf(m) } : {}), laneReliability: reliabilityOf(reliability, m.id),
        })),
      },
      consequential: [],
      settled: () => { const on = claimedOn(job.id, since); return on ? { actual: on, by: 'placement' } : undefined; },
    });
    if (out.asked && out.applied && out.pick !== undefined && asked.has(job.id)) {
      picks.set(job.id, { machineId: out.pick, confidence: out.confidence ?? 0 });
      c.trigger('job-machine picked');
    }
  }

  const ask = (jobId: string, since: string): void => {
    const job = c.store.jobs.get(jobId);
    if (!job || asked.has(jobId) || inFlight >= MAX_PLACEMENT_ASKS || c.stopping()) return;
    // A pinned job has its machine; a job resuming returns to its pane.
    if (!WAITING.includes(job.status) || job.spec.machineId !== undefined || job.pendingAnswer !== undefined) return;
    asked.add(jobId);
    inFlight += 1;
    void run(job, since)
      .catch((e: unknown) => { console.warn(`hopper: asking Jev for job ${jobId}'s machine failed: ${e instanceof Error ? e.message : String(e)}`); })
      .finally(() => { inFlight -= 1; });
  };

  return {
    ask,
    sweep() {
      const since = c.clock.now().toISOString();
      for (const job of c.store.jobs.list({ status: ['queued', 'held'] })) ask(job.id, since);
    },
    forget(jobId) { asked.delete(jobId); picks.delete(jobId); },
    input(waiting) {
      const known = waiting.flatMap((j) => { const p = picks.get(j.id); return p ? [[j.id, p] as const] : []; });
      return known.length ? Object.fromEntries(known) : undefined;
    },
  };
}
