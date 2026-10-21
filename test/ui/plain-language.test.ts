// @vitest-environment happy-dom
// Plain-language Decisions, Events and Questions (issue #2375): Decisions as a table — time, job by its issue and title,
// kind, the outcome as a sentence, the raw ids behind a detail —; Events as a table with filter chips by event type;
// a question's escalation trail behind "N model answers"; Ask hopper in place of Direct jobs and Direct queries, and
// the old links still open it.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { all, boot, click, unmount } from './long-page-harness.ts';

afterEach(unmount);

const T0 = '2026-10-09T12:00:00.000Z';
const job = (id: string, n: number) => ({
  id, spec: { executor: 'test', payload: {}, goal: `Fix part ${n}` }, priority: 50, status: 'queued', approved: false, accepted: true,
  createdAt: T0, updatedAt: T0, attempts: 0, source: { kind: 'github', key: `k${n}`, repo: 'owner/app', number: n, title: `Fix part ${n}` },
});
const JOBS = ['a1b2c3d4e5f6', 'b2c3d4e5f6a1', 'c3d4e5f6a1b2', 'd4e5f6a1b2c3'];
const QUEUE = { '/api/queue': { waiting: JOBS.map((id, i) => job(id, i + 1)), running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] } };
const decision = {
  id: 'f00dfeedcafe0001', at: T0, trigger: 'job.queued', lanes: [], wait: [], advice: [], reasons: ['one lane free'], inputs: {},
  start: [{ jobId: JOBS[0], laneId: null, machineId: 'm1', effectivePriority: 50, reason: 'highest priority' }],
  hold: JOBS.slice(1).map((jobId) => ({ jobId, reason: 'the usage limit' })),
};

describe('Decisions as a table (issue #2375)', () => {
  it('names the job by its issue and title, the kind, and the outcome as a sentence', async () => {
    await boot('#decisions', { ...QUEUE, '/api/decisions': { decisions: [decision] } });
    const rows = all('[data-slot="decision-row"]');
    expect(rows).toHaveLength(1);
    const job = rows[0]!.querySelector('[data-slot="decision-job"]')!.textContent!;
    expect(job).toContain('app#1');
    expect(job).toContain('Fix part 1');
    expect(job).toContain('+3 more');
    expect(rows[0]!.querySelector('[data-slot="decision-kind"]')!.textContent).toBe('job queued');
    expect(rows[0]!.querySelector('[data-slot="decision-outcome"]')!.textContent).toBe('started 1 job, held 3: the usage limit');
    expect(rows[0]!.textContent).not.toContain('f00dfeed');
  });

  it('shows the raw ids only in the detail', async () => {
    await boot('#decisions', { ...QUEUE, '/api/decisions': { decisions: [decision] } });
    expect(document.querySelector('[data-slot="decision-detail"]')).toBeNull();
    await click(document.querySelector('[data-slot="decision-row"] [data-slot="decision-detail-toggle"]'));
    const detail = document.querySelector('[data-slot="decision-detail"]')!;
    expect(detail.textContent).toContain('f00dfeedcafe0001');
    expect(detail.textContent).toContain('a1b2c3d4e5f6');
  });
});

const ev = (seq: number, type: string, o: Record<string, unknown> = {}) => ({ seq, schemaVersion: 1, id: `e${seq}`, type, at: T0, data: {}, ...o });
const EVENTS = { '/api/events': { events: [ev(1, 'job.started', { jobId: JOBS[0] }), ev(2, 'lane.opened', { laneId: 'm1:lane-1', machineId: 'm1' }), ev(3, 'job.finished', { jobId: JOBS[0] })] } };

