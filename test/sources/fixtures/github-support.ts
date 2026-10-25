// Shared helpers for the GitHub source tests: a configured source over the in-memory fake,
// and Job literals shaped like the ones the engine hands a source.

import type { Job, JobStatus } from '../../../src/domain/types.ts';
import type { JobSource, SourceItem } from '../../../src/domain/ports.ts';
import type { IntakeTrust } from '../../../src/domain/intake.ts';
import type { ItemText } from '../../../src/domain/item-snapshots.ts';
import type { IntakeRequest } from '../../../src/domain/intake-origin.ts';
import type { AutoApproval, IntakeAutoApproval } from '../../../src/domain/intake-auto-approve.ts';
import type { DeclineChoice, IntakeDeclineDefaults } from '../../../src/domain/intake-decline.ts';
import githubAccount from '../../../src/plugins/job-source/github-account/index.ts';
import { parseOptions } from '../../../src/plugins/options.ts';
import { sourceConfig, type GitHubAccountOptions, type GitHubSourceConfig } from '../../../src/sources/config.ts';
import { createFakeGitHub, createGitHubSource } from '../../../src/sources/github/index.ts';
import type { FakeGitHub, GitHubSourceOptions } from '../../../src/sources/github/index.ts';

export const REPO = 'owner/sandbox';

/** The source logic's config: the account source's options, and `repos` — the job repositories (default REPO). */
export function githubConfig(over: Record<string, unknown> = {}): GitHubSourceConfig {
  const { repos = [REPO], ...options } = over as { repos?: string[] } & Record<string, unknown>;
  const r = parseOptions(githubAccount, options);
  if (!r.ok) throw new Error(r.error);
  const { enabled: _e, ...shared } = r.options as GitHubAccountOptions;
  return { ...sourceConfig(shared), repos };
}

/** A test's intake trust (issue #652): `logins` (default: the connected login) are trusted actors; approvals kept in memory. */
export interface TestTrust extends IntakeTrust {
  approvals: Map<string, { text: ItemText; request: IntakeRequest; source: string }>;
  /** The request cards a person declined (issue #1035), by key: the text's request as declined. */
  declines: Map<string, { request: IntakeRequest; source: string; choice?: DeclineChoice }>;
  /** Every set of logins asked, in order. */
  asked: string[][];
  /** Every set of acts asked, with their GitHub user ids (issue #930), in order. */
  askedActs: { login: string; id?: number }[][];
  /** The hopper's approvals (issue #1268), by key: the rule and actor, and the text. */
  autoApprovals: Map<string, { approval: AutoApproval; text: ItemText; request: IntakeRequest; source: string }>;
}

/** `autoApproval` (issue #1268): the user's setting; absent: the trust has none, so no card is approved by the hopper. */
export function testTrust(logins?: string[], o: { assignedHere?: string[] | ((key: string) => boolean); pending?: string[]; autoApproval?: IntakeAutoApproval; takenIn?: string[]; declineDefaults?: IntakeDeclineDefaults } = {}): TestTrust {
  const approvals: TestTrust['approvals'] = new Map();
  const declines: TestTrust['declines'] = new Map();
  const asked: string[][] = [];
  const askedActs: { login: string; id?: number }[][] = [];
  const autoApprovals: TestTrust['autoApprovals'] = new Map();
  const auto = o.autoApproval;
  return {
    approvals, declines, asked, askedActs, autoApprovals,
    ...(auto ? {
      autoApproval: () => auto,
      takenIn: (key: string) => (o.takenIn ?? []).includes(key),
      autoApprove: (source: string, key: string, text: ItemText, request: IntakeRequest, approval: AutoApproval) => {
        autoApprovals.set(key, { approval, text, request, source });
        approvals.set(key, { text, request, source });
      },
    } : {}),
    async trusted(acts, connected) {
      const ls = acts.map((a) => a.login);
      asked.push(ls);
      askedActs.push(acts.map((a) => ({ ...a })));
      const actors = (logins ?? [connected]).map((l) => l.toLowerCase());
      return new Map(ls.map((l) => [l.toLowerCase(), { allowed: actors.includes(l.toLowerCase()), reason: 'test' }]));
    },
    approvedText: (key) => { const a = approvals.get(key); return a && { title: a.text.title, body: a.text.body }; },
    approve: (source, key, text, request) => { approvals.set(key, { text, request, source }); },
    approvedComments: (key, comments) => { const a = approvals.get(key); if (a) a.text = { ...a.text, comments }; },
    declined: (key, hash) => declines.get(key)?.request.hash === hash,
    decline: (source, key, request, _acting, choice) => { declines.set(key, { request, source, ...(choice ? { choice } : {}) }); },
    ...(o.declineDefaults ? { declineDefaults: () => o.declineDefaults! } : {}),
    assignedHere: (key) => (typeof o.assignedHere === 'function' ? o.assignedHere(key) : (o.assignedHere ?? []).includes(key)),
    originPending: (key) => (o.pending ?? []).includes(key),
  };
}

export function setup(over: Record<string, unknown> = {}, o: Partial<Pick<GitHubSourceOptions, 'knownKeys' | 'rerunnable' | 'rejections' | 'whoami' | 'yoloMode' | 'landingBranch' | 'changeRule' | 'jobArtifacts' | 'trust' | 'doneCriteria' | 'allowedDeletes' | 'openedPullRequests' | 'needsMerge' | 'deliveryHold'>> = {}) {
  const gh = createFakeGitHub();
  const config = githubConfig(over);
  const clock = { now: () => new Date('2026-10-02T10:00:00.000Z') };
  const source = createGitHubSource({ name: 'github', kind: 'github-account', whoami: 'owner', assignee: () => 'owner', config, api: gh, clock, trust: testTrust(), ...o });
  return { gh, config, source };
}

export async function discoverOne(source: JobSource): Promise<SourceItem> {
  const items = await source.discover();
  expect1(items.length === 1, `expected one item, got ${items.length}`);
  return items[0]!;
}

function expect1(ok: boolean, msg: string): void {
  if (!ok) throw new Error(msg);
}

let seq = 0;

export function jobFor(item: Pick<SourceItem, 'key' | 'url' | 'repo' | 'number' | 'author' | 'title'>, over: Partial<Job> = {}, source = 'github'): Job {
  seq += 1;
  return {
    id: `job-${seq}`,
    spec: { executor: 'herdr-claude', payload: { prompt: 'p', cwd: '/work/default' }, goal: item.title },
    priority: 50,
    status: 'running' as JobStatus,
    approved: false,
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    attempts: 1,
    source: {
      source, kind: source, key: item.key, url: item.url, title: item.title,
      ...(item.repo ? { repo: item.repo } : {}), ...(item.number ? { number: item.number } : {}), author: item.author,
      // A job taken from a trusted origin (issue #652), as discover takes one now.
      origin: 'trusted',
    },
    ...over,
  };
}

/** A job for issue #n of REPO without going through discover. */
export function jobForIssue(n: number, over: Partial<Job> = {}, repo = REPO, source = 'github'): Job {
  const url = `https://github.com/${repo}/issues/${n}`;
  return jobFor({ key: url, url, repo, number: n, author: 'owner', title: `Issue ${n}` }, over, source);
}


export type { FakeGitHub };
