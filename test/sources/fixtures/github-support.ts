// Shared helpers for the GitHub source tests: a configured source over the in-memory fake,
// and Job literals shaped like the ones the engine hands a source.

import type { Job, JobStatus } from '../../../src/domain/types.ts';
import type { JobSource, SourceItem } from '../../../src/domain/ports.ts';
import githubApp from '../../../src/plugins/job-source/github-app/index.ts';
import { parseOptions } from '../../../src/plugins/options.ts';
import { sourceConfig, type GitHubAppOptions, type GitHubSourceConfig } from '../../../src/sources/config.ts';
import { createFakeGitHub, createGitHubSource } from '../../../src/sources/github/index.ts';
import type { FakeGitHub, GitHubSourceOptions } from '../../../src/sources/github/index.ts';

export const REPO = 'owner/sandbox';

/** The source logic's config: the shared keys of the GitHub sources (parsed as the app's options, which carry `repos`). */
export function githubConfig(over: Record<string, unknown> = {}): GitHubSourceConfig {
  const r = parseOptions(githubApp, { repos: [REPO], ...over });
  if (!r.ok) throw new Error(r.error);
  const { enabled: _e, appId: _i, slug: _s, privateKeyEnv: _k, apiUrl: _u, ...shared } = r.options as GitHubAppOptions;
  return sourceConfig(shared);
}

export function setup(over: Record<string, unknown> = {}, o: Partial<Pick<GitHubSourceOptions, 'knownKeys' | 'rerunnable' | 'rejections' | 'whoami' | 'yoloMode'>> = {}) {
  const gh = createFakeGitHub();
  const config = githubConfig(over);
  const clock = { now: () => new Date('2026-10-02T10:00:00.000Z') };
  const source = createGitHubSource({ name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', config, api: gh, clock, ...o });
  return { gh, config, source };
}

export const BOT = 'hopper-owner[bot]';
export const APP_INFO = { slug: 'hopper-owner', htmlUrl: 'https://github.com/apps/hopper-owner' };

export interface AppSetupOptions {
  installed?: string[];
  knownKeys?: (keys: string[]) => Set<string>;
  paused?: () => string | undefined;
  appInfo?: GitHubSourceOptions['appInfo'];
}

/** A source in app mode over the fake GitHub with the app identity (BOT is the app's login). */
export function setupApp(over: Record<string, unknown> = {}, o: AppSetupOptions = {}) {
  const gh = createFakeGitHub({ app: { botLogin: BOT, installedRepos: o.installed ?? [REPO] } });
  const config = githubConfig({ repos: [], ...over });
  const clock = { now: () => new Date('2026-10-02T10:00:00.000Z') };
  const source = createGitHubSource({
    name: 'github-app', kind: 'github-app', mode: 'app', assignee: () => 'owner', config, api: gh, clock,
    appInfo: o.appInfo ?? (() => APP_INFO),
    ...(o.knownKeys ? { knownKeys: o.knownKeys } : {}),
    ...(o.paused ? { paused: o.paused } : {}),
  });
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
