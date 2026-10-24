// Won't do on a blocked item in Intake (issue #1891): an issue whose work item is blocked — no pull request to wait on, or
// its pull request closed without a merge — is offered Won't do. The act records `work_item.dropped` at once, and its
// label change goes through the GitHub outbox in one coalesced change: the blocked label off, `hopper:rejected` on, so
// no one edits `hopper:pr-closed` on GitHub. An item the ledger does not hold blocked is refused.
import { describe, expect, it, vi } from 'vitest';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

const NOW = '2026-10-18T12:00:00.000Z';
const LONG_AGO = '2026-10-18T10:00:00.000Z';
const HOLDER = 'a1b2c3d4e5f6';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const ACTING = { person: 'someone', via: 'ui' as const };

function setup(items: Record<string, Partial<WorkItem>>) {
  const gh = createFakeGitHub();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', whoami: 'owner', assignee: () => 'owner', config: githubConfig({}), api: gh,
    trust: testTrust(), clock: { now: () => new Date(NOW) }, knownKeys: (keys) => new Set(keys.filter((k) => items[k])),
    intake: {
      holder: HOLDER, othersKnown: () => new Set(), migration: () => ({ at: LONG_AGO, changes: [] }), migrated: () => {},
      record: (type, data) => { events.push({ type, data }); }, requestOpened: () => false, requestsWaiting: () => [],
      workItem: (key) => {
        const o = items[key];
        if (!o) return undefined;
        // The ledger as the store keeps it: a recorded Won't do drops the item.
        const gone = events.some((e) => e.type === 'work_item.dropped' && e.data.key === key);
        const state = gone ? 'dropped' : o.state ?? 'blocked';
        return { key, stateSince: LONG_AGO, eventAt: LONG_AGO, keptWork: [], version: 3, jobId: 'job-1', ...o, state, eventState: state };
      },
    },
  });
  const writes = () => gh.calls.filter((c) => c.method === 'addLabels' || c.method === 'removeLabels').map((c) => [c.method, c.args[2]]);
  return { gh, source, events, writes };
}

describe('Won\'t do on a blocked item (issue #1891)', () => {
  it('is offered on a blocked issue; it drops the item at once and changes its labels in one coalesced change', async () => {
    const { gh, source, events, writes } = setup({ [url(1)]: { blockedCause: 'pr_closed', closedWithoutMerge: 2 } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-closed', 'hopper:claimed', `hopper:held-by:${HOLDER}`] });
    await source.discover();
    expect(source.intake?.().find((x) => x.key === url(1))?.action).toBe('wont_do');
    const r = await source.intakeAction!({ kind: 'wont_do', keys: [url(1)], acting: ACTING });
    expect(r).toEqual({ done: [url(1)], failed: {} });
    expect(events).toEqual([{ type: 'work_item.dropped', data: { source: 'github', key: url(1), jobId: 'job-1', cause: 'pr_closed', by: ACTING } }]);
    expect(writes()).toEqual([]);
    expect(await source.flushOutbox!()).toEqual({ due: 2, wrote: [REPO] });
    expect(writes()).toEqual([['removeLabels', ['hopper:pr-closed', 'hopper:claimed', `hopper:held-by:${HOLDER}`]], ['addLabels', ['hopper:rejected']]]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:rejected']);
    expect(gh.issue(REPO, 1).state).toBe('open');
  });

  it('a second Won\'t do adds no event and no row', async () => {
    const { gh, source, events } = setup({ [url(1)]: { blockedCause: 'stale' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    await source.discover();
    await source.intakeAction!({ kind: 'wont_do', keys: [url(1)], acting: ACTING });
    const again = await source.intakeAction!({ kind: 'wont_do', keys: [url(1)], acting: ACTING });
    expect(again.done).toEqual([url(1)]);
    expect(events).toHaveLength(1);
    expect(await source.flushOutbox!()).toEqual({ due: 2, wrote: [REPO] });
  });

  it('is refused for an item the ledger does not hold blocked, whatever its labels say', async () => {
    const { gh, source, events } = setup({ [url(1)]: { state: 'pr_open', pullRequest: 'https://github.com/owner/sandbox/pull/9' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    await source.discover();
    const r = await source.intakeAction!({ kind: 'wont_do', keys: [url(1)], acting: ACTING });
    // Intake reads the ledger (issue #1892): PR open, so Won't do is not offered, whatever the labels say.
    expect(r.failed[url(1)]).toBe('not offered: done: its pull request waits for review');
    expect(events).toEqual([]);
    // Only the label mirror's correction of its PR open drift (issue #1933): Won't do wrote nothing.
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1)).toMatchObject({ state: 'open', labels: ['hopper', 'hopper:pr-ready'] });
  });
});
