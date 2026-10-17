// Request cards for GitLab issues (issue #1642, design.md "Request cards from GitLab"): a GitLab issue assigned to the account
// that is not of a trusted origin is a request card, as on GitHub (issue #652). A person approves its title and description, and
// the next sync takes it as a job of origin `approved`; an edit since makes it a card again. Decline keeps its text out until an
// edit. Nothing is written to GitLab. Over a fake GitLab on loopback, with the user's intake trust in memory.
//
// Feature: request cards from GitLab
//   Scenario: an issue another person wrote is a request card, with who did what; it opens once per text
//   Scenario: Approve takes the text shown: the next sync takes it as approved; another hash is refused
//   Scenario: an edit after the approval makes it a request card again, with the text approved before
//   Scenario: Decline keeps the text out, and offers nothing; Assign and a key not shown are refused
//   Scenario: a card no longer offered is withdrawn
import { afterEach, describe, expect, it } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import { createGitLabSource } from '../../src/gitlab/source.ts';
import { requestHash, type IntakeRequest } from '../../src/domain/intake-origin.ts';
import type { IntakeContext, IntakeTrust } from '../../src/domain/intake.ts';
import type { GitLabActorRef } from '../../src/domain/access.ts';
import { REQUEST_REASON, DECLINED_REASON } from '../../src/sources/github/origin.ts';
import { TEXT_CHANGED_SINCE_SHOWN } from '../../src/sources/github/intake-actions.ts';
import { createFakeGitLab, type FakeGitLabIssue } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const access = async (actor: GitLabActorRef, actors: readonly GitLabActorRef[]) => ({ allowed: actors.some((a) => a.baseUrl === actor.baseUrl && a.userId === actor.userId), reason: '' });

