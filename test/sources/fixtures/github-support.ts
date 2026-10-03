// Shared helpers for the GitHub source tests: a configured source over the in-memory fake,
// and Job / Question literals shaped like the ones the engine hands a source.

import type { Job, JobStatus, Question } from '../../../src/domain/types.ts';
import type { JobSource, SourceItem } from '../../../src/domain/ports.ts';
import { parseSourcesConfig } from '../../../src/sources/config.ts';
import type { GitHubSourceConfig } from '../../../src/sources/config.ts';
import { createFakeGitHub, createGitHubSource } from '../../../src/sources/github/index.ts';
import type { FakeGitHub } from '../../../src/sources/github/index.ts';

export const REPO = 'owner/sandbox';

export function githubConfig(over: Record<string, unknown> = {}): GitHubSourceConfig {
  const r = parseSourcesConfig({ version: 1, github: { repos: [REPO], defaultCwd: '/work/default', ...over } });
  if ('error' in r || !r.github) throw new Error('error' in r ? r.error : 'no github');
  return r.github;
}

export function setup(over: Record<string, unknown> = {}, o: { knownKeys?: (keys: string[]) => Set<string>; whoami?: string } = {}) {
  const gh = createFakeGitHub();
  const config = githubConfig(over);
  const clock = { now: () => new Date('2026-10-02T10:00:00.000Z') };
  const source = createGitHubSource({ name: 'github', config, api: gh, clock, ...o });
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

export function jobFor(item: Pick<SourceItem, 'key' | 'url' | 'repo' | 'number' | 'author' | 'title'>, over: Partial<Job> = {}): Job {
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
      source: 'github', kind: 'github', key: item.key, url: item.url, title: item.title,
      ...(item.repo ? { repo: item.repo } : {}), ...(item.number ? { number: item.number } : {}), author: item.author,
    },
    ...over,
  };
}

/** A job for issue #n of REPO without going through discover. */
export function jobForIssue(n: number, over: Partial<Job> = {}, repo = REPO): Job {
  const url = `https://github.com/${repo}/issues/${n}`;
  return jobFor({ key: url, url, repo, number: n, author: 'owner', title: `Issue ${n}` }, over);
}

export function question(jobId: string, over: Partial<Question> = {}): Question {
  return {
    id: 'q-1', jobId, text: 'Which database should I use?', recentOutput: '…', detectedBy: 'marker', status: 'open', tier: 'human',
    attempts: [
      { tier: 'opus', model: 'opus', startedAt: '2026-10-02T10:00:00Z', answer: 'sqlite', confident: false, risky: false, reason: 'unsure', outcome: 'escalated' },
      { tier: 'fable', model: 'fable', startedAt: '2026-10-02T10:01:00Z', answer: 'drop it', confident: true, risky: true, riskRules: ['destructive'], reason: 'r', outcome: 'escalated' },
    ],
    notifyCount: 1, createdAt: '2026-10-02T10:00:00Z', updatedAt: '2026-10-02T10:02:00Z',
    ...over,
  };
}

export const MARKER_RE = /^<!-- job-hopper v1 /;

export type { FakeGitHub };
