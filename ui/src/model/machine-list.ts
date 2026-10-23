// The Machines list view (issue #2352): one row per machine, its badges and readings in short, beside the cards. A
// machine's badges are the same in its card's header and its row; an alert is any warning badge, or a problem its card
// says that has none. The view mode is kept per browser (hooks/use-machines-layout.ts); what is read back is checked.
import { unhealthyLaneLines } from './lane-health.ts';
import { credentialCard, offNetwork } from './machines.ts';
import type { ResourceReading } from '../../../src/domain/types.ts';
import type { MachineView } from './wire.ts';

export type MachinesMode = 'cards' | 'list';

/**
 * Issue #2622 part 6: a burst of large page allocation failures, as the allocation failure watch counts one
 * (ALLOC_FAILURE_BURST, src/machines/alloc-failure-watch.ts: the UI imports only types of src/).
 */
export const allocFailureBurst = (r: ResourceReading | undefined): boolean => (r?.memAllocFailures?.count ?? 0) >= 3;

/** The view mode as browser storage has it: list only when it says list. */
export const parseMachinesMode = (raw: string | null): MachinesMode => (raw === 'list' ? 'list' : 'cards');

/** A badge's tone: a warning, or quiet; none is the online or offline badge's own. */
export interface MachineBadge { status: string; tone?: 'warn' | 'muted' }

/** A machine's badges, the warnings first and its online or offline badge last. */
export function machineBadges(m: MachineView, now: number): MachineBadge[] {
  const warn = (on: unknown, status: string): MachineBadge[] => (on ? [{ status, tone: 'warn' }] : []);
  const credential = credentialCard(m);
  return [
    ...warn(m.template?.waiting, 'waiting for template approval'),
    ...warn(m.leaving, 'leaving'),
    ...warn(m.drained, 'drained'),
    ...(m.sandboxHost !== undefined ? [{ status: 'sandbox host', tone: 'muted' as const }] : []),
    ...warn(unhealthyLaneLines(m, now).length > 0, 'unhealthy lane'),
    ...warn(offNetwork(m), 'off-network'),
    ...warn(m.herdrProblem, 'herdr outdated'),
    ...warn(m.disk?.low, 'disk low'),
    ...(credential ? [{ status: credential.badge, tone: credential.state === 'acknowledged' ? 'muted' as const : 'warn' as const }] : []),
    ...warn(m.hopperDisk?.over, 'over disk budget'),
    ...warn(m.cleanupLeftovers !== undefined, 'cleanup leftovers'),
    ...warn(m.resources?.windowsLink?.ok === false, 'Windows link broken'),
    ...warn(m.resources?.nodeFloor, 'Node unpatched'),
    ...warn(m.resources?.jobMemoryLimit === 'none', 'no memory limit'),
    ...warn(allocFailureBurst(m.resources), 'allocation failures'),
    { status: m.online ? 'online' : 'offline' },
  ];
}

/** What a machine card says of its Node version (issue #2479): below the patched floor, what to update it to. */
export const nodeText = (r: Pick<ResourceReading, 'node' | 'nodeFloor'>): string =>
  (r.nodeFloor ? `${r.node}: it lacks the October 21, 2026 security release. Update Node there to ${r.nodeFloor} or later` : `${r.node ?? ''}`);

/** Whether a machine has an alert: a warning badge, a work tree problem, or a client that cannot be updated from here. */
export const machineHasAlert = (m: MachineView, now: number): boolean =>
  machineBadges(m, now).some((b) => b.tone === 'warn') || !!m.workTreeProblem || !!m.client?.update?.problem;

const pct = (f: number): string => `${Math.round(f * 100)}%`;

/** A machine's row: lanes in use of its max, CPU busy, memory used, disk free and its client release; a dash for none. */
export function machineRow(m: MachineView): { lanes: string; cpu: string; memory: string; disk: string; version: string } {
  const r = m.resources;
  return {
    lanes: `${m.lanes.filter((l) => l.state !== 'idle').length}/${m.maxLanes}`,
    cpu: r?.cpuBusyFrac !== undefined ? pct(r.cpuBusyFrac) : '—',
    memory: r && r.memTotalBytes > 0 ? pct((r.memTotalBytes - r.memAvailableBytes) / r.memTotalBytes) : '—',
    disk: m.disk && m.disk.totalBytes > 0 ? `${pct(m.disk.freeBytes / m.disk.totalBytes)} free` : '—',
    version: m.client?.release ?? '—',
  };
}
