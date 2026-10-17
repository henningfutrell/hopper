// Auto-approval of GitLab request cards (issue #1642, design.md "Auto-approval of GitLab cards"): as on GitHub (issue #1268), a
// card the user's own act already asks for is approved by the hopper, recorded as `source.request_auto_approved`, and taken at
// the next sync. On GitLab the rules are `author` (a trusted actor wrote it) and `high-label` (a trusted actor added
// `hopper:high`). Over a fake GitLab on loopback, with the user's intake trust in memory.
//
// Feature: auto-approval of GitLab request cards
//   Scenario: a card a trusted actor labelled hopper:high is approved by the hopper, and taken at the next sync
//   Scenario: an issue a trusted actor wrote, labelled by another, is approved by the hopper (author)
//   Scenario: a card waits for a person: no rule matches, the setting is off, another edited it, a person declined it, or its
//     text changed since a person approved it
import { afterEach, describe, expect, it } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import { createGitLabSource } from '../../src/gitlab/source.ts';
import { requestHash, type IntakeRequest } from '../../src/domain/intake-origin.ts';
import type { IntakeContext, IntakeTrust } from '../../src/domain/intake.ts';
import type { AutoApproval, IntakeAutoApproval } from '../../src/domain/intake-auto-approve.ts';
import type { GitLabActorRef } from '../../src/domain/access.ts';
import type { GitLabAccountRecord } from '../../src/domain/gitlab-account.ts';
import { REQUEST_REASON, DECLINED_REASON } from '../../src/sources/github/origin.ts';
import { createFakeGitLab, type FakeGitLabIssue } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const access = async (actor: GitLabActorRef, actors: readonly GitLabActorRef[]) => ({ allowed: actors.some((a) => a.baseUrl === actor.baseUrl && a.userId === actor.userId), reason: '' });

type Event = { type: string; data: Record<string, unknown> };

/** The user's intake trust as the user store keeps it, with the auto-approval setting. */
function memoryTrust(setting: IntakeAutoApproval) {
  const approved = new Map<string, { title: string; body: string }>();
  const declines: { key: string; hash: string }[] = [];
  const events: Event[] = [];
  const trust: IntakeTrust = {
    trusted: async () => new Map(),
    approvedText: (key) => approved.get(key),
    approve: (source, key, text, request: IntakeRequest) => { approved.set(key, { title: text.title, body: text.body }); events.push({ type: 'source.request_approved', data: { source, key, hash: request.hash } }); },
    autoApproval: () => setting,
    autoApprove: (source, key, text, request: IntakeRequest, a: AutoApproval) => {
      approved.set(key, { title: text.title, body: text.body });
      events.push({ type: 'source.request_auto_approved', data: { source, key, hash: request.hash, rule: a.rule, actor: a.actor } });
    },
    approvedComments: () => undefined,
    declined: (key, hash) => declines.some((d) => d.key === key && d.hash === hash),
    decline: (source, key, request) => { declines.push({ key, hash: request.hash }); events.push({ type: 'source.request_declined', data: { source, key, hash: request.hash } }); },
    assignedHere: () => false,
    originPending: () => false,
  };
  const intake: IntakeContext = {
    holder: 'h', othersKnown: () => new Set(), migration: () => undefined, migrated: () => undefined,
    record: (type, data) => { events.push({ type, data }); },
    requestOpened: (key, hash) => events.some((e) => e.type === 'source.request_opened' && e.data.key === key && e.data.hash === hash),
    requestsWaiting: () => [],
  };
  return { trust, intake, events, approved };
}

const BOBS: FakeGitLabIssue = { project: 'ada/tools', iid: 2, title: 'Add a flag', description: 'Please add --quiet.', author: 'bob', assignees: ['ada'], labels: ['hopper'], labelledBy: 'ada', assignedBy: 'ada' };

async function connected(issue: Partial<FakeGitLabIssue> = {}, setting: IntakeAutoApproval = { on: true, apps: [] }) {
  const gitlab = await createFakeGitLab({ issues: [{ ...structuredClone(BOBS), ...issue }] });
  cleanups.push(() => gitlab.close());
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/tools'] });
  gitlab.ids.set('bob', 8);
  let kept: GitLabAccountRecord | undefined;
  const account = createGitLabAccount({
    settings: { getGitLabAccount: () => (kept ? structuredClone(kept) : undefined), setGitLabAccount: (r) => { kept = r ?? undefined; } },
    secrets: systemOf(memoryAccountStore().store), clock: { now: () => new Date() }, logger: { info: () => undefined, warn: () => undefined }, startsJobs: access,
  });
  const m = memoryTrust(setting);
  const source = createGitLabSource({ name: 'gitlab-account', account, executor: 'herdr-claude', trust: m.trust, intake: m.intake });
  await account.connect({ token: 'glpat-ada', baseUrl: gitlab.url });
  account.choose(['ada/tools']);
  const key = `${gitlab.url}/ada/tools/-/issues/2`;
  return { gitlab, source, key, ...m };
}