describe('Events as a table (issue #2375)', () => {
  it('shows time, job, event type and message in columns', async () => {
    await boot('#events', { ...QUEUE, ...EVENTS });
    const heads = all('[data-slot="events-table"] th').map((h) => h.textContent).slice(0, 4);
    expect(heads).toEqual(['Time', 'Job', 'Event type', 'Message']);
    const rows = all('[data-slot="events-table"] tbody tr[data-event-seq]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('app#1');
  });

  it('filters by event type with chips', async () => {
    await boot('#events', { ...QUEUE, ...EVENTS });
    const chips = all('[data-slot="event-type-chip"]');
    expect(chips.map((c) => c.getAttribute('data-type'))).toEqual(['all', 'job', 'lane']);
    await click(chips.find((c) => c.getAttribute('data-type') === 'lane'));
    const rows = all('tr[data-event-seq]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('lane.opened');
  });
});

const attempt = (role: string) => ({ tier: role, role, model: 'claude-x', outcome: 'escalated', answer: `${role} says main`, startedAt: T0, finishedAt: T0 });
const QUESTION = { '/api/questions': { questions: [{
  id: 'q1', jobId: JOBS[0], text: 'Which branch?', recentOutput: 'line', detectedBy: 'marker', status: 'open', tier: 'human',
  attempts: [attempt('sonnet'), attempt('opus')], notifyCount: 1, createdAt: T0, updatedAt: T0,
}] } };

describe('Questions keep the trail folded (issue #2375)', () => {
  it('folds the model answers behind one toggle, the answer box in view', async () => {
    await boot('#questions', { ...QUEUE, ...QUESTION });
    const toggle = document.querySelector('[data-slot="model-answers-toggle"]')!;
    expect(toggle.textContent).toContain('2 model answers');
    expect(document.body.textContent).not.toContain('sonnet says main');
    expect(document.querySelector('[data-question] textarea')).not.toBeNull();
    await click(toggle);
    expect(document.body.textContent).toContain('sonnet says main');
    expect(document.body.textContent).toContain('opus says main');
  });
});

const DIRECT = { '/api/direct-jobs': { directJobs: [] }, '/api/direct-queries': { directQueries: [] } };

describe('Ask hopper (issue #2375)', () => {
  it('is one nav entry in place of Direct jobs and Direct queries', async () => {
    await boot('#ask', DIRECT);
    const labels = all('nav a').map((a) => a.textContent);
    expect(labels).toContain('Ask hopper');
    expect(labels).not.toContain('Direct jobs');
    expect(labels).not.toContain('Direct queries');
    const tabs = all('[data-slot="page-tabs"] a').map((a) => a.textContent);
    expect(tabs).toEqual(['Run a job', 'Ask a question']);
  });

  it.each([['#direct-jobs', 'Run a job'], ['#direct-queries', 'Ask a question'], ['#ask/question', 'Ask a question']])('%s opens Ask hopper on %s', async (hash, tab) => {
    await boot(hash, DIRECT);
    expect(document.querySelector('nav a[aria-current="page"]')?.textContent).toBe('Ask hopper');
    expect(document.querySelector('[data-slot="page-tabs"] a[aria-current="page"]')?.textContent).toBe(tab);
  });
});

describe('Plain labels (issue #2375)', () => {
  it('the Queue badge says the jobs wait to be ordered', async () => {
    const waiting = [{ ...job(JOBS[0]!, 1), accepted: false }];
    await boot('#queue', { '/api/queue': { ...QUEUE['/api/queue'], waiting, gate: { mode: 'review', autoAcceptPerHour: null }, presort: { sorter: 'priority', jobIds: [JOBS[0]], reject: [] } } });
    const badge = all('nav a').find((a) => a.getAttribute('href') === '#queue')!.querySelector('[data-slot="nav-badge"]')!;
    expect(badge.getAttribute('title')).toBe('1 job waiting to be ordered');
    expect(document.body.textContent).not.toMatch(/pre-sort/i);
  });

  it('a backburner issue is "Later", with a tooltip that says what it is', async () => {
    const item = { key: 'https://github.com/owner/app/issues/9', repo: 'owner/app', title: 'Old idea', group: 'backburner', reason: 'on the backburner', action: 'unbackburner' };
    const detail = { login: 'owner', assignee: 'owner', label: 'hopper', intake: [item] };
    await boot('#intake', { '/api/sources': { sources: [{ name: 'gh', kind: 'github-account', state: 'ok', itemsSeen: 1, jobsCreated: 0, activeJobs: 0, detail }] } });
    await act(async () => {});
    const group = all('[data-slot="intake-group-label"]').find((g) => g.textContent?.includes('Later'));
    expect(group).toBeDefined();
    expect(group!.getAttribute('title')).toMatch(/hopper:backburner/);
  });
});
