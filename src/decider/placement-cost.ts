// Placement by expected cost (issue #688, design.md "Lane tuning"): a waiting job's expected cost from the job cost
// groups, and of the machines it may go to, the ones where that cost fits before resource pressure. Pure, like the rest
// of the decider.
import { MIN_EXPECTED_COST_JOBS, RESOURCE_PRESSURE, type ExpectedCost, type Job, type JobCostGroup, type MachineSnapshot } from '../domain/types.ts';
import { jobCostKind } from './job-costs.ts';

const GIB = 1024 ** 3;

/** The job's expected cost: its repository's group with enough jobs, else its job cost kind's; undefined: neither, or no CPU or memory figure. */
export function expectedCost(job: Job, groups: { repo: readonly JobCostGroup[]; kind: readonly JobCostGroup[] }): ExpectedCost | undefined {
  const of = (group: 'repo' | 'kind', key: string | undefined): ExpectedCost | undefined => {
    const g = key === undefined ? undefined : groups[group].find((x) => x.key === key);
    if (!g || g.jobs < MIN_EXPECTED_COST_JOBS || (!g.cpu && !g.memoryBytes)) return undefined;
    return { group, key: g.key, jobs: g.jobs, ...(g.cpu ? { cpu: g.cpu } : {}), ...(g.memoryBytes ? { memoryBytes: g.memoryBytes } : {}) };
  };
  return of('repo', job.source?.repo) ?? of('kind', jobCostKind(job.spec));
}

/** What the jobs this Decision placed on a machine are expected to add to it: memory in bytes, CPU as a share of it. */
export interface PlacedCost {
  memoryBytes: number;
  cpu: number;
}

/**
 * Whether `cost` fits on `m` with what this Decision placed there: its memory peak and its average CPU, added to the
 * machine's last resource reading, stay below resource pressure. A machine with no reading, or a figure it does not
 * read, is not passed over.
 */
export function costFits(m: MachineSnapshot, placed: PlacedCost, cost: ExpectedCost): boolean {
  const r = m.resources;
  if (!r) return true;
  if (cost.memoryBytes && r.memTotalBytes > 0
    && (r.memTotalBytes - r.memAvailableBytes + placed.memoryBytes + cost.memoryBytes.peak) / r.memTotalBytes >= RESOURCE_PRESSURE.memory) return false;
  return !(cost.cpu && r.cpuBusyFrac !== undefined && r.cpuBusyFrac + placed.cpu + cost.cpu.avg >= RESOURCE_PRESSURE.cpu);
}

/** The words for a job's expected cost in its start reason. */
function costNote(cost: ExpectedCost, fitsNowhere: boolean): string {
  const parts = [
    ...(cost.memoryBytes ? [`memory peak ${Math.round((cost.memoryBytes.peak / GIB) * 10) / 10} GiB`] : []),
    ...(cost.cpu ? [`CPU ${Math.round(cost.cpu.avg * 100)}%`] : []),
    ...(fitsNowhere ? ['fits no machine'] : []),
  ];
  return `expected cost (${cost.group} ${cost.key}, ${cost.jobs} jobs): ${parts.join(', ')}`;
}

/**
 * Of the machines a job may go to, the ones where its expected cost fits, with the words for its start reason. When it
 * fits on none, every one stays: the cost is a preference, never a hold. No expected cost: every one, no words.
 */
export function fitting<S extends { machine: MachineSnapshot; placed: PlacedCost }>(options: S[], cost: ExpectedCost | undefined): { options: S[]; note?: string } {
  if (!cost) return { options };
  const fit = options.filter((s) => costFits(s.machine, s.placed, cost));
  return fit.length ? { options: fit, note: costNote(cost, false) } : { options, note: costNote(cost, true) };
}

/** Count the job's expected cost on the machine it was placed on, for the jobs placed after it in this Decision. */
export function place(placed: PlacedCost, cost: ExpectedCost | undefined): void {
  placed.memoryBytes += cost?.memoryBytes?.peak ?? 0;
  placed.cpu += cost?.cpu?.avg ?? 0;
}
