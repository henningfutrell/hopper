// How a job is named: its goal, and the issue it came from as `repo#n`.
import type { Job } from './wire.ts';

export const goalOf = (job: Job): string => job.spec.goal || job.source?.title || job.spec.executor;

export function issueRef(job: Job): string | null {
  const s = job.source;
  if (!s) return null;
  return s.repo && s.number != null ? `${s.repo.split('/').pop()}#${s.number}` : (s.title ?? s.key);
}

/** The parts done of a job's issue (issue #729): as followed after its part merged, else as offered. */
export interface PartsShown { done: number; total: number; label: string }

const isParts = (p: unknown): p is { done: number; total: number } =>
  typeof p === 'object' && p !== null && typeof (p as { done?: unknown }).done === 'number' && typeof (p as { total?: unknown }).total === 'number';

export function partsOf(job: Job): PartsShown | undefined {
  const followed = (job.sourceState?.source as { parts?: unknown } | undefined)?.parts;
  const p = isParts(followed) ? followed : job.source?.parts;
  return p && { done: p.done, total: p.total, label: `parts ${p.done}/${p.total}` };
}

/** What a finished job's title says after done (issue #579): partly done, or where its pull request is now. */
export interface AfterDone { label: string; tone: 'ok' | 'warn'; url: string | undefined; title: string }

/** Its issue closed as not planned upstream while its pull request waited (issue #428). */
const ABANDONED = (url: string | undefined): AfterDone => ({ label: 'abandoned', tone: 'warn', url, title: 'its issue was closed as not planned; its pull request is not merged' });

export function afterDone(job: Job): AfterDone | undefined {
  if (job.status !== 'finished') return undefined;
  const s = (job.sourceState?.source ?? {}) as { pullRequest?: unknown; follow?: unknown; part?: unknown };
  const url = typeof s.pullRequest === 'string' ? s.pullRequest : job.partlyDone;
  if (job.partlyDone) {
    return s.follow === 'merged' ? { label: 'part merged', tone: 'ok', url, title: 'its part was merged; the next part runs' }
      : s.follow === 'closed' ? { label: 'PR closed', tone: 'warn', url, title: 'its pull request was closed without a merge' }
        : s.follow === 'abandoned' ? ABANDONED(url)
          : { label: 'partly done', tone: 'ok', url, title: 'it shipped part of its issue; the rest runs once this pull request merges' };
  }
  if (s.follow === 'open') return { label: 'PR ready', tone: 'ok', url, title: 'its pull request waits for review' };
  if (s.follow === 'merged') return { label: 'merged', tone: 'ok', url, title: 'its pull request was merged' };
  if (s.follow === 'closed') return { label: 'PR closed', tone: 'warn', url, title: 'its pull request was closed without a merge' };
  if (s.follow === 'abandoned') return ABANDONED(url);
  return undefined;
}
