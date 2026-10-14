// Job cost profiles in the UI (issue #688), pure: a group's jobs and failures, a duration, one lane's share of CPU,
// memory and disk as average and peak, and the usage burned per usage window.
import type { JobCostGroup, ResourceCost } from './wire.ts';

const MIN = 60_000;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export const groupJobsText = (g: Pick<JobCostGroup, 'jobs' | 'failed'>): string =>
  `${g.jobs} job${g.jobs === 1 ? '' : 's'}${g.failed > 0 ? `, ${g.failed} failed` : ''}`;

export function durationText(ms: number): string {
  const min = Math.round(ms / MIN);
  if (min < 1) return 'under 1 min';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

const pair = (c: ResourceCost | undefined, text: (n: number) => string): string => (c ? `${text(c.avg)} avg · ${text(c.peak)} peak` : '—');

export const cpuText = (c: ResourceCost | undefined): string => pair(c, (n) => `${Math.round(n * 100)}%`);

export const bytesText = (c: ResourceCost | undefined): string =>
  pair(c, (n) => (n >= GIB ? `${(n / GIB).toFixed(1)} GiB` : `${Math.round(n / MIB)} MiB`));

export function usageText(usage: Readonly<Record<string, number>>): string {
  const parts = Object.entries(usage).map(([w, f]) => `${w} ${(f * 100).toFixed(1)}%`);
  return parts.length ? parts.join(' · ') : '—';
}
