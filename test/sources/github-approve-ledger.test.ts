// Approve resolved again reads the ledger (issue #1892, milestone 4): for an item the ledger knows, its state says whether
// it is a request card, not the end labels on its issue. A card the ledger holds with `hopper:done` left on (the label
// mirror takes it off) is approved; an item the ledger holds in another state is not shown, whatever its labels say. The
// labels decide only for an item the hopper does not know.
import { describe, expect, it } from 'vitest';
import { requestHash } from '../../src/domain/intake-origin.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { NOT_SHOWN } from '../../src/sources/github/intake-actions.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const card: Partial<WorkItem> = { state: 'waiting_for_approval', eventState: 'waiting_for_approval', waitingOn: 'an owner\'s approval of the request', requestSource: 'github' };
const dropped: Partial<WorkItem> = { state: 'dropped', eventState: 'dropped' };
const hash = requestHash({ title: 'Do it', body: 'Change the README.' });
const issue = (labels: string[]) => ({ repo: REPO, author: 'stranger', title: 'Do it', body: 'Change the README.', assignees: ['owner'], labels: ['hopper', ...labels] });

describe('Approve resolved again reads the ledger (issue #1892)', () => {
  it('a request card the ledger holds, with hopper:done left on: no sync since a restart, Approve approves it', async () => {
    const { gh, source } = setup({ [url(1)]: card }, { noJob: [url(1)] });
    gh.createIssue(issue(['hopper:done']));
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash })).toEqual({ done: [url(1)], failed: {} });
  });

  it('an item the ledger holds in another state is not shown, though its issue carries no end label', async () => {
    const { gh, source } = setup({ [url(1)]: dropped }, { noJob: [url(1)] });
    gh.createIssue(issue([]));
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash })).toEqual({ done: [], failed: { [url(1)]: NOT_SHOWN } });
  });

  it('an item the hopper does not know: hopper:done on its issue keeps it out, as before', async () => {
    const { gh, source } = setup({});
    gh.createIssue(issue(['hopper:done']));
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash })).toEqual({ done: [], failed: { [url(1)]: NOT_SHOWN } });
  });
});
