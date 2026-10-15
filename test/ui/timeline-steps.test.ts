// Issue #1169: the job timeline nests what belongs together. A sandbox step's start and end (`step.started`,
// `step.finished`, one `step` id) are one step with its two events under it; a fork's spin-off and decision
// (`job.forked`, `job.fork_resolved`, one `forkId`) are one fork. The step's status: a failed step is an error, a step
// that has not ended runs while its job is at work; a fork that is not decided runs while its fork job is at work, and
// is pending while that job waits.
//
// Feature: nested steps on the job timeline
//   Scenario: a step's start and end are one step, at the place of its newest event
//   Scenario: events with no step id stay single lines
//   Scenario: a step's and a fork's status
import { describe, expect, it } from 'vitest';
import { groupStatus, timelineNodes, type TimelineGroup } from '../../ui/src/model/timeline-steps.ts';
import type { DomainEvent } from '../../ui/src/model/wire.ts';

const event = (seq: number, type: string, data: Record<string, unknown> = {}): DomainEvent =>
  ({ seq, id: `e${seq}`, schemaVersion: 1, type, at: 't', jobId: 'j1', data } as unknown as DomainEvent);

const shape = (events: DomainEvent[]) => timelineNodes(events).map((n) => n.kind === 'event' ? n.event.seq : `${n.group}:${n.id}[${n.events.map((e) => e.seq).join(',')}]`);

describe('the nodes of the job timeline', () => {
  it('makes a step of its start and end, at the place of its newest event, newest first', () => {
    const events = [
      event(5, 'job.finished'),
      event(4, 'step.finished', { step: 's1', host: 'win', exit: 0, seconds: 3 }),
      event(3, 'github_proxy.done', { op: 'pr' }),
      event(2, 'step.started', { step: 's1', host: 'win', command: 'build' }),
      event(1, 'job.started'),
    ];
    expect(shape(events)).toEqual([5, 'step:s1[4,2]', 3, 1]);
    const step = timelineNodes(events)[1] as TimelineGroup;
    expect(step.opened?.seq).toBe(2);
    expect(step.closed?.seq).toBe(4);
  });

  it('makes a fork of its spin-off and decision', () => {
    const events = [event(3, 'job.fork_resolved', { forkId: 'f1', decision: 'accept' }), event(2, 'question.asked'), event(1, 'job.forked', { forkId: 'f1', to: 'research' })];
    expect(shape(events)).toEqual(['fork:f1[3,1]', 2]);
  });

  it('keeps an event with no step id a single line', () => {
    expect(shape([event(2, 'step.started', { host: 'win', command: 'build' }), event(1, 'step.refused', { reason: 'no' })])).toEqual([2, 1]);
  });

  it('keeps two steps apart', () => {
    expect(shape([event(3, 'step.started', { step: 's2' }), event(2, 'step.finished', { step: 's1', exit: 0 }), event(1, 'step.started', { step: 's1' })]))
      .toEqual(['step:s2[3]', 'step:s1[2,1]']);
  });
});

describe('the status of a step or a fork', () => {
  const group = (events: DomainEvent[]) => timelineNodes(events)[0] as TimelineGroup;
  it('runs a step that has not ended while the job is at work, else has none', () => {
    const open = group([event(1, 'step.started', { step: 's1' })]);
    expect(groupStatus(open, 'running')).toBe('running');
    expect(groupStatus(open, 'claimed')).toBe('running');
    expect(groupStatus(open, 'failed')).toBeUndefined();
  });

  it('shows a step that ended with a non-zero exit or a problem as an error, and one that passed with none', () => {
    expect(groupStatus(group([event(2, 'step.finished', { step: 's1', exit: 1 }), event(1, 'step.started', { step: 's1' })]), 'running')).toBe('error');
    expect(groupStatus(group([event(2, 'step.finished', { step: 's1', exit: 0, problem: 'timed out after 60 s' })]), 'running')).toBe('error');
    expect(groupStatus(group([event(2, 'step.finished', { step: 's1', exit: 0 }), event(1, 'step.started', { step: 's1' })]), 'running')).toBeUndefined();
  });

  it('runs a fork not decided while its fork job is at work, and shows it pending while that job waits', () => {
    const open = group([event(1, 'job.forked', { forkId: 'f1' })]);
    expect(groupStatus(open, 'waiting_answer', 'running')).toBe('running');
    expect(groupStatus(open, 'waiting_answer', 'queued')).toBe('pending');
    expect(groupStatus(open, 'waiting_answer', 'held')).toBe('pending');
    expect(groupStatus(open, 'waiting_answer', 'finished')).toBeUndefined();
    expect(groupStatus(open, 'waiting_answer')).toBeUndefined();
    expect(groupStatus(group([event(2, 'job.fork_resolved', { forkId: 'f1' }), event(1, 'job.forked', { forkId: 'f1' })]), 'running', 'running')).toBeUndefined();
  });
});
