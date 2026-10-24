// How a job is named: its goal, and the issue it came from as `repo#n`.
import type { Job, YoloModeView } from './wire.ts';
import { repoMerges } from './yolo-mode.ts';

/** The job view of a job (issue #433): where every timeline entry about the job links. */
export const jobHref = (jobId: string): string => `#job/${encodeURIComponent(jobId)}`;

export const goalOf = (job: Job): string => job.spec.goal || job.source?.title || job.spec.executor;

export function issueRef(job: Job): string | null {
  const s = job.source;
  if (!s) return null;
  return s.repo && s.number != null ? `${s.repo.split('/').pop()}#${s.number}` : (s.title ?? s.key);
}

/** The issue a job points at, as owner/repo#number with its URL (issue #432); null when it has no repo or number. */
export function issuePointer(job: Job): { label: string; url: string | undefined } | null {
  const s = job.source;
  return s?.repo && s.number != null ? { label: `${s.repo}#${s.number}`, url: s.url } : null;
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

/**
 * What a finished job's title says after done (issue #579): partly done, or where its pull request is now. An open one in a
 * repository the hopper does not merge in (issue #2752: no job repository, and no person named it on in yolo mode) needs
 * a person's merge there, so it reads `needs merge in <repo>`, never ready; with yolo mode not known it reads as before.
 */
export interface AfterDone { label: string; tone: 'ok' | 'warn'; url: string | undefined; title: string }

/** Its issue closed as not planned upstream while its pull request waited (issue #428). */
const ABANDONED = (url: string | undefined): AfterDone => ({ label: 'abandoned', tone: 'warn', url, title: 'its issue was closed as not planned; its pull request is not merged' });

export function afterDone(job: Job, yolo?: YoloModeView): AfterDone | undefined {
  if (job.status !== 'finished') return undefined;
  const s = (job.sourceState?.source ?? {}) as { pullRequest?: unknown; follow?: unknown; part?: unknown };
  const url = typeof s.pullRequest === 'string' ? s.pullRequest : job.partlyDone;
  const elsewhere = s.follow === 'open' && yolo ? notMergedIn(url, yolo) : undefined;
  if (elsewhere) {
    return { label: `needs merge in ${elsewhere}`, tone: 'warn', url,
      title: `the hopper does not merge pull requests in ${elsewhere}: a person merges it there, or names ${elsewhere} on in Settings → Yolo mode` };
  }
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

/** The repository of a GitHub pull request URL that is no job repository and does not merge (issue #2752); else undefined. */
function notMergedIn(url: string | undefined, yolo: YoloModeView): string | undefined {
  const repo = url ? /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i.exec(url)?.[1] : undefined;
  if (!repo || yolo.choices.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) return undefined;
  return repoMerges(yolo, repo) ? undefined : repo;
}

/** The router's advice in plain words (issue #883); undefined for its default, run in full, which says nothing. */
const ADVICE_TEXT: Record<NonNullable<Job['advice']>['action'], string | undefined> = {
  proceed_full: undefined,
  reuse_cache: 'the router says: reuse earlier work',
  stop_retry: 'the router says: stop trying again',
  run_deterministic: 'the router says: run a fixed script, no agent',
  chat_only: 'the router says: answer only, change no code',
  ask_human: 'the router asks a person to look first',
  allow_subagent: 'the router lets it use helper agents',
  research_capped: 'the router says: research, with a limit',
};
export const adviceText = (action: NonNullable<Job['advice']>['action']): string | undefined => ADVICE_TEXT[action];
