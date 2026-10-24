// What a job used in its parts list (issue #2498, design.md "A job's parts list" → "Resources used"): its scope's peak
// memory, CPU time and OOM kills, and the disk of its scratch dir and worktrees (part 4), as each reap read them (`job.resources_used`), beside job-bom.ts for its size; and while
// it runs (part 3), what its scope uses now, as its machine's meter last read it (`jobMemoryBytes`, `jobUse`). Pure.
import type { BomPart } from './job-bom.ts';
import type { JobUseNow, ResourceReading } from './machine-history.ts';
import type { ResourceUse } from './machine-shell.ts';
import type { DomainEvent } from './types.ts';

/** Each heap abort of the job's Node processes (issue #2722), beside what it used. */
export { heapAborts } from './heap-aborts.ts';
export { processCrashes } from './process-crashes.ts';
export { heapRetries } from './heap-retry.ts';

const memoryText = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${Math.round((bytes / 1024 ** 3) * 10) / 10} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;

/** CPU time in hours, minutes and seconds: `1h 2m`, `12m 34s`, `12s`. */
function cpuText(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : m ? `${m}m${r ? ` ${r}s` : ''}` : `${r}s`;
}

/**
 * One part for every reap that read the job's scope or disk (a job resumed elsewhere is reaped on each machine): the highest
 * peak memory, the CPU time and the OOM kills of all of them, the most disk one reap found, and the machines. None when no
 * reap read one.
 */
export function resourcesUsed(events: readonly DomainEvent[]): BomPart[] {
  const read = events.filter((e) => e.type === 'job.resources_used');
  if (read.length === 0) return [];
  const all = read.map((e) => e.data as ResourceUse);
  const peaks = all.flatMap((u) => (u.memoryPeakBytes !== undefined ? [u.memoryPeakBytes] : []));
  const cpus = all.flatMap((u) => (u.cpuSeconds !== undefined ? [u.cpuSeconds] : []));
  const ooms = all.flatMap((u) => (u.oomKills !== undefined ? [u.oomKills] : []));
  const disks = all.flatMap((u) => (u.diskBytes !== undefined ? [u.diskBytes] : []));
  const machines = [...new Set(read.flatMap((e) => (e.machineId ? [e.machineId] : [])))];
  const said = [
    peaks.length ? `Peak memory ${memoryText(Math.max(...peaks))}` : undefined, cpus.length ? `CPU ${cpuText(cpus.reduce((a, b) => a + b, 0))}` : undefined,
    disks.length ? `disk ${memoryText(Math.max(...disks))}` : undefined,
  ].filter((t) => t !== undefined).join(', ');
  const label = said ? said[0]!.toUpperCase() + said.slice(1) : 'Resources used';
  const kills = ooms.reduce((a, b) => a + b, 0);
  const detail = [ooms.length && kills > 0 ? `${kills} OOM kill${kills === 1 ? '' : 's'}` : undefined, machines.length ? `on ${machines.join(' and ')}` : undefined].filter(Boolean).join(', ');
  const at = read.map((e) => e.at).sort().at(-1);
  return [{ id: 'resources', group: 'machines', kind: 'resources', label, status: 'recorded', ...(at ? { at } : {}), ...(detail ? { detail } : {}), href: '#machines' }];
}

/** What a job's scope uses now on one machine (part 3): its memory in use, and what it used so far. */
export interface LiveUse { machineId: string; memoryBytes?: number; use?: JobUseNow }

/** Each machine whose last reading has the job's scope: what it uses there now. */
export function liveUseOf(machines: readonly { id: string; resources?: ResourceReading }[], jobId: string): LiveUse[] {
  return machines.flatMap((m) => {
    const memory = m.resources?.jobMemoryBytes?.[jobId], use = m.resources?.jobUse?.[jobId];
    return memory !== undefined || use ? [{ machineId: m.id, ...(memory !== undefined ? { memoryBytes: memory } : {}), ...(use ? { use } : {}) }] : [];
  });
}

const coresText = (cores: number): string => `${Math.round(cores * 10) / 10} core${Math.round(cores * 10) === 10 ? '' : 's'}`;

/** One part for each machine where the job's scope runs now: its memory now and peak, its CPU cores busy, so far. */
export function resourcesNow(live: readonly LiveUse[], now: string): BomPart[] {
  return live.map((l) => {
    const u = l.use ?? {};
    const label = [
      l.memoryBytes !== undefined ? `Memory ${memoryText(l.memoryBytes)} now` : undefined, u.memoryPeakBytes !== undefined ? `peak ${memoryText(u.memoryPeakBytes)}` : undefined,
      u.cpuCores !== undefined ? `CPU ${coresText(u.cpuCores)}` : undefined,
    ].filter(Boolean).join(', ') || 'Resources in use';
    const kills = u.oomKills ?? 0;
    const detail = [u.cpuSeconds !== undefined ? `CPU ${cpuText(u.cpuSeconds)} so far` : undefined, kills > 0 ? `${kills} OOM kill${kills === 1 ? '' : 's'}` : undefined, `on ${l.machineId}`].filter(Boolean).join(', ');
    return { id: `resources-now:${l.machineId}`, group: 'machines', kind: 'resources', label, status: 'running', at: now, detail, href: '#machines' };
  });
}
