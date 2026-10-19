// A commit's checks over REST (issue #1244), read by the connected account's adapter: its check runs
// (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`, Checks: read) and its combined status
// (`GET /repos/{owner}/{repo}/commits/{ref}/status`, Commit statuses: read), as one state the way GitHub's rollup tells
// it. The read the hopper makes when GitHub refuses the GraphQL rollup (`checksFallback`).

import type { HeadChecks } from '../api.ts';
import type { ChecksState } from '../../../domain/pull-requests.ts';
import type { CheckFact } from '../../../domain/conditional-skills.ts';
import { newestRuns } from '../newest-runs.ts';
import { splitRepo, statusOf } from './http.ts';
import type { Request } from './http.ts';

interface CheckRun { id?: number; name?: string; status?: string; conclusion?: string | null; output?: { title?: string | null; summary?: string | null; text?: string | null } }
interface CommitStatus { context?: string; state?: string }

/** A check run's conclusion that passes: the rest of a completed run's conclusions fail. */
const PASSED = new Set(['success', 'neutral', 'skipped']);
/** A check run GitHub marked stale: it asks for it again, so it waits. */
const WAITS = new Set(['stale']);

const runState = (r: CheckRun): ChecksState =>
  r.status !== 'completed' || WAITS.has(r.conclusion ?? '') ? 'pending' : PASSED.has(r.conclusion ?? '') ? 'passing' : 'failing';

const statusState = (s: CommitStatus): ChecksState =>
  s.state === 'success' ? 'passing' : s.state === 'pending' ? 'pending' : 'failing';

/** One state for all of them, as the rollup: one failed fails it (issue #927), else one running keeps it pending; none: absent. */
export function combinedChecks(states: ChecksState[]): ChecksState | undefined {
  if (!states.length) return undefined;
  if (states.includes('failing')) return 'failing';
  return states.includes('pending') ? 'pending' : 'passing';
}

/** The newest run of each check only (issue #2129): a newer run of a check supersedes its older runs on the same commit. */
const newest = (runs: CheckRun[] | undefined): CheckRun[] => newestRuns(runs ?? [], (r) => r.name, (r) => r.id);

/** GitHub refused the read to this credential (403, 404), not a rate limit: the permission is missing. */
const refused = (err: unknown): boolean => {
  const s = statusOf(err);
  return (s === 403 || s === 404) && !/rate limit/i.test(String((err as { message?: unknown }).message ?? ''));
};

export async function headChecks(req: Request, token: string, repo: string, ref: string): Promise<HeadChecks> {
  const at = { ...splitRepo(repo), ref, headers: { authorization: `token ${token}` } };
  const [runs, status] = await Promise.allSettled([
    req('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ...at, per_page: 100 }),
    req('GET /repos/{owner}/{repo}/commits/{ref}/status', { ...at, per_page: 100 }),
  ]);
  const unreadable: ('checks' | 'statuses')[] = [];
  for (const [r, what] of [[runs, 'checks'], [status, 'statuses']] as const) {
    if (r.status === 'rejected') {
      if (!refused(r.reason)) throw r.reason;
      unreadable.push(what);
    }
  }
  if (unreadable.length || runs.status === 'rejected' || status.status === 'rejected') return { unreadable };
  const states = [
    ...newest((runs.value.data as { check_runs?: CheckRun[] }).check_runs).map(runState),
    ...((status.value.data as { statuses?: CommitStatus[] }).statuses ?? []).map(statusState),
  ];
  const checks = combinedChecks(states);
  return checks ? { checks } : {};
}

/**
 * Each check of commit `ref` (issue #1924): each check run by its name (its newest run, issue #2129), state and output text, and each commit status by its
 * context. What the done criteria of a conditional skill read. Any error throws: not known is not done.
 */
export async function checkRuns(req: Request, token: string, repo: string, ref: string): Promise<CheckFact[]> {
  const at = { ...splitRepo(repo), ref, headers: { authorization: `token ${token}` }, per_page: 100 };
  const [runs, status] = await Promise.all([req('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', at), req('GET /repos/{owner}/{repo}/commits/{ref}/status', at)]);
  return [
    ...newest((runs.data as { check_runs?: CheckRun[] }).check_runs).map((r) => ({
      name: r.name ?? '', state: runState(r), text: [r.output?.title, r.output?.summary, r.output?.text].filter((t): t is string => typeof t === 'string' && t !== '').join('\n'),
    })),
    ...((status.data as { statuses?: CommitStatus[] }).statuses ?? []).map((s) => ({ name: s.context ?? '', state: statusState(s) })),
  ];
}
