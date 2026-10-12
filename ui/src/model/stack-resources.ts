// Stack resources in words (issue #947, design.md "Stack resources"): each container's CPU, memory, network, disk,
// restarts and uptime, the hopper's Postgres, and OpenFGA's checks, as the Resources page writes them. Pure: `now` is passed in.
import type { ContainerReading, OpenFgaReading, PostgresReading } from '@/model/wire';
import { duration } from './format';

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Bytes in binary units, at most one decimal: 1536 → 1.5 KiB. */
export function sizeText(bytes: number): string {
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < UNITS.length - 1) { n /= 1024; u++; }
  return `${u === 0 ? n : Math.round(n * 10) / 10} ${UNITS[u]}`;
}

const cores = (n: number): string => String(Math.round(n * 100) / 100);
const ms = cores;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** CPU cores busy, against the quota when one is set; while it runs with no reading yet, it is measured at the next read. */
export function cpuText(c: ContainerReading): string {
  if (c.cpuCores === undefined) return c.state === 'running' ? 'measuring' : '—';
  return c.cpuLimitCores !== undefined ? `${cores(c.cpuCores)} of ${cores(c.cpuLimitCores)} cores` : `${cores(c.cpuCores)} cores`;
}

/** Memory in use against its limit, with the share; no limit says so. */
export function memoryText(c: ContainerReading): string {
  if (c.memUsedBytes === undefined) return '—';
  if (c.memLimitBytes === undefined) return `${sizeText(c.memUsedBytes)}, no limit`;
  return `${sizeText(c.memUsedBytes)} of ${sizeText(c.memLimitBytes)} (${Math.round((c.memUsedBytes / c.memLimitBytes) * 100)}%)`;
}

/** The share of its memory limit in use, for the bar; undefined with no limit. */
export const memoryFrac = (c: ContainerReading): number | undefined =>
  c.memUsedBytes !== undefined && c.memLimitBytes ? Math.min(1, c.memUsedBytes / c.memLimitBytes) : undefined;

export const networkText = (c: ContainerReading): string =>
  c.netRxBytes === undefined && c.netTxBytes === undefined ? '—' : `in ${sizeText(c.netRxBytes ?? 0)}, out ${sizeText(c.netTxBytes ?? 0)}`;

/** Disk read and written since it started, and its writable layer. */
export function diskText(c: ContainerReading): string {
  const parts = [
    c.diskReadBytes !== undefined || c.diskWriteBytes !== undefined ? `read ${sizeText(c.diskReadBytes ?? 0)}, written ${sizeText(c.diskWriteBytes ?? 0)}` : '',
    c.layerBytes !== undefined ? `layer ${sizeText(c.layerBytes)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : '—';
}

/** Each named volume with its size, when the runtime said. */
export const volumesText = (c: ContainerReading): string =>
  (c.volumes ?? []).map((v) => (v.bytes === undefined ? v.name : `${v.name} ${sizeText(v.bytes)}`)).join(', ');

/** How long it has run, or its state when it does not. */
export const uptimeText = (c: ContainerReading, now: number): string =>
  c.startedAt ? `up ${duration((now - Date.parse(c.startedAt)) / 1000)}` : c.state;

export const restartsText = (c: ContainerReading): string => (c.restarts === undefined ? '' : plural(c.restarts, 'restart', 'restarts'));

/** Whether the container is in a state that needs a look: not running, unhealthy, or restarted. */
export const containerTone = (c: ContainerReading): 'ok' | 'warn' | 'bad' =>
  c.health === 'unhealthy' ? 'bad' : c.state !== 'running' || (c.restarts ?? 0) > 0 ? 'warn' : 'ok';

/** The hopper's Postgres, one line per reading. */
export function postgresLines(p: PostgresReading): { label: string; text: string }[] {
  const s = p.statements;
  return [
    { label: 'Connections', text: `${p.connections.total} of ${p.connections.max} connections, ${p.connections.active} active` },
    { label: 'Database size', text: sizeText(p.databaseBytes) },
    { label: 'Cache hits', text: p.cacheHitFrac === undefined ? 'no reads yet' : `${(Math.round(p.cacheHitFrac * 1000) / 10).toFixed(1)}% of block reads` },
    { label: 'Locks', text: p.locksWaiting === 0 ? 'no lock waiting' : `${plural(p.locksWaiting, 'lock', 'locks')} waiting` },
    {
      label: 'Transactions',
      text: [
        p.longTransactions === 0 ? 'no long transactions' : `${plural(p.longTransactions, 'transaction', 'transactions')} open over 5 minutes`,
        p.oldestTransactionS !== undefined ? `oldest open ${duration(p.oldestTransactionS)}` : '',
      ].filter(Boolean).join('; '),
    },
    { label: 'Statement latency', text: 'problem' in s ? s.problem : `${ms(s.meanMs)} ms mean over ${s.calls} statements` },
  ];
}


/** OpenFGA's checks since it started, one line per reading. */
export function openFgaLines(f: OpenFgaReading): { label: string; text: string }[] {
  if (f.checks === 0) return [{ label: 'Checks', text: 'no checks yet' }];
  return [
    { label: 'Check latency', text: f.meanMs === undefined ? 'no check time yet' : `${ms(f.meanMs)} ms mean over ${f.checks} checks` },
    { label: 'Errors', text: f.errors === 0 ? `no failed checks of ${f.checks}` : `${f.errors} of ${f.checks} checks failed (${(Math.round((f.errors / f.checks) * 1000) / 10).toFixed(1)}%)` },
  ];
}