const HASH = requestHash({ title: 'Add a flag', body: 'Please add --quiet.' });
const autos = (events: Event[]) => events.filter((e) => e.type === 'source.request_auto_approved');

describe('auto-approval of GitLab request cards', () => {
  it('approves a card a trusted actor labelled hopper:high, and takes it at the next sync', async () => {
    const s = await connected({ labels: ['hopper', 'hopper:high'], highBy: 'ada' });
    expect(await s.source.discover()).toEqual([]);
    expect(s.source.intake!()).toEqual([
      { key: s.key, title: 'Add a flag', repo: 'ada/tools', reason: 'approved by the hopper: labelled hopper:high by ada; taken at the next sync', group: 'other' },
    ]);
    expect(autos(s.events)).toEqual([{ type: 'source.request_auto_approved', data: { source: 'gitlab-account', key: s.key, hash: HASH, rule: 'high-label', actor: 'ada' } }]);
    expect(s.events.filter((e) => e.type === 'source.request_opened')).toEqual([]);
    const items = await s.source.discover();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: s.key, origin: 'approved', body: 'Please add --quiet.' });
    expect(autos(s.events)).toHaveLength(1);
    expect(s.gitlab.requests.every((r) => r.method === undefined)).toBe(true); // nothing written to GitLab
  });

  it('approves an issue a trusted actor wrote, whoever labelled it (author)', async () => {
    const s = await connected({ author: 'ada', labelledBy: 'bob' });
    await s.source.discover();
    expect(autos(s.events).map((e) => e.data)).toEqual([{ source: 'gitlab-account', key: s.key, hash: HASH, rule: 'author', actor: 'ada' }]);
    expect((await s.source.discover())[0]).toMatchObject({ key: s.key, origin: 'approved' });
  });

  it('keeps a card waiting when no rule matches: another wrote it, or another added hopper:high', async () => {
    for (const issue of [{}, { labels: ['hopper', 'hopper:high'], highBy: 'bob' }]) {
      const s = await connected(issue);
      await s.source.discover();
      expect(s.source.intake!()[0]).toMatchObject({ reason: REQUEST_REASON, action: 'approve', group: 'request' });
      expect(autos(s.events)).toEqual([]);
    }
  });

  it('keeps a card waiting when the setting is off', async () => {
    const s = await connected({ labels: ['hopper', 'hopper:high'], highBy: 'ada' }, { on: false, apps: [] });
    await s.source.discover();
    expect(s.source.intake!()[0]).toMatchObject({ action: 'approve', group: 'request' });
    expect(autos(s.events)).toEqual([]);
  });

  it('keeps a card waiting when someone who is no trusted actor edited its text', async () => {
    const s = await connected({ author: 'ada', editedBy: ['bob'] });
    await s.source.discover();
    expect(s.source.intake!()[0]).toMatchObject({ action: 'approve', group: 'request' });
    expect(autos(s.events)).toEqual([]);
  });

  it('keeps a declined text declined', async () => {
    const s = await connected();
    await s.source.discover();
    await s.source.intakeAction!({ kind: 'decline', keys: [s.key], hash: HASH });
    Object.assign(s.gitlab.issues[0]!, { labels: ['hopper', 'hopper:high'], highBy: 'ada' });
    await s.source.discover();
    expect(s.source.intake!()[0]).toMatchObject({ reason: DECLINED_REASON, group: 'declined' });
    expect(autos(s.events)).toEqual([]);
  });

  it('keeps a card waiting when its text changed since a person approved it', async () => {
    const s = await connected();
    await s.source.discover();
    await s.source.intakeAction!({ kind: 'approve', keys: [s.key], hash: HASH });
    Object.assign(s.gitlab.issues[0]!, { description: 'Please add --quiet and --loud.', labels: ['hopper', 'hopper:high'], highBy: 'ada' });
    await s.source.discover();
    expect(s.source.intake!()[0]).toMatchObject({ action: 'approve', group: 'request', request: { approved: { body: 'Please add --quiet.' } } });
    expect(autos(s.events)).toEqual([]);
  });
});
