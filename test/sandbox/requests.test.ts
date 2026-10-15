// Issue #991: sandbox requests, a job's ask for sandbox runs of a template. One per job and template; it waits for a
// person unless skip sandbox approval is on; every step an event on the job's timeline. Issue #1349: an approval starts
// nothing — the job's box steps then run, each in a sandbox of its own.
import { describe, expect, it } from 'vitest';
import { AUTO_APPROVER, editedApprovals, NO_SKIPS, sandboxYolo, templateApprovalBy, type SandboxApprovals } from '../../src/domain/sandbox-approvals.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createSandboxRequests } from '../../src/sandbox/requests.ts';
import { REMEMBERED_APPROVER } from '../../src/domain/remembered-writes.ts';

const T = { name: 'asked-1' } as TemplateView;

function setup(o: { approvals?: SandboxApprovals } = {}) {
  const events: NewEvent[] = [];
  const atWork = new Set(['job-1', 'job-2']);
  const requests = createSandboxRequests({
    record: (e) => events.push(e),
    approvals: () => o.approvals ?? NO_SKIPS,
    template: (name) => (name === T.name ? T : undefined),
    atWork: (j) => atWork.has(j),
    jobTitle: (j) => `title of ${j}`,
    clock: { now: () => new Date('2026-10-13T10:00:00Z') },
    newId: () => `r${events.length}`,
  });
  return { requests, events, atWork, types: () => events.map((e) => e.type) };
}

