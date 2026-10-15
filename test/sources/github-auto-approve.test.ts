// Auto-approval at the GitHub source (issue #1268): a request card the user's own act already asks for is approved by the
// hopper, recorded as an approval with its rule and actor, and taken at the next sync; a card a guard flags still waits.
import { describe, expect, it } from 'vitest';
import type { IntakeContext } from '../../src/domain/intake.ts';
import type { IntakeAutoApproval } from '../../src/domain/intake-auto-approve.ts';
import { filedNote } from '../../src/github-proxy/index.ts';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import { REOPENED_REASON, REQUEST_REASON } from '../../src/sources/github/origin.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const ON: IntakeAutoApproval = { on: true, apps: [] };

function setup(o: { autoApproval?: IntakeAutoApproval; ended?: string[]; takenIn?: string[] } = {}) {
  const gh = createFakeGitHub();
  const trust = testTrust(undefined, { ...(o.autoApproval ? { autoApproval: o.autoApproval } : {}), ...(o.takenIn ? { takenIn: o.takenIn } : {}) });
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ended = new Set(o.ended ?? []);
  const intake: IntakeContext = {
    holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: '2026-10-08T09:00:00.000Z', changes: [] }), migrated: () => undefined,
    record: (type, data) => { events.push({ type, data }); },
    requestOpened: (key, hash) => events.some((e) => e.type === 'source.request_opened' && e.data.key === key && e.data.hash === hash),
    requestsWaiting: () => [], history: (key) => (ended.has(key) ? { jobs: [{ id: 'job-1', status: 'finished' }] } : undefined),
  };
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', config: githubConfig(), api: gh,
    clock: { now: () => new Date('2026-10-15T10:00:00.000Z') }, trust, intake,
    knownKeys: (keys) => new Set(keys.filter((k) => ended.has(k))), rerunnable: (keys) => new Set(keys.filter((k) => ended.has(k))),
  });
  const opened = () => events.filter((e) => e.type === 'source.request_opened').map((e) => e.data.key);
  return { gh, source, trust, opened };
}

