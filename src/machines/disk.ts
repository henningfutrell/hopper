// A machine's disk (issue #401, design.md "A machine's disk"): the filesystem its home is on, where the
// jobs directory and the jobs' scratch dirs live. Jobs filled one machine's home once; the reading lets
// the UI warn before that. This machine's is read with statfs; an ssh target's with `df -Pk` in its
// probe; a client target's by its client, in its `/release` answer.
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DiskReading } from '../domain/types.ts';

const GIB = 1024 ** 3;
/** Low below this share free, or below LOW_BYTES free, whichever comes first. */
const LOW_SHARE = 0.1;
const LOW_BYTES = 5 * GIB;

export function diskOf(freeBytes: number, totalBytes: number): DiskReading {
  return { freeBytes, totalBytes, low: freeBytes < LOW_BYTES || freeBytes < totalBytes * LOW_SHARE };
}

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
