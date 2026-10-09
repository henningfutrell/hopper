// How a job is named: its goal, and the issue it came from as `repo#n`.
import type { Job } from './wire.ts';

export const goalOf = (job: Job): string => job.spec.goal || job.source?.title || job.spec.executor;

export function issueRef(job: Job): string | null {
  const s = job.source;
  if (!s) return null;
  return s.repo && s.number != null ? `${s.repo.split('/').pop()}#${s.number}` : (s.title ?? s.key);
}

/** What a finished job's title says after done (issue #579): partly done, or where its pull request is now. */
export interface AfterDone { label: string; tone: 'ok' | 'warn'; url: string | undefined; title: string }

export function afterDone(job: Job): AfterDone | undefined {
  if (job.status !== 'finished') return undefined;
  const s = (job.sourceState?.source ?? {}) as { pullRequest?: unknown; follow?: unknown; part?: unknown };
  const url = typeof s.pullRequest === 'string' ? s.pullRequest : job.partlyDone;
  if (job.partlyDone) {
    return s.follow === 'merged' ? { label: 'part merged', tone: 'ok', url, title: 'its part was merged; the next part runs' }
      : s.follow === 'closed' ? { label: 'PR closed', tone: 'warn', url, title: 'its pull request was closed without a merge' }
        : { label: 'partly done', tone: 'ok', url, title: 'it shipped part of its issue; the rest runs once this pull request merges' };
  }
  if (s.follow === 'open') return { label: 'PR ready', tone: 'ok', url, title: 'its pull request waits for review' };
  if (s.follow === 'merged') return { label: 'merged', tone: 'ok', url, title: 'its pull request was merged' };
  if (s.follow === 'closed') return { label: 'PR closed', tone: 'warn', url, title: 'its pull request was closed without a merge' };
  return undefined;
}
