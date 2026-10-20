// Issue #2197 part 2: each new run card is one `vault.run_card_opened` on the job's timeline, which the notifiers send:
// when a run waits for a person, or a job's ask waits on a template for a person. Once per job and template; none for a
// run approved with no person, or an ask of a template that waits for no person.
import { describe, expect, it } from 'vitest';
import { NO_SKIPS, type SandboxApprovals } from '../../src/domain/sandbox-approvals.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createSandboxRequests } from '../../src/sandbox/requests.ts';

const NONE_PENDING = { secrets: [], image: false, egress: [], profiles: [] };
const T = { name: 'asked-1', pending: NONE_PENDING } as unknown as TemplateView;
/** Approved, nothing new waits: an ask waits on it only for its read-only check. */
const READY = { name: 'asked-ready', approval: { by: 'Ada' }, pending: NONE_PENDING } as unknown as TemplateView;

function setup(o: { approvals?: SandboxApprovals } = {}) {
  const events: NewEvent[] = [];
  const requests = createSandboxRequests({
    record: (e) => events.push(e),
    approvals: () => o.approvals ?? NO_SKIPS,
    template: (name) => [T, READY].find((t) => t.name === name),
    live: () => true,
    clock: { now: () => new Date('2026-10-19T10:00:00Z') },
    newId: () => `r${events.length}`,
  });
  return { requests, events };
}

describe('a notice per new run card (issue #2197)', () => {
  const opened = (s: ReturnType<typeof setup>) => s.events.filter((e) => e.type === 'vault.run_card_opened');

  it('a run that waits for a person opens one card: one event, on the job\'s timeline, with why the job asks', () => {
    const s = setup();
    s.requests.waited('job-1', T.name, { purpose: 'Rotate the key' });
    s.requests.ask('job-1', T.name, { purpose: 'Rotate the key' });
    s.requests.waited('job-1', T.name);
    expect(opened(s)).toEqual([{ type: 'vault.run_card_opened', jobId: 'job-1', data: { template: T.name, waits: { template: true, run: false }, purpose: 'Rotate the key' } }]);
    s.requests.ask('job-2', T.name);
    expect(opened(s).map((e) => [e.jobId, e.data])).toEqual([
      ['job-1', expect.anything()],
      ['job-2', { template: T.name, waits: { template: true, run: true } }],
    ]);
  });

  it('a run approved with no person, and an ask of a template that waits for no person, open no card', () => {
    const s = setup({ approvals: { skipTemplateApproval: false, skipSandboxApproval: true } });
    s.requests.ask('job-1', T.name);
    expect(opened(s)).toEqual([]);
    const ready = setup();
    ready.requests.waited('job-1', READY.name);
    ready.requests.waited('job-2', 'no-such-template');
    expect(opened(ready)).toEqual([]);
  });
});