describe('sandbox requests (issue #991)', () => {
  it('waits for a person; asked again, the same request; approved, and no box starts (issue #1349)', () => {
    const s = setup();
    const r = s.requests.ask('job-1', T.name);
    expect(r).toMatchObject({ jobId: 'job-1', jobTitle: 'title of job-1', template: T.name, state: 'waiting' });
    expect(s.requests.ask('job-1', T.name).id).toBe(r.id);
    expect(s.requests.list()).toHaveLength(1);
    expect(s.requests.approve(r.id, 'Ada')).toEqual({ ok: true });
    expect(s.requests.ask('job-1', T.name)).toMatchObject({ id: r.id, state: 'approved', approvedBy: 'Ada' });
    expect(s.types()).toEqual(['vault.sandbox_requested', 'vault.sandbox_approved']);
    expect(s.events.every((e) => e.jobId === 'job-1')).toBe(true);
    expect(s.events[1]!.data).toMatchObject({ request: r.id, template: T.name, by: 'Ada' });
    expect(s.requests.approve(r.id, 'Ada')).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('skip sandbox approval approves the runs the moment the job asks, and the event names the toggle', () => {
    const s = setup({ approvals: { skipTemplateApproval: false, skipSandboxApproval: true } });
    expect(s.requests.ask('job-1', T.name)).toMatchObject({ state: 'approved', approvedBy: 'skip sandbox approval' });
    expect(s.events.find((e) => e.type === 'vault.sandbox_approved')!.data).toMatchObject({ by: 'skip sandbox approval' });
  });

  it('a declined request stays declined with its reason; another job asks on its own', () => {
    const s = setup();
    const r = s.requests.ask('job-1', T.name);
    expect(s.requests.decline(r.id, 'not now', 'Ada')).toEqual({ ok: true });
    expect(s.requests.ask('job-1', T.name)).toMatchObject({ state: 'declined', reason: 'not now' });
    expect(s.requests.ask('job-2', T.name)).toMatchObject({ state: 'waiting' });
    expect(s.requests.decline('nope', 'x', 'Ada')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('a request of a job no longer at work is forgotten', () => {
    const s = setup();
    s.requests.ask('job-1', T.name);
    s.atWork.delete('job-1');
    expect(s.requests.list()).toEqual([]);
  });
});

describe('an approval starts nothing (issue #1349)', () => {
  it('20 runs approved at once each answer at once, with no box to start', () => {
    const s = setup();
    const jobs = Array.from({ length: 20 }, (_, i) => `job-b${i}`);
    for (const j of jobs) s.atWork.add(j);
    const asked = jobs.map((j) => s.requests.ask(j, T.name));
    expect(asked.map((r) => s.requests.approve(r.id, 'Ada'))).toEqual(asked.map(() => ({ ok: true })));
    expect(s.requests.list().every((r) => r.state === 'approved')).toBe(true);
    expect(s.types().filter((t) => t === 'vault.sandbox_started' || t === 'vault.sandbox_failed')).toEqual([]);
  });
});

describe('the sandbox approval toggles (issue #991)', () => {
  it('YOLO sets both; each toggle named sets itself; absent keeps', () => {
    expect(sandboxYolo(NO_SKIPS)).toBe(false);
    const yolo = editedApprovals(NO_SKIPS, { yolo: true });
    expect(yolo).toEqual({ skipTemplateApproval: true, skipSandboxApproval: true });
    expect(sandboxYolo(yolo)).toBe(true);
    expect(editedApprovals(yolo, { skipSandboxApproval: false })).toEqual({ skipTemplateApproval: true, skipSandboxApproval: false });
    expect(editedApprovals(yolo, { yolo: false })).toEqual(NO_SKIPS);
    expect(editedApprovals(NO_SKIPS, {})).toEqual(NO_SKIPS);
  });
});

describe('runs approved with no separate run approval (issue #1001)', () => {
  const HIGH = { name: 'asked-2', radius: { level: 'high', reasons: [] } } as unknown as TemplateView;
  const LOW = { name: 'asked-3', radius: { level: 'low', reasons: [] } } as unknown as TemplateView;
  function on(templates: TemplateView[], approvals: SandboxApprovals = NO_SKIPS) {
    const events: NewEvent[] = [];
    const requests = createSandboxRequests({
      record: (e) => events.push(e),
      approvals: () => approvals,
      template: (name) => templates.find((t) => t.name === name),
      atWork: () => true,
      clock: { now: () => new Date('2026-10-13T10:00:00Z') },
      newId: () => `r${events.length}`,
    });
    return { requests, events };
  }

  it('a low-radius run is approved at once, by the auto-approve policy, an event that names it', () => {
    const s = on([LOW]);
    expect(s.requests.ask('job-1', LOW.name)).toMatchObject({ state: 'approved', approvedBy: AUTO_APPROVER });
    expect(s.events.find((e) => e.type === 'vault.sandbox_approved')!.data).toMatchObject({ by: AUTO_APPROVER, radius: 'low' });
  });

  it('a high-radius run waits by default; with high on, it is approved', () => {
    expect(on([HIGH]).requests.ask('job-1', HIGH.name).state).toBe('waiting');
    expect(on([{ ...HIGH, approval: { by: 'skip template approval' } } as TemplateView]).requests.ask('job-1', HIGH.name).state).toBe('waiting');
    expect(on([HIGH], { ...NO_SKIPS, autoApprove: { low: true, medium: false, high: true } }).requests.ask('job-1', HIGH.name).state).toBe('approved');
  });

  it('a person who approved the template a job asked for approved its run for that job, not for another', () => {
    const t = { ...HIGH, askedBy: 'job-1', approval: { by: 'Ada' } } as unknown as TemplateView;
    const s = on([t]);
    expect(s.requests.ask('job-1', t.name)).toMatchObject({ state: 'approved', approvedBy: templateApprovalBy('Ada') });
    expect(s.requests.ask('job-2', t.name).state).toBe('waiting');
  });

  it('a job that waited on the template while a person approved it gets its run with that approval', () => {
    const t = { ...HIGH, askedBy: 'job-1', approval: { by: 'Ada' } } as unknown as TemplateView;
    const s = on([t]);
    s.requests.waited('job-3', t.name);
    expect(s.requests.ask('job-3', t.name)).toMatchObject({ state: 'approved', approvedBy: templateApprovalBy('Ada') });
  });
});

describe('a remembered write approval and the purpose of a run (issue #1001)', () => {
  const WRITE = { operation: 'write', asset: { kind: 'aws-account', name: '123456789012' } } as const;
  const HIGH = { name: 'asked-w', secrets: [], profiles: [WRITE], radius: { level: 'high', reasons: [] }, approval: { by: 'Ada' }, askedBy: 'job-1' } as unknown as TemplateView;
  function remembering(o: { remembered?: boolean; secrets?: string[] } = {}) {
    const events: NewEvent[] = [];
    const t = { ...HIGH, secrets: o.secrets ?? [] };
    const requests = createSandboxRequests({
      record: (e) => events.push(e),
      approvals: () => NO_SKIPS,
      template: (name) => (name === t.name ? t : undefined),
      atWork: () => true,
      jobTitle: (j) => `title of ${j}`,
      jobUrl: (j) => `https://github.com/acme/infra/issues/${j.slice(-1)}`,
      remembered: () => (o.remembered === false ? [] : [{ ...WRITE, by: 'Ada', at: '2026-10-13T09:00:00.000Z' }]),
      policy: () => undefined,
      clock: { now: () => new Date('2026-10-13T10:00:00Z') },
      newId: () => `r${events.length}`,
    });
    return { requests, events };
  }

  it('another job\'s run of a template whose writes are remembered is approved with no person, by the remembered approval', () => {
    const s = remembering();
    expect(s.requests.ask('job-2', HIGH.name)).toMatchObject({ state: 'approved', approvedBy: REMEMBERED_APPROVER });
    expect(s.events.find((e) => e.type === 'vault.sandbox_approved')!.data).toMatchObject({ by: REMEMBERED_APPROVER });
  });

  it('without a remembered approval, or with a vault secret, it waits for a person', () => {
    expect(remembering({ remembered: false }).requests.ask('job-2', HIGH.name).state).toBe('waiting');
    expect(remembering({ secrets: ['KUBE_TOKEN'] }).requests.ask('job-2', HIGH.name).state).toBe('waiting');
  });

  it('keeps the job\'s purpose, its plan and its link on the run', () => {
    const s = remembering({ remembered: false });
    const r = s.requests.ask('job-2', HIGH.name, { purpose: 'Create the cluster role for X', plan: 'kubectl apply -f role.yaml' });
    expect(r).toMatchObject({ jobTitle: 'title of job-2', jobUrl: 'https://github.com/acme/infra/issues/2', purpose: 'Create the cluster role for X', plan: 'kubectl apply -f role.yaml' });
  });
});
