// Issue #991: sandbox requests, a job's ask for a box of a template. One per job and template; it waits for a person
// unless skip sandbox approval is on; approved, the box starts; every step an event on the job's timeline.
import { describe, expect, it } from 'vitest';
import { AUTO_APPROVER, editedApprovals, NO_SKIPS, sandboxYolo, templateApprovalBy, type SandboxApprovals } from '../../src/domain/sandbox-approvals.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createSandboxRequests } from '../../src/sandbox/requests.ts';

const T = { name: 'asked-1' } as TemplateView;

function setup(o: { approvals?: SandboxApprovals; launch?: () => Promise<{ container: string }>; startMs?: number } = {}) {
  const events: NewEvent[] = [];
  const alive = new Set<string>();
  const atWork = new Set(['job-1', 'job-2']);
  let n = 0;
  const requests = createSandboxRequests({
    record: (e) => events.push(e),
    approvals: () => o.approvals ?? NO_SKIPS,
    template: (name) => (name === T.name ? T : undefined),
    launch: o.launch ?? (async () => { const container = `box-${++n}`; alive.add(container); return { container }; }),
    alive: (c) => alive.has(c),
    atWork: (j) => atWork.has(j),
    jobTitle: (j) => `title of ${j}`,
    clock: { now: () => new Date('2026-10-13T10:00:00Z') },
    newId: () => `r${events.length}`,
    ...(o.startMs !== undefined ? { startMs: o.startMs } : {}),
  });
  return { requests, events, alive, atWork, types: () => events.map((e) => e.type) };
}

