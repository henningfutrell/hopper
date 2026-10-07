// Job sources: the GitHub adapter and its options, the sync loop — and the registry main serves on
// /api/sources, which also lists a configured source that does not run (disabled, or an instance
// that cannot run) as a fixed status.
import type { SourceRegistry } from '../domain/ports.ts';
import type { SourceStatus } from '../domain/types.ts';

export { createGitHubSource, createFakeGitHub } from './github/index.ts';
export type { FakeGitHub, GitHubApi, GitHubSourceOptions } from './github/index.ts';
export { githubAccountOptions, githubAppOptions, sourceConfig } from './config.ts';
export type { GitHubAccountOptions, GitHubAppOptions, GitHubSourceConfig } from './config.ts';
export { APP_MISSING, appProblem, createAccountSource, createAppSource } from './compose.ts';
export { createAccountGitHubApi } from './github/account/api.ts';
export { loadGitHubApp } from './github/app/index.ts';
export { createSourceSync } from './sync.ts';
export type { SourceSync, SourceSyncOptions } from './sync.ts';

/** A status for a source that is configured but not running. */
export function idleStatus(name: string, kind: string, state: 'disabled' | 'error', o: { error?: string; detail?: Record<string, unknown> } = {}): SourceStatus {
  return {
    name, kind, state, itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail: o.detail ?? {},
    ...(o.error !== undefined ? { lastError: o.error } : {}),
  };
}

/** The running sources' registry plus fixed statuses for the ones that do not run. */
export function withFixedStatuses(running: SourceRegistry, fixed: SourceStatus[]): SourceRegistry {
  return {
    statuses: () => [...fixed.map((s) => ({ ...s })), ...running.statuses()],
    onStatus: (listener) => running.onStatus(listener),
    rerun: (jobId) => running.rerun(jobId),
  };
}
