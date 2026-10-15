// A reopened issue re-enters Intake (issue #1126): an open issue with `hopper:done` whose job here ended is a request card,
// the reopened card, with its earlier jobs and pull request as history. Its source lists it as it lists every open labelled
// issue, so no GitHub delivery is needed. Approve takes `hopper:done` off and records the text, and the next sync takes it.
import { describe, expect, it } from 'vitest';
import { requestHash } from '../../src/domain/intake-origin.ts';
import type { IntakeContext } from '../../src/domain/intake.ts';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import { DONE_OPEN } from '../../src/sources/github/discover.ts';
import { AWAITS_BATCH, REOPENED_REASON } from '../../src/sources/github/origin.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const PR = `https://github.com/${REPO}/pull/9`;

function setup(o: { rerunnable?: string[]; awaitsBatch?: string[] } = {}) {
  const gh = createFakeGitHub();
  const trust = testTrust();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ended = new Set(o.rerunnable ?? [url(1)]);
  const intake: IntakeContext = {
    holder: 'a1b2c3d4e5f6',
    othersKnown: () => new Set(),
    migration: () => ({ at: '2026-10-08T09:00:00.000Z', changes: [] }),
    migrated: () => undefined,
    record: (type, data) => { events.push({ type, data }); },
    requestOpened: (key, hash) => events.some((e) => e.type === 'source.request_opened' && e.data.key === key && e.data.hash === hash),
    requestsWaiting: () => [],
    awaitsBatch: (key) => (o.awaitsBatch ?? []).includes(key),
    history: (key) => (ended.has(key) ? { jobs: [{ id: 'job-2', status: 'finished' }, { id: 'job-1', status: 'failed' }], pullRequest: PR } : undefined),
  };
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', config: githubConfig(), api: gh,
    clock: { now: () => new Date('2026-10-14T10:00:00.000Z') }, trust, intake,
    knownKeys: (keys) => new Set(keys.filter((k) => ended.has(k))),
    rerunnable: (keys) => new Set(keys.filter((k) => ended.has(k))),
  });
  return { gh, source, trust, events };
}

describe('a reopened issue re-enters Intake (issue #1126)', () => {
  it('an open issue with hopper:done whose job here ended is a request card with its history, and no job', async () => {
    const { gh, source, events } = setup();
    gh.createIssue({ repo: REPO, title: 'Fix it', body: 'It is still broken.', labels: ['hopper', 'hopper:done'] });
    expect(await source.discover()).toEqual([]);
    const [card] = source.intake!();
    expect(card).toMatchObject({ key: url(1), reason: REOPENED_REASON, action: 'approve', group: 'request' });
    expect(card!.request).toMatchObject({
      hash: requestHash({ title: 'Fix it', body: 'It is still broken.' }), title: 'Fix it', body: 'It is still broken.',
      reopened: { jobs: [{ id: 'job-2', status: 'finished' }, { id: 'job-1', status: 'failed' }], pullRequest: PR },
    });
    expect(events.filter((e) => e.type === 'source.request_opened').map((e) => e.data.key)).toEqual([url(1)]);
  });

  it('an issue whose pull request merged into the landing branch waits on its batch: no card, no job (issue #1175)', async () => {
    const { gh, source, events } = setup({ awaitsBatch: [url(1)] });
    gh.createIssue({ repo: REPO, title: 'Fix it', body: 'Fixed on main.', labels: ['hopper', 'hopper:done'] });
    expect(await source.discover()).toEqual([]);
    const [card] = source.intake!();
    expect(card).toMatchObject({ key: url(1), reason: AWAITS_BATCH, group: 'pr-waiting' });
    expect(card!.action).toBeUndefined();
    expect(card!.request).toBeUndefined();
    expect(events.filter((e) => e.type === 'source.request_opened')).toEqual([]);
  });

  it('an open issue with hopper:done and no job here stays done, with no action', async () => {
    const { gh, source } = setup({ rerunnable: [] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(source.intake!()[0]).toMatchObject({ key: url(1), reason: DONE_OPEN });
    expect(source.intake!()[0]!.action).toBeUndefined();
  });

  it('Approve takes hopper:done off and records the text; the next sync takes the issue', async () => {
    const { gh, source, trust } = setup();
    gh.createIssue({ repo: REPO, title: 'Fix it', body: 'It is still broken.', labels: ['hopper', 'hopper:done'] });
    await source.discover();
    const hash = source.intake!()[0]!.request!.hash;
    expect(await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash, acting: { person: 'owner', via: 'ui' } })).toEqual({ done: [url(1)], failed: {} });
    expect(trust.approvals.get(url(1))).toMatchObject({ text: { title: 'Fix it', body: 'It is still broken.' } });
    // The label goes after the answer (issue #1194); the next discover waits for it.
    const items = await source.discover();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(items.map((i) => [i.number, i.origin])).toEqual([[1, 'trusted']]);
  });

  it('Approve refuses a hash that is not of the reopened text shown, and leaves the label', async () => {
    const { gh, source, trust } = setup();
    gh.createIssue({ repo: REPO, body: 'It is still broken.', labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect((await source.intakeAction!({ kind: 'approve', keys: [url(1)], hash: 'f'.repeat(64) })).done).toEqual([]);
    await source.discover();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(trust.approvals.size).toBe(0);
  });
});
