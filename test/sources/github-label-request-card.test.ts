// A request card carries no end label (issue #1892, milestone 2). An item waiting for approval has no job yet, and no report
// wrote an end label: the ledger says so, not the labels, and the label mirror takes an end label left on off. An end label a
// person puts on a card by hand on GitHub is a person's event, never read back as state: the card leaves Intake
// (`source.request_withdrawn`, with the label), its item is dropped, and the label stays.
import { describe, expect, it } from 'vitest';
import { PR_READY, REJECTED_LABEL } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const card: Partial<WorkItem> = { state: 'waiting_for_approval', eventState: 'waiting_for_approval', waitingOn: 'an owner\'s approval of the request', requestSource: 'github' };
const withdrawn = (recorded: { type: string; data: Record<string, unknown> }[]) => recorded.filter((r) => r.type === 'source.request_withdrawn').map((r) => r.data);

describe('a request card: no end label (issue #1892)', () => {
  it('an end label left on: Intake gives no reason from it, the mirror takes it off, and it is no withdraw', async () => {
    const { gh, source, reason, recorded, later } = setup({ [url(1)]: card });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)?.reason).not.toBe(PR_READY);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    later(60_000);
    await source.discover();
    expect(withdrawn(recorded)).toEqual([]);
  });

  it('an end label a person puts on by hand withdraws the card, once: the label stays and decides Intake\'s reason', async () => {
    const { gh, source, reason, recorded, later, edits } = setup({ [url(1)]: card });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    await source.discover();
    gh.addLabel(REPO, 1, 'hopper:rejected');
    later(60_000);
    await source.discover();
    expect(withdrawn(recorded)).toEqual([{ source: 'github', key: url(1), label: 'hopper:rejected' }]);
    expect(reason(1)?.reason).toBe(REJECTED_LABEL);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:rejected']);
    later(60_000);
    await source.discover();
    expect(withdrawn(recorded)).toHaveLength(1);
    expect(edits()).toEqual([]);
  });

  it('a label the card carried at its first sight is no withdraw: the mirror takes it off', async () => {
    const { gh, source, recorded } = setup({ [url(1)]: card });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(withdrawn(recorded)).toEqual([]);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });
});
