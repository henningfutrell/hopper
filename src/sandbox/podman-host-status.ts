// A Podman host's status (issue #2272, design.md "Podman hosts"): what Machines shows of it. One libpod /info over its
// ssh stream (podman-host.ts) says whether boxes can start there — the same health as the sandbox module's (podman.ts)
// — and the computer's CPUs, the share of CPU time busy and its memory, so the host can be sized from real numbers.
// Read when asked, never kept.
import type { PodmanHostStatus } from '../domain/podman-hosts.ts';
import { podmanInfo } from './podman.ts';
import type { RuntimeSocket } from './socket-http.ts';

/** A read of a host that does not answer ends after this. */
export const STATUS_MS = 10_000;

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export async function readPodmanHostStatus(name: string, socket: RuntimeSocket, now: Date): Promise<PodmanHostStatus> {
  const at = now.toISOString();
  const r = await podmanInfo(socket, undefined, STATUS_MS);
  if ('problem' in r) return { name, at, problem: r.problem };
  const h = r.info.host ?? {};
  const idle = h.cpuUtilization?.idlePercent;
  return {
    name, at,
    ...(count(h.cpus) ? { cpus: h.cpus } : {}),
    ...(count(idle) && idle <= 100 ? { cpuBusyFrac: Math.round(100 - idle) / 100 } : {}),
    ...(count(h.memTotal) ? { memTotalBytes: h.memTotal } : {}),
    ...(count(h.memTotal) && count(h.memFree) ? { memUsedBytes: Math.max(0, h.memTotal - h.memFree) } : {}),
  };
}
