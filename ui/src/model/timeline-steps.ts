// The job timeline's nodes (issue #1169): what belongs together nests under one line. A sandbox step's start and end
// (`step.started`, `step.finished`, one `step` id) are one step; a fork's spin-off and decision (`job.forked`,
// `job.fork_resolved`, one `forkId`) are one fork. Every other event is a line of its own. Pure.
import type { DomainEvent, JobStatus } from './wire.ts';

export type GroupKind = 'step' | 'fork';

export interface TimelineGroup {
  kind: 'group';
  group: GroupKind;
  /** The step id or the fork job id. */
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
 * its job (`jobStatus`) is at work. A fork: running while it is not decided and its fork job (`forkStatus`) is at work,
 * pending while that job waits for a lane.
 */
export function groupStatus(g: TimelineGroup, jobStatus: JobStatus | string | undefined, forkStatus?: JobStatus | string): StepStatus | undefined {
  if (g.group === 'step') {
    if (g.closed) {
      const d = g.closed.data as Record<string, unknown>;
      return d.exit !== 0 || typeof d.problem === 'string' ? 'error' : undefined;
    }
    return jobStatus && AT_WORK.has(jobStatus) ? 'running' : undefined;
  }
  if (g.closed || !forkStatus) return undefined;
  if (AT_WORK.has(forkStatus)) return 'running';
  return WAITS.has(forkStatus) ? 'pending' : undefined;
}
