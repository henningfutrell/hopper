// The metered peaks (issue #2737, design.md "Resources used"): the most memory each job's machine's meter said the job
// held (`jobUse.memoryPeakBytes`), as the engine lists its machines. The reap reads a job's peak from its scope's cgroup
// (`memory.peak`); where no scope holds the job (no systemd user manager: the meter reads its processes) or its scope ended
// before the reap (a parked job's), the reap reads none, and the cleanup records this one in its place, so the job's
// expected peak has a history there too. Kept in memory: a restart forgets it, and that job's reap records what it read.
import type { Clock, MachineSource } from '../domain/ports.ts';

/** How long a job's metered peak stays after the meter last named the job: longer than any cleanup is deferred. */
export const METERED_PEAK_MS = 24 * 3_600_000;

export interface JobPeaks {
  /** The most memory the meters said the job held, and forgets it; undefined when no meter named it. */
  take(jobId: string): number | undefined;
  /** The machines, each reading's job peaks kept as the engine lists them. */
  source(machines: MachineSource): MachineSource;
}

export function createJobPeaks(clock: Clock, keepMs = METERED_PEAK_MS): JobPeaks {
  const peaks = new Map<string, { bytes: number; seenAt: number }>();
  return {
    take(jobId) {
      const p = peaks.get(jobId);
      peaks.delete(jobId);
      return p?.bytes;
    },
    source: (machines) => ({
      list: async () => {
        const all = await machines.list();
        const at = clock.now().getTime();
        for (const m of all) {
          for (const [id, use] of Object.entries(m.resources?.jobUse ?? {})) {
            if (use.memoryPeakBytes === undefined) continue;
            peaks.set(id, { bytes: Math.max(use.memoryPeakBytes, peaks.get(id)?.bytes ?? 0), seenAt: at });
          }
        }
        for (const [id, p] of peaks) if (at - p.seenAt > keepMs) peaks.delete(id);
        return all;
      },
    }),
  };
}
