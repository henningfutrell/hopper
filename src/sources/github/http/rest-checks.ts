// A commit's checks over REST (issue #1244), read by the connected account's adapter: its check runs
// (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`, Checks: read) and its combined status
// (`GET /repos/{owner}/{repo}/commits/{ref}/status`, Commit statuses: read), as one state the way GitHub's rollup tells
// it. The read the hopper makes when GitHub refuses the GraphQL rollup (`checksFallback`).

import type { HeadChecks } from '../api.ts';
import type { ChecksState } from '../../../domain/pull-requests.ts';
import { splitRepo, statusOf } from './http.ts';
import type { Request } from './http.ts';

interface CheckRun { status?: string; conclusion?: string | null }
interface CommitStatus { state?: string }

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
    ...((runs.value.data as { check_runs?: CheckRun[] }).check_runs ?? []).map(runState),
    ...((status.value.data as { statuses?: CommitStatus[] }).statuses ?? []).map(statusState),
  ];
  const checks = combinedChecks(states);
  return checks ? { checks } : {};
}
