// No misleading state after a failed process (issue #2722 part 6, design.md "No misleading state after a failed process"):
// a job's reap reads, at its end, each process of it that failed — a heap abort, a core dump, an OOM kill — and whether
// its scope stopped. A job whose agent ended it well said only "Done" then, though its check may have aborted and the agent
// read that as a pass. Now its header says the failed processes, and asks to make sure that its checks ran. Pure.
import type { BomPart } from './job-bom.ts';
import type { DomainEvent, JobStatus } from './types.ts';

/** A job's scope its reap could not stop (src/client/reap-use.ts `ScopeNotStopped`): its state then, the processes in it. */
export interface ScopeNotStopped { state: string; processes?: number }

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

/**
 * The header of a job that ended well (`finished`), with each process of it that failed and each scope that did not stop
 * said after where it stands; with a failed process, what is next is to make sure that its checks ran. Any other job's
 * header, and one with neither, is `header` itself.
 */
export function failedProcessHeader<H extends { stands: string; next: string }>(status: JobStatus, parts: readonly BomPart[], header: H): H {
  if (status !== 'finished') return header;
  const failed = parts.filter((p) => p.status === 'failed' && FAILED_PROCESS_KINDS.includes(p.kind));
  const scope = parts.find((p) => p.kind === 'scope_not_stopped');
  if (failed.length === 0 && !scope) return header;
  const said = [
    ...(failed.length ? [`a process of the job failed: ${failed.map((p) => p.label).join('; ')}`] : []),
    ...(scope ? [scope.label.replace(/^Its/, 'its')] : []),
  ];
  return {
    ...header, stands: `${header.stands}, but ${said.join(', and ')}`,
    ...(failed.length ? { next: 'Make sure that its checks ran and passed: a failed process can make a check look green.' } : {}),
  };
}
