// @vitest-environment happy-dom
// Issue #1169: the job view's timeline is a Trace. Each event is one step line, newest first: a step that failed shows as
// an error, the newest step of a job at work runs (it shimmers), and a job that waits for a lane shows that wait as a
// pending line on top. A step opens, by its button, to its data in a small code block.
//
// Feature: the job timeline
//   Scenario: a running job's newest step runs, and a failed step is an error
//   Scenario: a job that waits for a lane shows a pending line
//   Scenario: a step opens to its data
//   Scenario: a sandbox step's start and end nest under one line; a fork's events nest under one line that links its job
//   Scenario: a tend job nests under one line that links it and, opened, reads that job's own events and shows them nested
//   Scenario: all the job's checkpoints are one line: the last one's machine and how many were taken (issue #1975)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';

// Browser code, type-checked by ui/tsconfig.json: imported by path.
const timeline = '../../ui/src/components/job-timeline.tsx';
const { JobTimeline } = (await import(timeline)) as {
  JobTimeline: (p: {
    job?: Job; events: readonly DomainEvent[]; nameOf: (id: string) => string; machines: readonly never[]; statusOf?: (id: string) => string | undefined;
    readEvents?: (jobId: string) => Promise<readonly DomainEvent[]>;
  }) => ReturnType<typeof createElement>;
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

function render(j: Job | undefined, events: DomainEvent[], statusOf?: (id: string) => string | undefined, readEvents?: (jobId: string) => Promise<readonly DomainEvent[]>): HTMLElement {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const el = document.getElementById('root')!;
  root = createRoot(el);
  act(() => root!.render(createElement(JobTimeline, { job: j, events, nameOf: () => 'Fix it', machines: [], statusOf, readEvents })));
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

  it('nests a sandbox step\'s start and end under one line that says how it ended', () => {
    const el = render(job('running'), [
      event(3, 'step.finished', { step: 's1', box: 'b1', exit: 2, seconds: 4 }),
      event(2, 'step.started', { step: 's1', box: 'b1', command: 'npm test' }),
      event(1, 'job.started'),
    ]);
    const groups = [...el.querySelectorAll<HTMLElement>('[data-slot="job-timeline"] [data-step-key]')];
    expect(groups.map((g) => g.dataset.stepKey)).toEqual(['step:s1']);
    const line = groups[0]!.querySelector<HTMLElement>('[data-slot="trace-line"]')!;
    expect(line.dataset.status).toBe('error');
    expect(line.textContent).toContain('npm test');
    expect(line.textContent).toContain('exit 2');
    const button = groups[0]!.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toContain('2 events');
    expect(groups[0]!.querySelector('[data-event-seq]')).toBeNull();
    act(() => button.click());
    const nested = [...groups[0]!.querySelectorAll<HTMLElement>('[data-slot="trace"] [data-event-seq]')];
    expect(nested.map((n) => n.dataset.eventSeq)).toEqual(['3', '2']);
    const top = steps(el).filter((s) => !groups[0]!.contains(s));
    expect(top.map((s) => s.dataset.eventSeq)).toEqual(['1']);
  });

  it('makes one line of all the job\'s checkpoints, with the last one\'s machine and how many were taken (issue #1975)', () => {
    const el = render(job('waiting_on'), [
      event(4, 'job.checkpointed', { machineId: 'fleet-1', bytes: 9, session: true, commits: 0 }),
      event(3, 'job.waiting'),
      event(2, 'job.checkpointed', { machineId: 'fleet-1', bytes: 9, session: true, commits: 0 }),
      event(1, 'job.started'),
    ]);
    const groups = [...el.querySelectorAll<HTMLElement>('[data-slot="job-timeline"] [data-step-key]')];
    expect(groups.map((g) => g.dataset.stepKey)).toEqual(['checkpoint:j1']);
    const line = groups[0]!.querySelector<HTMLElement>('[data-slot="trace-line"]')!;
    expect(line.textContent).toContain('last checkpoint on fleet-1');
    expect(line.textContent).toContain('2 checkpoints taken');
    expect(line.dataset.status).toBeUndefined();
    expect(steps(el).map((s) => s.dataset.eventSeq)).toEqual(['3', '1']);
  });

  it('runs a step that has not ended while its job is at work', () => {
    const el = render(job('running'), [event(2, 'step.started', { step: 's1', host: 'win', command: 'build' }), event(1, 'job.started')]);
    const line = el.querySelector<HTMLElement>('[data-step-key="step:s1"] [data-slot="trace-line"]')!;
    expect(line.dataset.status).toBe('running');
  });

  it('nests a fork under one line, running while its fork job works, that links the fork job', () => {
    const el = render(job('waiting_answer'), [event(1, 'job.forked', { forkId: 'f1234567890', to: 'research', note: 'the token lifetime' })], (id) => id === 'f1234567890' ? 'running' : undefined);
    const group = el.querySelector<HTMLElement>('[data-step-key="fork:f1234567890"]')!;
    const line = group.querySelector<HTMLElement>('[data-slot="trace-line"]')!;
    expect(line.dataset.status).toBe('running');
    expect(line.textContent).toContain('research');
    expect(line.textContent).toContain('the token lifetime');
    act(() => group.querySelector('button')!.click());
    expect(group.querySelector<HTMLAnchorElement>('a[href="#job/f1234567890"]')).not.toBeNull();
  });

  it('nests a tend job under one line that links it, and opened, shows that job\'s own events', async () => {
    const asked: string[] = [];
    const readEvents = (jobId: string) => {
      asked.push(jobId);
      return Promise.resolve([{ ...event(9, 'job.failed', { error: 'conflict in a.ts' }), jobId }, { ...event(8, 'job.started'), jobId }]);
    };
    const el = render(job('finished'), [
      event(2, 'job.pull_request_tended', { pullRequest: 'https://github.com/o/r/pull/7', step: 'rebase', nextJobId: 't1234567890' }),
      event(1, 'job.finished'),
    ], (id) => id === 't1234567890' ? 'failed' : undefined, readEvents);
    const group = el.querySelector<HTMLElement>('[data-step-key="tend:t1234567890"]')!;
    const line = group.querySelector<HTMLElement>('[data-slot="trace-line"]')!;
    expect(line.dataset.status).toBe('error');
    expect(line.textContent).toContain('rebase');
    expect(line.textContent).toContain('pull/7');
    expect(group.querySelector('button')!.getAttribute('aria-label')).toContain('failed');
    expect(asked).toEqual([]);
    await act(async () => { group.querySelector('button')!.click(); await Promise.resolve(); });
    expect(asked).toEqual(['t1234567890']);
    expect(group.querySelector<HTMLAnchorElement>('a[href="#job/t1234567890"]')).not.toBeNull();
    const nested = [...group.querySelectorAll<HTMLElement>('[data-slot="trace"] [data-event-seq]')].map((n) => n.dataset.eventSeq);
    expect(nested).toEqual(['2', '9', '8']);
    expect(group.querySelector<HTMLElement>('[data-event-seq="9"] [data-slot="trace-line"]')!.dataset.status).toBe('error');
  });

  it('nests a rework job under one line with the person\'s notes', () => {
    const el = render(job('finished'), [event(1, 'job.rework_requested', { pullRequest: 'https://github.com/o/r/pull/7', notes: 'name the test', nextJobId: 'r1234567890' })], () => 'running');
    const line = el.querySelector<HTMLElement>('[data-step-key="rework:r1234567890"] [data-slot="trace-line"]')!;
    expect(line.dataset.status).toBe('running');
    expect(line.textContent).toContain('name the test');
  });
});
