// The critical job tracker's model (issue #2203): which jobs it tracks — at or above the critical priority or flagged, an ended one
// until it is dismissed —, each wait of a job that is a person's, from the one home that keeps it, the current step in
// plain words and since when, and the last few actions.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { attentionNotice, currentStep, isCriticalJob, lastActions, sandboxesOf, trackedJobs, trackerKey, waitKey, waitsOf, waitText, type WaitSources } from '../../ui/src/model/critical-jobs.ts';
import type { DomainEvent, QuestionView, ReviewItemView, VaultView } from '../../ui/src/model/wire.ts';

const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 100, status: 'running', approved: false,
  createdAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T10:00:00Z', attempts: 1, ...o,
} as Job);
const event = (seq: number, jobId: string, type: string, at: string): DomainEvent => ({ seq, type, jobId, at, data: {} } as DomainEvent);
const question = (o: Partial<QuestionView> = {}): QuestionView => ({ id: 'q1', jobId: 'j1', text: 'Which cluster?\nmore', status: 'open', tier: 'human', createdAt: '2026-10-19T10:05:00Z', ...o } as QuestionView);
const NONE: WaitSources = { questions: [], vault: null, reviews: { proposal: { items: [] }, research: { items: [] } }, failures: null, logins: [] };

describe('isCriticalJob', () => {
  it('is at or above the critical priority, and none is while it is unknown or off', () => {
    expect(isCriticalJob({ priority: 100 }, 100)).toBe(true);
    expect(isCriticalJob({ priority: 99 }, 100)).toBe(false);
    expect(isCriticalJob({ priority: 90 }, 90)).toBe(true);
    expect(isCriticalJob({ priority: 100 }, null)).toBe(false);
    expect(isCriticalJob({ priority: 100 }, 0)).toBe(false);
  });

  it('is a job with the critical flag a person set, whatever its priority, and also while the critical priority is off', () => {
    expect(isCriticalJob({ priority: 50, critical: true }, 100)).toBe(true);
    expect(isCriticalJob({ priority: 50, critical: true }, 0)).toBe(true);
    expect(isCriticalJob({ priority: 50, critical: true }, null)).toBe(true);
  });
});

describe('trackedJobs', () => {
  it('tracks the critical jobs, the ones not ended first, an ended one until it is dismissed', () => {
    const jobs = [
      job('done', { status: 'finished', createdAt: '2026-10-19T09:00:00Z' }), job('low', { priority: 75 }),
      job('late', { createdAt: '2026-10-19T11:00:00Z' }), job('early', { status: 'queued', createdAt: '2026-10-19T08:00:00Z' }),
      job('gone', { status: 'failed' }),
    ];
    expect(trackedJobs(jobs, 100, [trackerKey('gone')]).map((j) => j.id)).toEqual(['early', 'late', 'done']);
  });

  it('shows a job that has not ended whatever was dismissed, and each job once', () => {
    const j = job('j1');
    expect(trackedJobs([j, j], 100, [trackerKey('j1')]).map((x) => x.id)).toEqual(['j1']);
  });

  it('tracks a low job with the critical flag', () => {
    expect(trackedJobs([job('flagged', { priority: 50, critical: true }), job('plain', { priority: 50 })], 100, []).map((j) => j.id)).toEqual(['flagged']);
  });
});

