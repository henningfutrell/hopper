// Issue #991: sandbox requests, a job's ask for sandbox runs of a template. One per job and template; it waits for a
// person unless skip sandbox approval is on; every step an event on the job's timeline. Issue #1349: an approval starts
// nothing — the job's box steps then run, each in a sandbox of its own.
import { describe, expect, it } from 'vitest';
import { AUTO_APPROVER, carriedApprovalBy, editedApprovals, HOLD_TIMEOUT, SANDBOX_HOLD_MS, NO_SKIPS, sandboxYolo, templateApprovalBy, type SandboxApprovals } from '../../src/domain/sandbox-approvals.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createSandboxRequests } from '../../src/sandbox/requests.ts';
import { REMEMBERED_APPROVER } from '../../src/domain/remembered-writes.ts';
import type { SandboxStrictness } from '../../src/domain/sandbox-strictness.ts';

/** Nothing of a template waits for a person but its approval (issue #2197: a run card reads it). */
const NONE_PENDING = { pending: { secrets: [], image: false, egress: [], profiles: [] } };
const T = { name: 'asked-1', ...NONE_PENDING } as unknown as TemplateView;

function setup(o: { approvals?: SandboxApprovals } = {}) {
  const events: NewEvent[] = [];
  const live = new Set(['job-1', 'job-2']);
  const requests = createSandboxRequests({
    record: (e) => events.push(e),
    approvals: () => o.approvals ?? NO_SKIPS,
    template: (name) => (name === T.name ? T : undefined),
    live: (j) => live.has(j),
    jobTitle: (j) => `title of ${j}`,
    clock: { now: () => new Date('2026-10-13T10:00:00Z') },
    newId: () => `r${events.length}`,
  });
  return { requests, events, live, types: () => events.map((e) => e.type) };
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
    expect(s.types()).toEqual(['vault.sandbox_requested', 'vault.run_card_opened', 'vault.sandbox_approved']);
    expect(s.events.every((e) => e.jobId === 'job-1')).toBe(true);
    expect(s.events[2]!.data).toMatchObject({ request: r.id, template: T.name, by: 'Ada' });
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

  it('a request of a job that ended is forgotten', () => {
    const s = setup();
    s.requests.ask('job-1', T.name);
    s.live.delete('job-1');
    expect(s.requests.list()).toEqual([]);
  });
});

