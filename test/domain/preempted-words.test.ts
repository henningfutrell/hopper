// Issue #1525: a job preempted says so in the job graph and its parts list — Queued: preempted by #12 Fix the roof —, and
// what comes next: it resumes from where it stopped. Once it runs again, it says nothing of it.
import { describe, expect, it } from 'vitest';
import { nextWords, preempterLabel, preemptedByOf, stageWords } from '../../src/domain/job-words.ts';
import type { Job } from '../../src/domain/types.ts';

const preempted = { at: '2026-10-16T12:00:00Z', by: 'h', byPriority: 75, priority: 50, machineId: 'laptop' };
const by = { id: 'h', spec: { executor: 'x', payload: {} }, source: { source: 'github', kind: 'issue', key: 'k', number: 12, title: 'Fix the roof' } } as unknown as Job;

describe('preempted words', () => {
  it('names the job that took the lane, by its issue, else its goal, else its id', () => {
    expect(preempterLabel(by, 'h')).toBe('#12 Fix the roof');
    expect(preempterLabel({ ...by, source: undefined, spec: { ...by.spec, goal: 'Tidy up' } }, 'h')).toBe('Tidy up');
    expect(preempterLabel(undefined, 'h')).toBe('job h');
  });

  it('a queued or parked job preempted says so; a running one does not', () => {
    const label = (id: string) => preempterLabel(by, id);
    const queued = { kind: 'job' as const, stage: 'queued' as const, status: 'queued' as const, ...preemptedByOf({ status: 'queued', preempted }, label) };
    expect(stageWords(queued)).toBe('Queued: preempted by #12 Fix the roof');
    expect(nextWords(queued)).toBe('It resumes from where it stopped when a lane is free.');
    const parked = { kind: 'job' as const, stage: 'waiting' as const, status: 'parked' as const, ...preemptedByOf({ status: 'parked', preempted }, label) };
    expect(stageWords(parked)).toBe('Parked: preempted by #12 Fix the roof');
    expect(preemptedByOf({ status: 'running', preempted }, label)).toEqual({});
  });
});