describe('waitsOf', () => {
  it('reads each wait from its one home, and only the person\'s', () => {
    const vault = {
      runs: [{ jobId: 'j1', template: 'kubectl-diag', askedAt: '2026-10-19T10:01:00Z', waits: { template: true, run: true } }, { jobId: 'other', template: 'x', askedAt: '', waits: { template: false, run: true } }],
      grantAsks: [{ job: 'j1', key: 'k', names: ['DB_URL'], askedAt: '2026-10-19T10:02:00Z' }],
      requests: [{ id: 'r1', title: 'Grafana token', asked: [{ job: 'j1', machine: 'm', at: '' }] }],
    } as unknown as VaultView;
    const research = { id: 'res1', jobId: 'j1', status: 'open', stage: 'human' } as ReviewItemView;
    const withLevel = { id: 'res2', jobId: 'j1', status: 'open', stage: 'claude' } as ReviewItemView;
    const from: WaitSources = {
      questions: [question(), question({ id: 'q2', tier: 'claude' }), question({ id: 'q3', status: 'answered' })],
      vault, reviews: { proposal: { items: [] }, research: { items: [research, withLevel] } },
      failures: { handoffs: [{ id: 'h1', jobId: 'j1', status: 'open', card: { whatHappened: 'It could not push.' } }, { id: 'h2', jobId: 'j1', status: 'closed' }] } as unknown as WaitSources['failures'],
      logins: [{ id: 'l1', jobId: 'j1', status: 'pending', tool: 'aws' }, { id: 'l2', jobId: 'j1', status: 'completed', tool: 'gh' }] as unknown as WaitSources['logins'],
    };
    const waits = waitsOf(job('j1'), from);
    expect(waits.map((w) => w.kind)).toEqual(['question', 'run', 'grant', 'credential', 'review', 'handoff', 'login']);
    expect(waits.map((w) => waitText(w).act)).toEqual(['Answer', 'Approve', 'Grant', 'Give', 'Decide', 'Resolve', 'Log in']);
    expect(waitText(waits[0]!).what).toBe('Question: Which cluster?');
    expect(waitText(waits[1]!).what).toBe('Sandbox run on kubectl-diag, with its template waits for approval');
    expect(waitText(waits[5]!).what).toBe('Handed off to a person: It could not push.');
    expect(new Set(waits.map((w) => waitKey('j1', w))).size).toBe(waits.length);
  });

  it('a hold, the blast-radius gate, a changed text, an origin, the queue gate and its own wait', () => {
    expect(waitsOf(job('a', { status: 'held', holdReason: 'ask_human: risky' }), NONE).map((w) => w.kind)).toEqual(['hold']);
    expect(waitsOf(job('a', { status: 'held', approved: true }), NONE)).toEqual([]);
    expect(waitsOf(job('a', { status: 'held', holdReason: 'held at the blast-radius gate: gated machines only' }), NONE).map((w) => w.kind)).toEqual(['gate']);
    expect(waitsOf(job('a', { status: 'held', accepted: false }), NONE).map((w) => w.kind)).toEqual(['accept']);
    expect(waitsOf(job('a', { status: 'held', originPending: true }), NONE).map((w) => w.kind)).toEqual(['origin']);
    expect(waitsOf(job('a', { status: 'waiting_on', wait: { for: 'a review', since: '2026-10-19T10:00:00Z' } }), NONE).map((w) => w.kind)).toEqual(['wait']);
    // A wait on its own command is no person's: it is at work.
    expect(waitsOf(job('a', { status: 'waiting_on', wait: { for: 'the build', since: '', ownCommand: true } }), NONE)).toEqual([]);
    expect(waitsOf(job('a'), NONE)).toEqual([]);
  });
});

describe('currentStep', () => {
  const describeIt = (e: DomainEvent) => `did ${e.type}`;
  it('is the newest event while it works, and since that event', () => {
    const events = [event(1, 'j1', 'job.started', '2026-10-19T10:01:00Z'), event(3, 'j1', 'step.started', '2026-10-19T10:03:00Z'), event(2, 'x', 'job.started', '2026-10-19T10:04:00Z')];
    expect(currentStep(job('j1'), events, describeIt)).toEqual({ text: 'did step.started', since: '2026-10-19T10:03:00Z' });
    expect(lastActions(events, 'j1').map((e) => e.seq)).toEqual([3, 1]);
  });

  it('says what it waits on, why it is held, or how it ended', () => {
    expect(currentStep(job('j1', { status: 'waiting_answer', questionId: 'q1' }), [], describeIt, question())).toEqual({ text: 'asks: Which cluster?', since: '2026-10-19T10:05:00Z' });
    expect(currentStep(job('j1', { status: 'waiting_on', wait: { for: 'nodes to go Ready', since: '2026-10-19T10:06:00Z' } }), [], describeIt).text).toBe('waits for nodes to go Ready');
    expect(currentStep(job('j1', { status: 'held', holdReason: 'no machine' }), [], describeIt).text).toBe('held: no machine');
    expect(currentStep(job('j1', { status: 'failed', error: 'push refused\nlog', finishedAt: '2026-10-19T11:00:00Z' }), [], describeIt)).toEqual({ text: 'failed: push refused', since: '2026-10-19T11:00:00Z' });
    expect(currentStep(job('j1', { status: 'claimed' }), [], describeIt).text).toBe('starting');
  });
});

describe('sandboxesOf and the notification', () => {
  it('names the approved sandboxes of the job', () => {
    const vault = { sandboxRequests: [{ jobId: 'j1', template: 'kubectl-diag', state: 'approved' }, { jobId: 'j1', template: 'aws-read', state: 'waiting' }, { jobId: 'j2', template: 'x', state: 'approved' }] } as unknown as VaultView;
    expect(sandboxesOf(job('j1'), vault)).toEqual(['kubectl-diag']);
  });

  it('says what the job waits on', () => {
    expect(attentionNotice('Fix the outage', [{ kind: 'hold' }, { kind: 'wait' }])).toEqual({
      title: 'Critical job needs you: Fix the outage', body: 'Held for a person to approve\nWaits on something a person does',
    });
  });
});