describe('sandbox requests (issue #991)', () => {
  it('waits for a person; asked again, the same request; approved, the box starts', async () => {
    const s = setup();
    const r = s.requests.ask('job-1', T.name);
    expect(r).toMatchObject({ jobId: 'job-1', jobTitle: 'title of job-1', template: T.name, state: 'waiting' });
    expect(s.requests.ask('job-1', T.name).id).toBe(r.id);
    expect(s.requests.list()).toHaveLength(1);
    expect(s.requests.approve(r.id, 'Ada')).toEqual({ ok: true });
    await s.requests.idle();
    expect(s.requests.ask('job-1', T.name)).toMatchObject({ id: r.id, state: 'running', container: 'box-1', approvedBy: 'Ada' });
    expect(s.types()).toEqual(['vault.sandbox_requested', 'vault.sandbox_approved', 'vault.sandbox_started']);
    expect(s.events.every((e) => e.jobId === 'job-1')).toBe(true);
    expect(s.events[1]!.data).toMatchObject({ request: r.id, template: T.name, by: 'Ada' });
    expect(s.requests.approve(r.id, 'Ada')).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('skip sandbox approval starts the box the moment the job asks, and the event names the toggle', async () => {
    const s = setup({ approvals: { skipTemplateApproval: false, skipSandboxApproval: true } });
    expect(s.requests.ask('job-1', T.name).state).toBe('starting');
    await s.requests.idle();
    expect(s.requests.ask('job-1', T.name)).toMatchObject({ state: 'running', approvedBy: 'skip sandbox approval' });
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

  it('a start that failed stays failed with its reason, so no event starts it again and again', async () => {
    const s = setup({ approvals: { skipTemplateApproval: false, skipSandboxApproval: true }, launch: async () => { throw new Error('no runtime'); } });
    const first = s.requests.ask('job-1', T.name);
    await s.requests.idle();
    expect(s.requests.ask('job-1', T.name)).toMatchObject({ id: first.id, state: 'failed', reason: 'no runtime' });
    expect(s.types().filter((t) => t === 'vault.sandbox_approved')).toHaveLength(1);
  });

  it('a box that went makes the next ask a new request', async () => {
    const s = setup({ approvals: { skipTemplateApproval: false, skipSandboxApproval: true } });
    const first = s.requests.ask('job-1', T.name);
    await s.requests.idle();
    expect(s.requests.ask('job-1', T.name)).toMatchObject({ id: first.id, state: 'running', container: 'box-1' });
    s.alive.delete('box-1');
    expect(s.requests.ask('job-1', T.name).id).not.toBe(first.id);
  });

  it('a request of a job no longer at work is forgotten', () => {
    const s = setup();
    s.requests.ask('job-1', T.name);
    s.atWork.delete('job-1');
    expect(s.requests.list()).toEqual([]);
  });
});

describe('a box starts outside the approval (issue #1002)', () => {
  it('the approval answers before anything of the start runs', async () => {
    let launched = 0;
    const s = setup({ launch: async () => { launched++; return { container: 'box-1' }; } });
    const r = s.requests.ask('job-1', T.name);
    expect(s.requests.approve(r.id, 'Ada')).toEqual({ ok: true });
    expect(launched).toBe(0);
    expect(s.requests.list()[0]).toMatchObject({ state: 'starting' });
    await s.requests.idle();
    expect(launched).toBe(1);
    expect(s.requests.list()[0]).toMatchObject({ state: 'running', container: 'box-1' });
  });

  it('a start that hangs fails at its time limit with the reason, and the job is told; other requests go on', async () => {
    const hang = new Promise<{ container: string }>(() => {});
    let n = 0;
    const s = setup({ startMs: 50, launch: () => (++n === 1 ? hang : Promise.resolve({ container: 'box-2' })) });
    const stuck = s.requests.ask('job-1', T.name);
    s.requests.approve(stuck.id, 'Ada');
    const other = s.requests.ask('job-2', T.name);
    s.requests.approve(other.id, 'Ada');
    await s.requests.idle();
    expect(s.requests.list()).toEqual([
      expect.objectContaining({ id: stuck.id, state: 'failed', reason: 'the box did not start in 0 s' }),
      expect.objectContaining({ id: other.id, state: 'running', container: 'box-2' }),
    ]);
    expect(s.events.find((e) => e.type === 'vault.sandbox_failed')).toMatchObject({ jobId: 'job-1', data: { request: stuck.id } });
  });

  it('a start that ends after its time limit leaves the request failed', async () => {
    let finish = (_: { container: string }): void => {};
    const s = setup({ startMs: 20, launch: () => new Promise((resolve) => { finish = resolve; }) });
    const r = s.requests.ask('job-1', T.name);
    s.requests.approve(r.id, 'Ada');
    await s.requests.idle();
    finish({ container: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.requests.list()[0]).toMatchObject({ state: 'failed' });
    expect(s.types().filter((t) => t === 'vault.sandbox_started')).toEqual([]);
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
    let n = 0;
    const requests = createSandboxRequests({
      record: (e) => events.push(e),
      approvals: () => approvals,
      template: (name) => templates.find((t) => t.name === name),
      launch: async () => ({ container: `box-${++n}` }),
      alive: () => true,
      atWork: () => true,
      clock: { now: () => new Date('2026-10-13T10:00:00Z') },
      newId: () => `r${events.length}`,
    });
    return { requests, events };
  }

  it('a low-radius run starts at once, by the auto-approve policy, an event that names it', async () => {
    const s = on([LOW]);
    expect(s.requests.ask('job-1', LOW.name)).toMatchObject({ state: 'starting', approvedBy: AUTO_APPROVER });
    await s.requests.idle();
    expect(s.events.find((e) => e.type === 'vault.sandbox_approved')!.data).toMatchObject({ by: AUTO_APPROVER, radius: 'low' });
  });

  it('a high-radius run waits by default; with high on, it starts', () => {
    expect(on([HIGH]).requests.ask('job-1', HIGH.name).state).toBe('waiting');
    expect(on([{ ...HIGH, approval: { by: 'skip template approval' } } as TemplateView]).requests.ask('job-1', HIGH.name).state).toBe('waiting');
    expect(on([HIGH], { ...NO_SKIPS, autoApprove: { low: true, medium: false, high: true } }).requests.ask('job-1', HIGH.name).state).toBe('starting');
  });

  it('a person who approved the template a job asked for approved its run for that job, not for another', () => {
    const t = { ...HIGH, askedBy: 'job-1', approval: { by: 'Ada' } } as unknown as TemplateView;
    const s = on([t]);
    expect(s.requests.ask('job-1', t.name)).toMatchObject({ state: 'starting', approvedBy: templateApprovalBy('Ada') });
    expect(s.requests.ask('job-2', t.name).state).toBe('waiting');
  });

  it('a job that waited on the template while a person approved it gets its run with that approval', () => {
    const t = { ...HIGH, askedBy: 'job-1', approval: { by: 'Ada' } } as unknown as TemplateView;
    const s = on([t]);
    s.requests.waited('job-3', t.name);
    expect(s.requests.ask('job-3', t.name)).toMatchObject({ state: 'starting', approvedBy: templateApprovalBy('Ada') });
  });
});
