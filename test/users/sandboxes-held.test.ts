// Issue #1471: at each Decision, the hopper asks for the sandbox runs of every template a waiting job's prompt names,
// before it starts, all at once, and holds the job until each is approved (or declined) and its template ready.
import { describe, expect, it } from 'vitest';
import { NO_SKIPS, type SandboxApprovals } from '../../src/domain/sandbox-approvals.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createSandboxRequests } from '../../src/sandbox/requests.ts';
import { BEFORE_START_PURPOSE, sandboxesHeld } from '../../src/users/sandbox-requests.ts';
import { job as waitingJob } from '../decider/support.ts';

const ready = (name: string): TemplateView => ({ name, profiles: [], approval: { by: 'Ada', at: 'now' }, pending: { profiles: [] } }) as unknown as TemplateView;
const templates = [ready('cluster-role-builder'), ready('web')];
const BRIEF = 'Mint the role. Work in a box of template `cluster-role-builder`: sh "$HOPPER_STEP" box cluster-role-builder --command "…"';

const job = (id: string, prompt: string | undefined, over: Partial<Job> = {}): Job => {
  const j = waitingJob(id, over);
  return { ...j, spec: { ...j.spec, payload: prompt === undefined ? {} : { prompt } } };
};

function setup(approvals: SandboxApprovals = NO_SKIPS) {
  const events: NewEvent[] = [];
  let n = 0;
  const requests = createSandboxRequests({
    record: (e) => events.push(e), approvals: () => approvals,
    template: (name) => templates.find((t) => t.name === name), live: () => true,
    clock: { now: () => new Date('2026-10-16T10:00:00Z') }, newId: () => `r${++n}`,
  });
  return { requests, events };
}

describe('sandboxes before the start (issue #1471)', () => {
  it('asks for every template the prompt names, once, and holds the job until a person approves them', () => {
    const s = setup();
    const waiting = [job('j1', `${BRIEF}\nThen check the web page in the box web.`), job('j2', 'Fix the web page.')];
    const reason = 'awaiting its sandboxes: the sandbox runs of template cluster-role-builder, web wait for a person on Access requests';
    expect(sandboxesHeld(s.requests, () => templates, waiting)).toEqual([{ jobId: 'j1', reason }]);
    expect(s.requests.list()).toMatchObject([
      { jobId: 'j1', template: 'cluster-role-builder', state: 'waiting', purpose: BEFORE_START_PURPOSE },
      { jobId: 'j1', template: 'web', state: 'waiting', purpose: BEFORE_START_PURPOSE },
    ]);
    // Asked at the next Decision too: the same requests, no new event.
    expect(sandboxesHeld(s.requests, () => templates, waiting)).toEqual([{ jobId: 'j1', reason }]);
    expect(s.events.map((e) => e.type)).toEqual(['vault.sandbox_requested', 'vault.sandbox_requested']);

    for (const r of s.requests.list()) s.requests.approve(r.id, 'Ada');
    expect(sandboxesHeld(s.requests, () => templates, waiting)).toEqual([]);
  });

  it('a declined request lets the job start: a person said no, and the job is told so when it asks', () => {
    const s = setup();
    const waiting = [job('j1', BRIEF)];
    sandboxesHeld(s.requests, () => templates, waiting);
    s.requests.decline(s.requests.list()[0]!.id, 'not for this job', 'Ada');
    expect(sandboxesHeld(s.requests, () => templates, waiting)).toEqual([]);
  });

  it('with skip sandbox approval on, the runs are approved at once and nothing holds the job', () => {
    const s = setup({ ...NO_SKIPS, skipSandboxApproval: true });
    expect(sandboxesHeld(s.requests, () => templates, [job('j1', BRIEF)])).toEqual([]);
    expect(s.requests.list()).toMatchObject([{ jobId: 'j1', template: 'cluster-role-builder', state: 'approved', approvedBy: 'skip sandbox approval' }]);
  });

  it('asks nothing for a job not accepted, of an origin or text not judged, resuming, or with no prompt; nor reads the templates', () => {
    const s = setup();
    let read = 0;
    const waiting = [
      job('gate', BRIEF, { accepted: false }), job('origin', BRIEF, { originPending: true }),
      job('text', BRIEF, { textChange: {} as Job['textChange'] }), job('resume', BRIEF, { pendingAnswer: 'yes' }), job('none', undefined),
    ];
    expect(sandboxesHeld(s.requests, () => { read++; return templates; }, waiting)).toEqual([]);
    expect(read).toBe(0);
    expect(s.requests.list()).toEqual([]);
  });
});
