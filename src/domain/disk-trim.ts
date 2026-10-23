// The trim (issue #2494, design.md "Hopper's own disk use" → "Part 9"): what fstrim on a machine said. The trim itself is
// src/client/trim.ts; the sweep runs it (src/engine/sweep-trim.ts).

/**
 * How a trim ended: `trimmed`; `refused`, only root may and sudo did not let it with no password; `unsupported`, no fstrim
 * there or a filesystem with no discard; `failed`, anything else.
 */
export type TrimOutcome = 'trimmed' | 'refused' | 'unsupported' | 'failed';

/**
 * What a finished trim said: the mount point of the filesystem the machine's home is on, how it ended, the bytes fstrim
 * said it trimmed, what it said when it did not, and `wsl` when the machine is a WSL distro, whose virtual disk on the
 * host shrinks only by a compaction there.
 */
export interface Trimmed { mount: string; outcome: TrimOutcome; bytes?: number; said?: string; wsl?: boolean }
