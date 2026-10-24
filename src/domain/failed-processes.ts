// No misleading state after a failed process (issue #2722 part 6, design.md "No misleading state after a failed process"):
// a job's reap reads, at its end, each process of it that failed — a heap abort, a core dump, an OOM kill — and whether
// its scope stopped. A job whose agent ended it well said only "Done" then, though its check may have aborted and the agent
// read that as a pass. Now its header says the failed processes, and asks to make sure that its checks ran. Pure.
// The job keeps the same words (`Job.failedProcesses`, part 7) for its cards on the Jobs graph and the dashboard.
import { heapAborts } from './heap-aborts.ts';
import type { BomPart } from './job-bom.ts';
import { processCrashes } from './process-crashes.ts';
import type { DomainEvent, JobStatus } from './types.ts';

/** A job's scope its reap could not stop (src/client/reap-use.ts `ScopeNotStopped`): its state then, the processes in it. */
export interface ScopeNotStopped { state: string; processes?: number }

/** What a job that ended well says of its failed processes and a scope that did not stop; `processes`: how many failed. */
export interface FailedProcessNote { said: string; processes: number }

/** The events the reap records of a failed process of the job, or of its scope that did not stop. */
export const FAILED_PROCESS_EVENTS = ['job.heap_aborted', 'job.core_dumped', 'job.oom_killed', 'job.scope_not_stopped'] as const;

/** The parts of a process of the job that failed (heap-aborts.ts, process-crashes.ts). */
const FAILED_PROCESS_KINDS: readonly string[] = ['heap_abort', 'core_dump', 'oom_kill'];

const inIt = (n: number | undefined): string => (n === undefined ? '' : `, ${n} ${n === 1 ? 'process' : 'processes'} in it`);

/** One failed part for each scope the reap could not stop, under machines: its state and the processes still in it. */
export function scopeNotStopped(events: readonly DomainEvent[]): BomPart[] {
  return events.filter((e) => e.type === 'job.scope_not_stopped').map((e) => {
    const d = e.data as Partial<ScopeNotStopped>;
    const state = typeof d.state === 'string' && d.state ? d.state : 'not stopped';
    return {
      id: `scope-not-stopped:${e.seq}`, group: 'machines', kind: 'scope_not_stopped', label: `Its scope did not stop (${state}${inIt(typeof d.processes === 'number' ? d.processes : undefined)})`,
      status: 'failed', ...(e.at ? { at: e.at } : {}), href: '#machines',
      detail: `The reap could not stop the job's scope${e.machineId ? ` on ${e.machineId}` : ''}: the sweep reaps it again while it is there.`,
    };
  });
}

/** The words of a job that ended well (`finished`) for the failed processes and the scope that did not stop in `parts`, if any. */
function noteOf(status: JobStatus, parts: readonly BomPart[]): FailedProcessNote | undefined {
  if (status !== 'finished') return undefined;
  const failed = parts.filter((p) => p.status === 'failed' && FAILED_PROCESS_KINDS.includes(p.kind));
  const scope = parts.find((p) => p.kind === 'scope_not_stopped');
  if (failed.length === 0 && !scope) return undefined;
  const said = [
    ...(failed.length ? [`a process of the job failed: ${failed.map((p) => p.label).join('; ')}`] : []),
    ...(scope ? [scope.label.replace(/^Its/, 'its')] : []),
  ];
  return { said: said.join(', and '), processes: failed.length };
}

/** The note a job that ended well keeps of the failed processes and the scope that did not stop in its `events` (part 7). */
export function failedProcessNote(status: JobStatus, events: readonly DomainEvent[]): FailedProcessNote | undefined {
  return noteOf(status, [...heapAborts(events), ...processCrashes(events), ...scopeNotStopped(events)]);
}

/**
 * The header of a job that ended well (`finished`), with each process of it that failed and each scope that did not stop
 * said after where it stands; with a failed process, what is next is to make sure that its checks ran. Any other job's
 * header, and one with neither, is `header` itself.
 */
export function failedProcessHeader<H extends { stands: string; next: string }>(status: JobStatus, parts: readonly BomPart[], header: H): H {
  const note = noteOf(status, parts);
  if (!note) return header;
  return {
    ...header, stands: `${header.stands}, but ${note.said}`,
    ...(note.processes ? { next: 'Make sure that its checks ran and passed: a failed process can make a check look green.' } : {}),
  };
}