/** The user's intake trust as the user store keeps it: approvals as snapshots, declines and events. */
function memoryTrust() {
  const approved = new Map<string, { title: string; body: string }>();
  const declines: { key: string; hash: string }[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const trust: IntakeTrust = {
    trusted: async () => new Map(),
    approvedText: (key) => approved.get(key),
    approve: (source, key, text, request: IntakeRequest) => { approved.set(key, { title: text.title, body: text.body }); events.push({ type: 'source.request_approved', data: { source, key, hash: request.hash } }); },
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
    requestsWaiting: () => {
      const waiting = new Set<string>();
      for (const e of events) {
        const key = e.data.key as string;
        if (e.type === 'source.request_opened') waiting.add(key); else if (e.type.startsWith('source.request_')) waiting.delete(key);
      }
      return [...waiting];
    },
  };
  return { trust, intake, events, approved };
}

const BOBS: FakeGitLabIssue = { project: 'ada/tools', iid: 2, title: 'Add a flag', description: 'Please add --quiet.', author: 'bob', assignees: ['ada'], labels: ['hopper'], labelledBy: 'ada', assignedBy: 'ada' };

async function connected() {
  const gitlab = await createFakeGitLab({ issues: [structuredClone(BOBS)] });
  cleanups.push(() => gitlab.close());
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/tools'] });
  gitlab.ids.set('bob', 8);
  let kept: Parameters<Parameters<typeof createGitLabAccount>[0]['settings']['setGitLabAccount']>[0];
  const account = createGitLabAccount({
    settings: { getGitLabAccount: () => (kept ? structuredClone(kept) : undefined), setGitLabAccount: (r) => { kept = r ?? undefined; } },
    secrets: systemOf(memoryAccountStore().store), clock: { now: () => new Date() }, logger: { info: () => undefined, warn: () => undefined }, startsJobs: access,
  });
  const m = memoryTrust();
  const source = createGitLabSource({ name: 'gitlab-account', account, executor: 'herdr-claude', trust: m.trust, intake: m.intake });
  await account.connect({ token: 'glpat-ada', baseUrl: gitlab.url });
  account.choose(['ada/tools']);
  const key = `${gitlab.url}/ada/tools/-/issues/2`;
  return { gitlab, source, key, ...m };
}

const hashOf = (title: string, body: string) => requestHash({ title, body });

describe('request cards from GitLab', () => {
  it('offers an issue another person wrote as a request card, with who did what, opened once per text', async () => {
    const s = await connected();
    expect(await s.source.discover()).toEqual([]);
    const [card] = s.source.intake!();
    expect(card).toMatchObject({
      key: s.key, title: 'Add a flag', repo: 'ada/tools', reason: REQUEST_REASON, action: 'approve', group: 'request',
      request: {
        hash: hashOf('Add a flag', 'Please add --quiet.'), title: 'Add a flag', body: 'Please add --quiet.', author: 'bob',
        why: ['bob wrote it, and is not a trusted actor'],
      },
    });
    expect(card!.request!.actors).toEqual([
      { role: 'author', login: 'bob', id: 8, trusted: false },
      { role: 'labelled', login: 'ada', id: 7, trusted: true },
      { role: 'assigned', login: 'ada', id: 7, trusted: true },
    ]);
    await s.source.discover();
    expect(s.events.filter((e) => e.type === 'source.request_opened')).toEqual([
      { type: 'source.request_opened', data: { source: 'gitlab-account', key: s.key, hash: card!.request!.hash, author: 'bob', why: ['bob wrote it, and is not a trusted actor'] } },
    ]);
    expect(s.gitlab.requests.every((r) => r.method === undefined)).toBe(true); // nothing written to GitLab
  });

  it('takes the approved text at the next sync, as a job of origin approved; another hash is refused', async () => {
    const s = await connected();
    await s.source.discover();
    const hash = hashOf('Add a flag', 'Please add --quiet.');
    expect(await s.source.intakeAction!({ kind: 'approve', keys: [s.key], hash: 'f'.repeat(64) })).toEqual({ done: [], failed: { [s.key]: TEXT_CHANGED_SINCE_SHOWN } });
    expect(await s.source.intakeAction!({ kind: 'approve', keys: [s.key], hash })).toEqual({ done: [s.key], failed: {} });
    expect(s.approved.get(s.key)).toEqual({ title: 'Add a flag', body: 'Please add --quiet.' });
    expect(s.source.intake!()).toEqual([{ key: s.key, title: 'Add a flag', repo: 'ada/tools' }]); // taken at once in Intake
    const items = await s.source.discover();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: s.key, origin: 'approved', title: 'Add a flag', body: 'Please add --quiet.', author: 'bob' });
    expect(items[0]!.prompt).toContain('Please add --quiet.');
    expect(s.gitlab.requests.every((r) => r.method === undefined)).toBe(true);
  });

  it('is a request card again after an edit, with the text approved before', async () => {
    const s = await connected();
    await s.source.discover();
    await s.source.intakeAction!({ kind: 'approve', keys: [s.key], hash: hashOf('Add a flag', 'Please add --quiet.') });
    Object.assign(s.gitlab.issues[0]!, { description: 'Please add --quiet and --loud.', editedBy: ['bob'] });
    expect(await s.source.discover()).toEqual([]);
    const [card] = s.source.intake!();
    expect(card).toMatchObject({ action: 'approve', group: 'request', request: { body: 'Please add --quiet and --loud.', approved: { title: 'Add a flag', body: 'Please add --quiet.' } } });
    expect(card!.request!.why).toEqual(['bob wrote it, and is not a trusted actor', 'bob edited its title or description, and is not a trusted actor']);
  });

  it('keeps a declined text out and offers nothing; Assign and a key not shown are refused', async () => {
    const s = await connected();
    await s.source.discover();
    const hash = hashOf('Add a flag', 'Please add --quiet.');
    expect(await s.source.intakeAction!({ kind: 'decline', keys: [s.key], hash })).toEqual({ done: [s.key], failed: {} });
    await s.source.discover();
    expect(s.source.intake!()).toEqual([{ key: s.key, title: 'Add a flag', repo: 'ada/tools', reason: DECLINED_REASON, group: 'declined' }]);
    expect(await s.source.intakeAction!({ kind: 'approve', keys: [s.key], hash })).toEqual({ done: [], failed: { [s.key]: `not offered: ${DECLINED_REASON}` } });
    const other = `${s.gitlab.url}/ada/tools/-/issues/99`;
    expect((await s.source.intakeAction!({ kind: 'approve', keys: [other], hash })).failed[other]).toMatch(/not in this source's scope/);
    expect((await s.source.intakeAction!({ kind: 'assign', keys: [s.key] })).failed[s.key]).toMatch(/not offered on GitLab/);
    expect(s.gitlab.requests.every((r) => r.method === undefined)).toBe(true);
  });

  it('withdraws a card the sync no longer offers', async () => {
    const s = await connected();
    await s.source.discover();
    s.gitlab.issues[0]!.labels = [];
    await s.source.discover();
    expect(s.source.intake!()).toEqual([]);
    expect(s.events.filter((e) => e.type === 'source.request_withdrawn')).toEqual([{ type: 'source.request_withdrawn', data: { source: 'gitlab-account', key: s.key } }]);
  });
});
