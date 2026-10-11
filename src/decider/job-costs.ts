// Job cost profiles (issue #688, design.md "Job cost profiles"): the deterministic rules. A finished job's profile from
// its runs, and the profiles grouped by repository, job cost kind and template. Pure, like the rest of the decider.
import {
  JOB_COST_GROUPINGS, type JobCostGroup, type JobCostGrouping, type JobCostKind, type JobCostProfile, type JobRun, type JobSpec, type ResourceCost,
} from '../domain/types.ts';

/** What a job was asked to do, for its cost. */
export const jobCostKind = (spec: JobSpec): JobCostKind => (spec.research ? 'research' : spec.proposal ? 'proposal' : 'code');

/** What the store knows of a job, for its profile; undefined: a job it no longer has. */
export type JobCostFacts = (jobId: string) => { repo?: string; kind: JobCostKind } | undefined;

type Resource = 'cpu' | 'memoryBytes' | 'diskBytes';
const RESOURCES: readonly Resource[] = ['cpu', 'memoryBytes', 'diskBytes'];

/** The sample-weighted average and the highest peak of the costs given; undefined when none has one. */
function combined(parts: readonly { cost?: ResourceCost; weight: number }[]): ResourceCost | undefined {
  const known = parts.filter((p): p is { cost: ResourceCost; weight: number } => p.cost !== undefined);
  if (!known.length) return undefined;
  const weight = known.reduce((n, p) => n + p.weight, 0);
  const avg = weight > 0 ? known.reduce((n, p) => n + p.cost.avg * p.weight, 0) / weight : known.reduce((n, p) => n + p.cost.avg, 0) / known.length;
  return { avg, peak: Math.max(...known.map((p) => p.cost.peak)) };
}

/** The mean of each figure over the costs given; undefined when none has one. */
function mean(costs: readonly (ResourceCost | undefined)[]): ResourceCost | undefined {
  const known = costs.filter((c): c is ResourceCost => c !== undefined);
  if (!known.length) return undefined;
  return { avg: known.reduce((n, c) => n + c.avg, 0) / known.length, peak: known.reduce((n, c) => n + c.peak, 0) / known.length };
}

const resourcesOf = (pick: (r: Resource) => ResourceCost | undefined): Partial<Record<Resource, ResourceCost>> =>
  Object.fromEntries(RESOURCES.flatMap((r) => { const c = pick(r); return c ? [[r, c]] : []; }));

/** Each run's usage burned for its lane, added up per usage window. */
function usageOf(runs: readonly JobRun[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs) {
    const lanes = Math.max(1, r.lanesBusyAvg ?? 1);
    for (const [w, burned] of Object.entries(r.usage)) out[w] = (out[w] ?? 0) + burned / lanes;
  }
  return out;
}

/** A profile per job whose last run finished or failed, newest first; `templateOf` names a machine's template. */
export function jobCostProfiles(runs: readonly JobRun[], factsOf: JobCostFacts, templateOf: (machineId: string) => string | undefined): JobCostProfile[] {
  const byJob = new Map<string, JobRun[]>();
  for (const r of runs) byJob.set(r.jobId, [...(byJob.get(r.jobId) ?? []), r]);
  const out: JobCostProfile[] = [];
  for (const [jobId, mine] of byJob) {
    mine.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const last = mine.at(-1)!;
    if (last.end !== 'finished' && last.end !== 'failed') continue;
    const facts = factsOf(jobId);
    if (!facts) continue;
    const template = templateOf(last.machineId);
    out.push({
      jobId, ...(facts.repo ? { repo: facts.repo } : {}), kind: facts.kind, ...(template ? { template } : {}), machineId: last.machineId,
      outcome: last.end, finishedAt: last.endedAt,
      durationMs: mine.reduce((n, r) => n + Date.parse(r.endedAt) - Date.parse(r.startedAt), 0),
      runs: mine.length, samples: mine.reduce((n, r) => n + r.samples, 0),
      ...resourcesOf((res) => combined(mine.map((r) => ({ cost: r[res], weight: r.samples })))),
      usage: usageOf(mine),
    });
  }
  return out.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}

function groupOf(key: string, ps: readonly JobCostProfile[]): JobCostGroup {
  const windows = [...new Set(ps.flatMap((p) => Object.keys(p.usage)))].sort();
  return {
    key, jobs: ps.length, failed: ps.filter((p) => p.outcome === 'failed').length,
    durationMs: ps.reduce((n, p) => n + p.durationMs, 0) / ps.length, samples: ps.reduce((n, p) => n + p.samples, 0),
    ...resourcesOf((res) => mean(ps.map((p) => p[res]))),
    usage: Object.fromEntries(windows.map((w) => {
      const burned = ps.flatMap((p) => (p.usage[w] === undefined ? [] : [p.usage[w]]));
      return [w, burned.reduce((n, b) => n + b, 0) / burned.length];
    })),
  };
}

/** The profiles grouped by repository, job cost kind and template (a profile with none is in no group of it), most jobs first. */
export function jobCostGroups(profiles: readonly JobCostProfile[]): Record<JobCostGrouping, JobCostGroup[]> {
  const by = (g: JobCostGrouping): JobCostGroup[] => {
    const groups = new Map<string, JobCostProfile[]>();
    for (const p of profiles) {
      const key = p[g];
      if (key !== undefined) groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    return [...groups].map(([k, ps]) => groupOf(k, ps)).sort((a, b) => b.jobs - a.jobs || a.key.localeCompare(b.key));
  };
  return Object.fromEntries(JOB_COST_GROUPINGS.map((g) => [g, by(g)])) as Record<JobCostGrouping, JobCostGroup[]>;
}