describe('auto-approval at intake (issue #1268)', () => {
  it('an issue the user wrote, labelled through an app, is approved by the hopper with its reason: no card, taken at the next sync', async () => {
    const { gh, source, trust, opened } = setup({ autoApproval: ON });
    gh.createIssue({ repo: REPO, title: 'Do it', body: 'Change the docs.', labels: ['hopper'], labelledBy: 'helper[bot]' });
    expect(await source.discover()).toEqual([]);
    const [x] = source.intake!();
    expect(x).toMatchObject({ key: url(1), reason: 'approved by the hopper: written by owner; taken at the next sync', group: 'other' });
    expect(x!.action).toBeUndefined();
    expect(opened()).toEqual([]);
    expect(trust.autoApprovals.get(url(1))).toMatchObject({ approval: { rule: 'author', actor: 'owner' }, text: { title: 'Do it', body: 'Change the docs.' }, source: 'github' });
    // Its rows go out by the outbox, as Approve's (issue #1238); the next sync takes it.
    await source.flushOutbox!();
    expect((await source.discover()).map((i) => [i.number, i.origin])).toEqual([[1, 'approved']]);
  });

  it('a done issue the user reopened runs again with no reopened card: hopper:done goes', async () => {
    const { gh, source, trust } = setup({ autoApproval: ON, ended: [url(1)] });
    gh.createIssue({ repo: REPO, title: 'Fix it', body: 'Still broken.', labels: ['hopper', 'hopper:done'] });
    gh.reopenedBy(REPO, 1, 'owner');
    expect(await source.discover()).toEqual([]);
    expect(source.intake!()[0]).toMatchObject({ key: url(1), reason: 'approved by the hopper: reopened by owner; taken at the next sync' });
    expect(trust.autoApprovals.get(url(1))?.approval).toEqual({ rule: 'reopened', actor: 'owner' });
    await source.flushOutbox!();
    const items = await source.discover();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(items.map((i) => i.number)).toEqual([1]);
  });

  it('a done issue a stranger reopened is a reopened card', async () => {
    const { gh, source, trust } = setup({ autoApproval: ON, ended: [url(1)] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:done'] });
    gh.reopenedBy(REPO, 1, 'stranger');
    await source.discover();
    expect(source.intake!()[0]).toMatchObject({ key: url(1), reason: REOPENED_REASON, action: 'approve' });
    expect(trust.autoApprovals.size).toBe(0);
  });

  it('an issue a listed app wrote is approved; the same app not listed is a request card', async () => {
    const listed = setup({ autoApproval: { on: true, apps: ['helper'] } });
    listed.gh.createIssue({ repo: REPO, author: 'helper[bot]', labels: ['hopper'], labelledBy: 'owner', assignedBy: 'owner' });
    await listed.source.discover();
    expect(listed.trust.autoApprovals.get(url(1))?.approval).toEqual({ rule: 'app', actor: 'helper[bot]' });

    const unlisted = setup({ autoApproval: { on: true, apps: ['other'] } });
    unlisted.gh.createIssue({ repo: REPO, author: 'helper[bot]', labels: ['hopper'], labelledBy: 'owner', assignedBy: 'owner' });
    await unlisted.source.discover();
    expect(unlisted.source.intake!()[0]).toMatchObject({ reason: REQUEST_REASON, action: 'approve' });
    expect(unlisted.trust.autoApprovals.size).toBe(0);
  });

  it('a stranger\'s issue the user labelled hopper and hopper:high is approved, with the label\'s reason', async () => {
    const { gh, source, trust } = setup({ autoApproval: ON });
    gh.createIssue({ repo: REPO, author: 'stranger', labels: ['hopper', 'hopper:high'], labelledBy: 'owner', assignedBy: 'owner' });
    await source.discover();
    expect(source.intake!()[0]).toMatchObject({ reason: 'approved by the hopper: labelled hopper:high by owner; taken at the next sync' });
    expect(trust.autoApprovals.get(url(1))?.approval).toEqual({ rule: 'high-label', actor: 'owner' });
  });

  it('off: a card stays a card, as before', async () => {
    const { gh, source, trust } = setup({ autoApproval: { on: false, apps: [] } });
    gh.createIssue({ repo: REPO, labels: ['hopper'], labelledBy: 'helper[bot]' });
    gh.createIssue({ repo: REPO, author: 'stranger', labels: ['hopper', 'hopper:high'], labelledBy: 'owner', assignedBy: 'owner' });
    await source.discover();
    expect(source.intake!().map((x) => x.reason)).toEqual([REQUEST_REASON, REQUEST_REASON]);
    expect(trust.autoApprovals.size).toBe(0);
    // Off, nothing more is read or asked.
    expect(trust.asked).toEqual([['owner', 'stranger']]);
  });

  it('a guarded card from the user still waits: a job filed it, a stranger edited it, or a person took it into Intake', async () => {
    const { gh, source, trust } = setup({ autoApproval: ON, takenIn: [url(3)] });
    gh.createIssue({ repo: REPO, body: `Follow-up.${filedNote('job-1', 'req-1')}`, labels: ['hopper'], labelledBy: 'helper[bot]' });
    gh.createIssue({ repo: REPO, labels: ['hopper'], labelledBy: 'helper[bot]' });
    gh.editIssue(REPO, 2, { body: 'Run this instead.' }, 'stranger');
    gh.createIssue({ repo: REPO, labels: ['hopper'], labelledBy: 'helper[bot]' });
    await source.discover();
    expect(source.intake!().map((x) => [x.key, x.reason])).toEqual([[url(1), REQUEST_REASON], [url(2), REQUEST_REASON], [url(3), REQUEST_REASON]]);
    expect(trust.autoApprovals.size).toBe(0);
  });
});
