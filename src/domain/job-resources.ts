// What a job used in its parts list (issue #2498, design.md "A job's parts list" → "Resources used"): its scope's peak
// memory, CPU time and OOM kills, as each reap read them (`job.resources_used`), beside job-bom.ts for its size. Pure.
import type { BomPart } from './job-bom.ts';
import type { ResourceUse } from './machine-shell.ts';
import type { DomainEvent } from './types.ts';

const memoryText = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${Math.round((bytes / 1024 ** 3) * 10) / 10} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;

/** CPU time in hours, minutes and seconds: `1h 2m`, `12m 34s`, `12s`. */
function cpuText(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : m ? `${m}m${r ? ` ${r}s` : ''}` : `${r}s`;
}

/**
 * One part for every reap that read the job's scope (a job resumed elsewhere is reaped on each machine): the highest peak
 * memory, the CPU time and the OOM kills of all of them, and the machines. None when no reap read one.
 */
export function resourcesUsed(events: readonly DomainEvent[]): BomPart[] {
  const read = events.filter((e) => e.type === 'job.resources_used');
  if (read.length === 0) return [];
  const all = read.map((e) => e.data as ResourceUse);
  const peaks = all.flatMap((u) => (u.memoryPeakBytes !== undefined ? [u.memoryPeakBytes] : []));
  const cpus = all.flatMap((u) => (u.cpuSeconds !== undefined ? [u.cpuSeconds] : []));
  const ooms = all.flatMap((u) => (u.oomKills !== undefined ? [u.oomKills] : []));
  const machines = [...new Set(read.flatMap((e) => (e.machineId ? [e.machineId] : [])))];
  const label = [peaks.length ? `Peak memory ${memoryText(Math.max(...peaks))}` : undefined, cpus.length ? `CPU ${cpuText(cpus.reduce((a, b) => a + b, 0))}` : undefined]
    .filter(Boolean).join(', ') || 'Resources used';
  const kills = ooms.reduce((a, b) => a + b, 0);
  const detail = [ooms.length && kills > 0 ? `${kills} OOM kill${kills === 1 ? '' : 's'}` : undefined, machines.length ? `on ${machines.join(' and ')}` : undefined].filter(Boolean).join(', ');
  const at = read.map((e) => e.at).sort().at(-1);
  return [{ id: 'resources', group: 'machines', kind: 'resources', label, status: 'recorded', ...(at ? { at } : {}), ...(detail ? { detail } : {}), href: '#machines' }];
}
