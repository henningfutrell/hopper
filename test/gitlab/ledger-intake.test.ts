// GitLab's Intake reads the ledger (issue #1892 part 29, design.md "GitLab's Intake reads the ledger"), as GitHub's does: an
// issue whose work item is in a state the label mirror judges gets the ledger's reason, whatever end labels it carries, and
// the mirror corrects them through the outbox. An end label a person takes off at GitLab is their Run again. The labels decide
// only for an issue the hopper does not know, or a state not judged. Over a fake GitLab on loopback.
//
// Feature: GitLab's Intake reads the ledger
//   Scenario: an item in PR open whose label was lost is not taken, and gets hopper:pr-ready back
//   Scenario: an end label taken off by hand is a Run again, and the issue is taken
//   Scenario: a done item whose report found no merge request yet keeps hopper:pr-ready, as the report put it on
//   Scenario: a failed item the hopper fixes itself loses a stale hopper:failed, and gets no end-label reason
//   Scenario: a failed item whose report waits loses a stale end label, and gets the failed reason
//   Scenario: a hopper that does not hold the mirror's lease writes and records nothing
//   Scenario: an issue the hopper does not know is judged by its labels
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import { createGitLabSource } from '../../src/gitlab/source.ts';
import { FAILED, PR_READY } from '../../src/sources/github/discover.ts';
import type { GitLabAccountRecord } from '../../src/domain/gitlab-account.ts';
import type { GitLabActorRef } from '../../src/domain/access.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import type { DoneReport } from '../../src/sources/github/item-labels.ts';
import { createFakeGitLab, type FakeGitLabIssue } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); vi.restoreAllMocks(); });

const LONG_AGO = '2026-10-18T10:00:00.000Z';
const access = async (actor: GitLabActorRef, actors: readonly GitLabActorRef[]) => ({ allowed: actors.some((a) => a.baseUrl === actor.baseUrl && a.userId === actor.userId), reason: '' });
const ISSUE: FakeGitLabIssue = { project: 'ada/tools', iid: 1, title: 'Fix the parser', description: 'It drops the last line.', author: 'ada', assignees: ['ada'], labels: ['hopper'] };

async function setup(o: { labels: string[]; item?: Partial<WorkItem>; reported?: boolean; fixing?: boolean; waits?: boolean; doneReported?: DoneReport; held?: boolean }) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const gitlab = await createFakeGitLab({ issues: [{ ...ISSUE, labels: o.labels }] });
  cleanups.push(() => gitlab.close());
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/tools'] });
  let kept: GitLabAccountRecord | undefined;
  const account = createGitLabAccount({
    settings: { getGitLabAccount: () => (kept ? structuredClone(kept) : undefined), setGitLabAccount: (r) => { kept = r ?? undefined; } },
    secrets: systemOf(memoryAccountStore().store), clock: { now: () => new Date() }, logger: { info: () => undefined, warn: () => undefined }, startsJobs: access,
  });
  await account.connect({ token: 'glpat-ada', baseUrl: gitlab.url });
  account.choose(['ada/tools']);
  const key = `${gitlab.url}/ada/tools/-/issues/1`;
  let item: WorkItem | undefined = o.item ? { key, state: 'blocked', stateSince: LONG_AGO, eventState: o.item.state ?? 'blocked', eventAt: LONG_AGO, keptWork: [], version: 3, ...o.item } : undefined;
  const recorded: { type: string; data: Record<string, unknown> }[] = [];
  const source = createGitLabSource({
    name: 'gitlab-account', account, clock: { now: () => new Date('2026-10-18T12:00:00.000Z') },
    knownKeys: (keys) => new Set(keys.filter((k) => k === key && item !== undefined)), rerunnable: () => new Set(),
    intake: {
      holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: LONG_AGO, changes: [] }), migrated: () => {},
      // The ledger folds the person's Run again into the item.
      record: (type, data) => { recorded.push({ type, data }); if (type === 'work_item.label_edited' && item) item = { ...item, runAgainAsked: String(data.label) }; },
      requestOpened: () => false, requestsWaiting: () => [],
      workItem: (k) => (k === key ? item : undefined),
      failureReported: () => o.reported ?? false,
      fixingReported: () => o.fixing ?? false,
      failureReportWaits: () => o.waits ?? false,
      doneReported: () => o.doneReported,
      ...(o.held === false ? { mirrorHeld: () => false } : {}),
    },
  });
  const outcome = () => source.intake!().find((x) => x.key === key);
  const labels = () => gitlab.issues[0]!.labels;
  return { gitlab, source, key, outcome, labels, recorded };
}

describe('GitLab\'s Intake reads the ledger', () => {
  it('does not take an item in PR open whose label was lost, and puts hopper:pr-ready back', async () => {
    const s = await setup({ labels: ['hopper'], item: { state: 'pr_open' } });
    expect((await s.source.discover()).map((i) => i.key)).toEqual([]);
    expect(s.outcome()).toMatchObject({ reason: PR_READY, group: 'pr-waiting' });
    await s.source.flushOutbox!();
    expect(s.labels()).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('takes a stale hopper:failed off a failed item the hopper fixes itself (issue #1892 part 31), and gives it no end-label reason', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:failed'], item: { state: 'failed', jobId: 'job-1' }, fixing: true });
    await s.source.discover();
    expect(s.outcome()?.reason).toBeUndefined();
    await s.source.flushOutbox!();
    expect(s.labels()).toEqual(['hopper']);
    expect(s.recorded).toEqual([]);
  });

  it('takes a stale end label off a failed item whose report waits (issue #1892 part 32), and gives it the failed reason', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:pr-ready'], item: { state: 'failed', jobId: 'job-1' }, waits: true });
    await s.source.discover();
    expect(s.outcome()?.reason).toBe(FAILED);
    await s.source.flushOutbox!();
    expect(s.labels()).toEqual(['hopper']);
    expect(s.recorded).toEqual([]);
  });

  it('takes an end label taken off by hand as a Run again, and takes the issue', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:failed'], item: { state: 'failed' }, reported: true });
    expect(await s.source.discover()).toEqual([]);
    s.gitlab.issues[0]!.labels = ['hopper'];
    expect((await s.source.discover()).map((i) => i.key)).toEqual([s.key]);
    expect(s.recorded).toEqual([{ type: 'work_item.label_edited', data: { source: 'gitlab-account', key: s.key, from: 'failed', label: 'hopper:failed', means: 'run_again' } }]);
    await s.source.flushOutbox!();
    expect(s.labels()).toEqual(['hopper']);
  });

  it('keeps hopper:pr-ready on a done item whose report found no merge request yet', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:pr-ready'], item: { state: 'done', eventState: 'done' }, doneReported: 'no_pr' });
    await s.source.discover();
    expect(s.outcome()).toMatchObject({ reason: PR_READY });
    expect(await s.source.flushOutbox!()).toMatchObject({ due: 0 });
    expect(s.labels()).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('writes and records nothing on a hopper that does not hold the mirror\'s lease', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:failed'], item: { state: 'pr_open' }, held: false });
    await s.source.discover();
    s.gitlab.issues[0]!.labels = ['hopper', 'hopper:done'];
    await s.source.discover();
    expect(s.outcome()).toMatchObject({ reason: PR_READY });
    expect(await s.source.flushOutbox!()).toMatchObject({ due: 0 });
    expect(s.recorded).toEqual([]);
  });

  it('judges an issue the hopper does not know by its labels', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:failed'] });
    expect(await s.source.discover()).toEqual([]);
    expect(s.outcome()?.reason).toMatch(/labelled hopper:failed/);
  });
});
