// @vitest-environment happy-dom
// Issue #1169: the job view's timeline is a Trace. Each event is one step line, newest first: a step that failed shows as
// an error, the newest step of a job at work runs (it shimmers), and a job that waits for a lane shows that wait as a
// pending line on top. A step opens, by its button, to its data in a small code block.
//
// Feature: the job timeline
//   Scenario: a running job's newest step runs, and a failed step is an error
//   Scenario: a job that waits for a lane shows a pending line
//   Scenario: a step opens to its data
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';

// Browser code, type-checked by ui/tsconfig.json: imported by path.
const timeline = '../../ui/src/components/job-timeline.tsx';
const { JobTimeline } = (await import(timeline)) as {
  JobTimeline: (p: { job?: Job; events: readonly DomainEvent[]; nameOf: (id: string) => string; machines: readonly never[] }) => ReturnType<typeof createElement>;
};

const T = '2026-10-14T12:00:00.000Z';
const job = (status: string, extra: Partial<Job> = {}): Job => ({
  id: 'j1', spec: { executor: 'test', payload: {}, goal: 'Fix it' }, priority: 50, status, approved: true, attempts: 1,
  createdAt: T, updatedAt: T, ...extra,
} as Job);
const event = (seq: number, type: string, data: Record<string, unknown> = {}): DomainEvent =>
  ({ seq, id: `e${seq}`, schemaVersion: 1, type, at: T, jobId: 'j1', data } as unknown as DomainEvent);

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

function render(j: Job | undefined, events: DomainEvent[]): HTMLElement {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const el = document.getElementById('root')!;
  root = createRoot(el);
  act(() => root!.render(createElement(JobTimeline, { job: j, events, nameOf: () => 'Fix it', machines: [] })));
  return el;
}

const steps = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-slot="job-timeline"] [data-event-seq]')];
const statusOf = (step: HTMLElement) => step.querySelector<HTMLElement>('[data-slot="trace-line"]')!.dataset.status;

describe('the job timeline', () => {
  it('runs the newest step of a running job, and shows a failed step as an error', () => {
    const el = render(job('running'), [event(3, 'step.started', { host: 'win', command: 'build' }), event(2, 'github_proxy.failed', { op: 'pr', repo: 'o/r', error: 'no' }), event(1, 'job.started')]);
    expect(steps(el).map((s) => s.dataset.eventSeq)).toEqual(['3', '2', '1']);
    expect(steps(el).map(statusOf)).toEqual(['running', 'error', undefined]);
    expect(steps(el)[0]!.textContent).toContain('step.started');
    expect(steps(el)[0]!.textContent).toContain('build');
  });

  it('runs no step of an ended job', () => {
    const el = render(job('finished'), [event(2, 'job.finished'), event(1, 'job.started')]);
    expect(steps(el).map(statusOf)).toEqual([undefined, undefined]);
  });

  it('shows the wait of a held job as a pending line on top', () => {
    const el = render(job('held', { holdReason: 'no lane free' } as Partial<Job>), [event(1, 'job.held', { reason: 'no lane free' })]);
    const pending = el.querySelector<HTMLElement>('[data-slot="job-timeline"] [data-slot="trace-line"][data-status="pending"]');
    expect(pending?.textContent).toContain('no lane free');
  });

  it('opens a step to its data in a small code block', () => {
    const el = render(job('running'), [event(1, 'step.started', { host: 'win', command: 'build' })]);
    const button = steps(el)[0]!.querySelector('button')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('[data-slot="code-block"]')).toBeNull();
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const block = el.querySelector<HTMLElement>('[data-slot="code-block"]')!;
    expect(block.dataset.size).toBe('sm');
    expect(block.textContent).toContain('"command": "build"');
  });

  it('says no events when the job has none', () => {
    const el = render(job('queued'), []);
    expect(el.textContent).toContain('no events of this job yet');
  });
});
