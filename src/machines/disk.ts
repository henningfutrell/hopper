// A machine's disk (issue #401, design.md "A machine's disk"): the filesystem its home is on, where the
// jobs directory and the jobs' scratch dirs live. Jobs filled one machine's home once; the reading lets
// the UI warn before that. This machine's is read with statfs; an ssh target's with `df -Pk` in its
// probe; a client target's by its client, in its `/release` answer. Low is judged by the machine's own
// thresholds (issue #410), at each list, and a low machine takes no new job (src/decider/assign.ts).
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DiskReading, DiskThresholds } from '../domain/machines.ts';

const GIB = 1024 ** 3;
/** Low below this many GiB free, or below this share free (in percent), whichever comes first: the defaults of a machine's own thresholds (issue #410). */
export const DISK_LOW_BELOW_GIB = 5;
export const DISK_LOW_BELOW_PERCENT = 10;

export function diskOf(freeBytes: number, totalBytes: number, t: DiskThresholds = {}): DiskReading {
  const gib = t.belowGiB ?? DISK_LOW_BELOW_GIB;
  const percent = t.belowPercent ?? DISK_LOW_BELOW_PERCENT;
  return { freeBytes, totalBytes, low: freeBytes < gib * GIB || freeBytes < totalBytes * (percent / 100) };
}

/** A reading judged again by a machine's thresholds, as they are now. */
export const judged = (d: DiskReading, t: DiskThresholds | undefined): DiskReading => diskOf(d.freeBytes, d.totalBytes, t);

/** The filesystem `path` is on, through the nearest directory that exists; undefined when none can be read. */
export function diskAt(path: string): DiskReading | undefined {
  for (let p = path; ; p = dirname(p)) {
    try {
      const s = statfsSync(p);
      return diskOf(s.bavail * s.bsize, s.blocks * s.bsize);
    } catch {
      if (p === dirname(p)) return undefined;
    }
  }
}

/** What an ssh target's probe runs before it prints its home: the home's filesystem, total and available in KiB. */
export const DF_COMMAND = `df -Pk "$HOME" 2>/dev/null | awk 'NR==2 { print "hopper-disk", $2, $4 }'`;

/** The disk in what DF_COMMAND printed; undefined when it printed none. */
export function readDf(stdout: string): DiskReading | undefined {
  const m = /^hopper-disk (\d+) (\d+)$/m.exec(stdout);
  return m ? diskOf(Number(m[2]) * 1024, Number(m[1]) * 1024) : undefined;
}
