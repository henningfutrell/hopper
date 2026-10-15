// The job timeline's nodes (issue #1169): what belongs together nests under one line. A sandbox step's start and end
// (`step.started`, `step.finished`, one `step` id) are one step; a fork's spin-off and decision (`job.forked`,
// `job.fork_resolved`, one `forkId`) are one fork. A tend job (`job.pull_request_tended`) and a rework job
// (`job.rework_requested`) are one line each, by the job they made (`nextJobId`), which opens to that job's own events.
// Every other event is a line of its own. Pure.
import type { DomainEvent, JobStatus } from './wire.ts';

export type GroupKind = 'step' | 'fork' | 'tend' | 'rework';

export interface TimelineGroup {
  kind: 'group';
  group: GroupKind;
  /** The step id, or the job the group stands for: the fork job, the tend job, the rework job. */
  id: string;
  /** Its events, newest first. */
  events: DomainEvent[];
  /** The event that opened it (`step.started`, `job.forked`), when the timeline holds it. */
  opened?: DomainEvent;
  /** The event that closed it (`step.finished`, `job.fork_resolved`), when it has one. */
  closed?: DomainEvent;
}

export type TimelineNode = { kind: 'event'; event: DomainEvent } | TimelineGroup;

export type StepStatus = 'running' | 'error' | 'pending';

const OPENS: Record<string, { group: GroupKind; field: string }> = {
  'step.started': { group: 'step', field: 'step' }, 'job.forked': { group: 'fork', field: 'forkId' },
  'job.pull_request_tended': { group: 'tend', field: 'nextJobId' }, 'job.rework_requested': { group: 'rework', field: 'nextJobId' },
};
const CLOSES: Record<string, { group: GroupKind; field: string }> = {
  'step.finished': { group: 'step', field: 'step' }, 'job.fork_resolved': { group: 'fork', field: 'forkId' },
};

/** A job with a lane: what it does now runs. */
export const AT_WORK: ReadonlySet<string> = new Set(['claimed', 'running']);
const WAITS: ReadonlySet<string> = new Set(['queued', 'held']);

/** The timeline's nodes from its events (newest first): a group stands at the place of its newest event. */
export function timelineNodes(events: readonly DomainEvent[]): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  const groups = new Map<string, TimelineGroup>();
  for (const e of events) {
    const opens = OPENS[e.type];
    const closes = CLOSES[e.type];
    const by = opens ?? closes;
    const id = by ? (e.data as Record<string, unknown>)[by.field] : undefined;
    if (!by || typeof id !== 'string') { nodes.push({ kind: 'event', event: e }); continue; }
    const key = `${by.group}:${id}`;
    let g = groups.get(key);
    if (!g) { g = { kind: 'group', group: by.group, id, events: [] }; groups.set(key, g); nodes.push(g); }
    g.events.push(e);
    if (opens) g.opened ??= e; else g.closed ??= e;
  }
  return nodes;
}

/**
 * A group's status. A step: an error when it ended with a non-zero exit or a problem; running while it has not ended and
 * its job (`jobStatus`) is at work. A fork, a tend job, a rework job: by the job it stands for (`itsStatus`) — running
 * while that job is at work, pending while it waits for a lane, an error when it failed. A decided fork has none.
 */
export function groupStatus(g: TimelineGroup, jobStatus: JobStatus | string | undefined, itsStatus?: JobStatus | string): StepStatus | undefined {
  if (g.group === 'step') {
    if (g.closed) {
      const d = g.closed.data as Record<string, unknown>;
      return d.exit !== 0 || typeof d.problem === 'string' ? 'error' : undefined;
    }
    return jobStatus && AT_WORK.has(jobStatus) ? 'running' : undefined;
  }
  if (g.closed || !itsStatus) return undefined;
  if (AT_WORK.has(itsStatus)) return 'running';
  if (itsStatus === 'failed') return 'error';
  return WAITS.has(itsStatus) ? 'pending' : undefined;
}
