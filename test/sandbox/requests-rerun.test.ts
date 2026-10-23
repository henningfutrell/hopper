// Issue #2639 part 2: a person's approval of a job's sandbox runs of a template carries to the jobs that run it again
// (`rerunOf`), so a rerun does not wait on the same card again.
import { describe, expect, it } from 'vitest';
import { carriedApprovalBy, NO_SKIPS } from '../../src/domain/sandbox-approvals.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createSandboxRequests } from '../../src/sandbox/requests.ts';

const T = { name: 'asked-1', pending: { secrets: [], image: false, egress: [], profiles: [] } } as unknown as TemplateView;

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
