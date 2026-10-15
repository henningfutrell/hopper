// Windows jobs (issues #918, #1350; docs/glossary.md "Windows label", "Windows machine"): an item labelled `hopper:win` or
// `hopper:windows` goes only to a Windows machine. When none can take it, it waits queued; it never falls back to Linux.
import type { Job, MachineSnapshot } from './types.ts';

/** The Windows labels, any case. */
export const WINDOWS_LABELS: readonly string[] = ['hopper:win', 'hopper:windows'];

export const needsWindows = (labels: readonly string[]): boolean => labels.some((l) => WINDOWS_LABELS.includes(l.toLowerCase()));

/** A job whose item had a Windows label at intake. */
export const isWindowsJob = (job: Pick<Job, 'source'>): boolean => needsWindows(job.source?.labels ?? []);

/** Whether the machine may take the job: any machine takes a job with no Windows label, only a Windows machine one with it. */
export const windowsFits = (m: Pick<MachineSnapshot, 'windows'>, job: Pick<Job, 'source'>): boolean => m.windows === true || !isWindowsJob(job);