describe('an approval starts nothing (issue #1349)', () => {
  it('20 runs approved at once each answer at once, with no box to start', () => {
    const s = setup();
    const jobs = Array.from({ length: 20 }, (_, i) => `job-b${i}`);
    for (const j of jobs) s.live.add(j);
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
  const HIGH = { name: 'asked-2', ...NONE_PENDING, radius: { level: 'high', reasons: [] } } as unknown as TemplateView;
  const LOW = { name: 'asked-3', ...NONE_PENDING, radius: { level: 'low', reasons: [] } } as unknown as TemplateView;
  function on(templates: TemplateView[], approvals: SandboxApprovals = NO_SKIPS) {
    const events: NewEvent[] = [];
    const requests = createSandboxRequests({
      record: (e) => events.push(e),
      approvals: () => approvals,
      template: (name) => templates.find((t) => t.name === name),
      live: () => true,
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

describe('the asks that wait on a template, as run cards (issue #2197)', () => {
  it('keeps each job\'s first ask with its words; forgets it when the job ends', () => {
    const s = setup();
    expect(s.requests.waited('job-1', T.name, { purpose: 'Why', plan: 'Plan (undo: none)' })).toBeUndefined();
    s.requests.waited('job-1', T.name, { purpose: 'Asked again' });
    s.requests.waited('job-2', T.name);
    expect(s.requests.waits()).toEqual([
      { jobId: 'job-1', template: T.name, purpose: 'Why', plan: 'Plan (undo: none)', askedAt: '2026-10-13T10:00:00.000Z' },
      { jobId: 'job-2', template: T.name, askedAt: '2026-10-13T10:00:00.000Z' },
    ]);
    s.live.delete('job-1');
    expect(s.requests.waits().map((w) => w.jobId)).toEqual(['job-2']);
  });

  it('a person declines a run not yet asked: the job\'s wait is told no, and its later ask is declined', () => {
    const s = setup();
    s.requests.waited('job-1', T.name, { purpose: 'Why' });
    expect(s.requests.declineRun('job-1', T.name, 'not now', 'Ada')).toEqual({ ok: true });
    expect(s.requests.waited('job-1', T.name)).toMatchObject({ state: 'declined', reason: 'not now', declinedBy: 'Ada', purpose: 'Why' });
    expect(s.requests.ask('job-1', T.name)).toMatchObject({ state: 'declined' });
    expect(s.types()).toEqual(['vault.run_card_opened', 'vault.sandbox_declined']);
    expect(s.requests.declineRun('job-1', T.name, 'again', 'Ada')).toMatchObject({ ok: false, code: 'conflict' });
    expect(s.requests.declineRun('job-2', T.name, 'x', 'Ada')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('a person declines a waiting run by its job and template', () => {
    const s = setup();
    const r = s.requests.ask('job-1', T.name);
    expect(s.requests.declineRun('job-1', T.name, 'no', 'Ada')).toEqual({ ok: true });
    expect(s.requests.list().find((x) => x.id === r.id)).toMatchObject({ state: 'declined', reason: 'no' });
  });
});

describe('a remembered write approval and the purpose of a run (issue #1001)', () => {
  const WRITE = { operation: 'write', asset: { kind: 'aws-account', name: '123456789012' } } as const;
  const HIGH = { name: 'asked-w', ...NONE_PENDING, secrets: [], profiles: [WRITE], radius: { level: 'high', reasons: [] }, approval: { by: 'Ada' }, askedBy: 'job-1' } as unknown as TemplateView;
  function remembering(o: { remembered?: boolean; secrets?: string[] } = {}) {
    const events: NewEvent[] = [];
    const t = { ...HIGH, secrets: o.secrets ?? [] };
    const requests = createSandboxRequests({
      record: (e) => events.push(e),
      approvals: () => NO_SKIPS,
      template: (name) => (name === t.name ? t : undefined),
      live: () => true,
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

describe('a job below approved (issue #655 part 7)', () => {
  it('gets no run with no person: every automatic approver waits; a person approves it', () => {
    const events: NewEvent[] = [];
    const t = { name: 'asked-low', ...NONE_PENDING, askedBy: 'job-1', approval: { by: 'Ada' }, radius: { level: 'low', reasons: [] } } as unknown as TemplateView;
    const requests = createSandboxRequests({
      record: (e) => events.push(e),
      approvals: () => ({ skipTemplateApproval: true, skipSandboxApproval: true }),
      template: (name) => (name === t.name ? t : undefined),
      live: () => true,
      autoApprovable: (j) => j !== 'job-1',
      clock: { now: () => new Date('2026-10-17T10:00:00Z') },
      newId: () => `r${events.length}`,
    });
    const r = requests.ask('job-1', t.name);
    expect(r.state).toBe('waiting');
    expect(requests.approve(r.id, 'Ada')).toEqual({ ok: true });
    expect(requests.ask('job-2', t.name)).toMatchObject({ state: 'approved', approvedBy: 'skip sandbox approval' });
  });
});

describe('sandbox strictness (issue #655 part 8, brake 2)', () => {
  const LOW = { name: 'asked-low', ...NONE_PENDING, radius: { level: 'low', reasons: [] } } as unknown as TemplateView;
  const HIGH = { name: 'asked-high', ...NONE_PENDING, radius: { level: 'high', reasons: [] } } as unknown as TemplateView;
  function braked(strictness: SandboxStrictness) {
    const events: NewEvent[] = [];
    let s = strictness;
    const requests = createSandboxRequests({
      record: (e) => events.push(e),
      approvals: () => ({ skipTemplateApproval: true, skipSandboxApproval: true }),
      template: (name) => [LOW, HIGH].find((t) => t.name === name),
      live: () => true,
      strictness: () => s,
      clock: { now: () => new Date('2026-10-17T10:00:00Z') },
      newId: () => `r${events.length}`,
    });
    return { requests, set: (to: SandboxStrictness) => { s = to; } };
  }

  it('strict: a run of a medium or high template waits for a person, whatever the toggles say; a low one does not', () => {
    const b = braked({ default: 'strict', radius: {}, templates: {} });
    expect(b.requests.ask('job-1', LOW.name)).toMatchObject({ state: 'approved', approvedBy: 'skip sandbox approval' });
    const r = b.requests.ask('job-1', HIGH.name);
    expect(r.state).toBe('waiting');
    expect(b.requests.approve(r.id, 'Ada')).toEqual({ ok: true });
    expect(b.requests.runnable('job-1')).toEqual([LOW.name, HIGH.name]);
  });

  it('locked for a template: every run of it waits for a person', () => {
    const b = braked({ default: 'standard', radius: {}, templates: { [LOW.name]: 'locked' } });
    expect(b.requests.ask('job-1', LOW.name).state).toBe('waiting');
    expect(b.requests.ask('job-1', HIGH.name).state).toBe('approved');
  });

  it('tightened: a run approved with no person no longer counts; one a person approved still does', () => {
    const b = braked({ default: 'standard', radius: {}, templates: {} });
    b.requests.ask('job-1', LOW.name);
    b.requests.ask('job-1', HIGH.name);
    expect(b.requests.runnable('job-1')).toEqual([LOW.name, HIGH.name]);
    b.set({ default: 'locked', radius: {}, templates: {} });
    expect(b.requests.runnable('job-1')).toEqual([]);
    b.set({ default: 'standard', radius: {}, templates: {} });
    expect(b.requests.runnable('job-1')).toEqual([LOW.name, HIGH.name]);
  });

  it('below approved (part 7), only a person\'s approval counts', () => {
    const events: NewEvent[] = [];
    let auto = true;
    const requests = createSandboxRequests({
      record: (e) => events.push(e), approvals: () => ({ skipTemplateApproval: true, skipSandboxApproval: true }),
      template: (name) => (name === LOW.name ? LOW : undefined), live: () => true, autoApprovable: () => auto,
      clock: { now: () => new Date('2026-10-17T10:00:00Z') }, newId: () => `r${events.length}`,
    });
    requests.ask('job-1', LOW.name);
    expect(requests.runnable('job-1')).toEqual([LOW.name]);
    auto = false;
    expect(requests.runnable('job-1')).toEqual([]);
  });
});

describe('a held request that times out (issue #655 part 9)', () => {
  function timed() {
    const events: NewEvent[] = [];
    let now = new Date('2026-10-17T10:00:00Z');
    const requests = createSandboxRequests({
      record: (e) => events.push(e),
      approvals: () => NO_SKIPS,
      template: (name) => (name === T.name ? T : undefined),
      live: () => true,
      clock: { now: () => now },
      newId: () => `r${events.length}`,
    });
    return { requests, events, later: (ms: number) => { now = new Date(now.getTime() + ms); } };
  }

  it('waits 24 hours for a person; then the hopper declines it, for this request only', () => {
    const s = timed();
    const r = s.requests.ask('job-1', T.name);
    s.later(SANDBOX_HOLD_MS - 1);
    expect(s.requests.expire()).toBe(0);
    expect(s.requests.ask('job-1', T.name).state).toBe('waiting');
    s.later(1);
    expect(s.requests.expire()).toBe(1);
    expect(s.requests.ask('job-1', T.name)).toMatchObject({ id: r.id, state: 'declined', declinedBy: HOLD_TIMEOUT, reason: 'no person answered it within 24 hours' });
    expect(s.events.at(-1)).toMatchObject({ type: 'vault.sandbox_declined', jobId: 'job-1', data: { request: r.id, template: T.name, by: HOLD_TIMEOUT, reason: 'no person answered it within 24 hours' } });
    expect(s.requests.expire()).toBe(0);
    expect(s.requests.approve(r.id, 'Ada')).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('an approved or declined request does not time out; a list declines one overdue too', () => {
    const s = timed();
    const a = s.requests.ask('job-1', T.name), b = s.requests.ask('job-2', T.name);
    s.requests.approve(a.id, 'Ada');
    s.requests.ask('job-3', T.name);
    s.requests.decline(b.id, 'no', 'Ada');
    s.later(SANDBOX_HOLD_MS);
    expect(s.requests.list().map((r) => [r.jobId, r.state, r.declinedBy])).toEqual([['job-1', 'approved', undefined], ['job-2', 'declined', 'Ada'], ['job-3', 'declined', HOLD_TIMEOUT]]);
  });
});

describe('a person\'s approval of a run carries to the job that runs it again (issue #2639 part 2)', () => {
  function rerun(o: { autoApprovable?: (j: string) => boolean } = {}) {
    const events: NewEvent[] = [];
    const live = new Set(['job-1']);
    // job-2 runs job-1 again; job-3 runs job-2 again.
    const rerunOf: Record<string, string> = { 'job-2': 'job-1', 'job-3': 'job-2' };
    const requests = createSandboxRequests({
      record: (e) => events.push(e),
      approvals: () => NO_SKIPS,
      template: (name) => (name === T.name ? T : undefined),
      live: (j) => live.has(j),
      earlier: (j) => { const out: string[] = []; for (let p = rerunOf[j]; p; p = rerunOf[p]) out.push(p); return out; },
      ...(o.autoApprovable ? { autoApprovable: o.autoApprovable } : {}),
      clock: { now: () => new Date('2026-10-23T15:00:00Z') },
      newId: () => `r${events.length}`,
    });
    return { requests, events, live };
  }

  it('the rerun\'s run of the same template is approved at once, by the approval of the job it runs again', () => {
    const s = rerun();
    s.requests.approve(s.requests.ask('job-1', T.name).id, 'Ada');
    s.live.delete('job-1');
    s.live.add('job-2');
    expect(s.requests.ask('job-2', T.name)).toMatchObject({ state: 'approved', approvedBy: carriedApprovalBy('job-1') });
    expect(s.events.at(-1)).toMatchObject({ type: 'vault.sandbox_approved', jobId: 'job-2', data: { template: T.name, by: carriedApprovalBy('job-1') } });
    expect(s.requests.runnable('job-2')).toEqual([T.name]);
    // And on to the next rerun.
    s.live.delete('job-2');
    s.live.add('job-3');
    expect(s.requests.ask('job-3', T.name)).toMatchObject({ state: 'approved', approvedBy: carriedApprovalBy('job-2') });
  });

  it('carries no decline, no toggle\'s approval and no approval of another job; a job not a rerun waits', () => {
    const s = rerun();
    s.requests.decline(s.requests.ask('job-1', T.name).id, 'no', 'Ada');
    s.live.delete('job-1');
    s.live.add('job-2');
    expect(s.requests.ask('job-2', T.name).state).toBe('waiting');
    s.live.add('job-9');
    expect(s.requests.ask('job-9', T.name).state).toBe('waiting');
  });

  it('a rerun whose trust a person must vouch for gets no carried approval', () => {
    const s = rerun({ autoApprovable: (j) => j !== 'job-2' });
    s.requests.approve(s.requests.ask('job-1', T.name).id, 'Ada');
    s.live.delete('job-1');
    s.live.add('job-2');
    expect(s.requests.ask('job-2', T.name).state).toBe('waiting');
  });
});
