// Whether a repository moved (issue #967, `JobSource.moved`): its event feed (`GitHubApi.repoEvents`) has a pull request
// opened, closed, merged or reopened (`PullRequestEvent`), or a push (`PushEvent`), newer than the newest event the last ask
// saw. The first ask of a repository only learns its newest event. Kept in memory: a restart asks afresh, and its first sync
// reads everything anyway. Each repository is asked; a move in one is a move even when another's read failed, and with no
// move a failed read throws, so the sync loop logs it. The adapters ask the feed conditionally (the shared rate limiter's
// ETag): an unchanged feed costs no call of the rate limit. GitHub's feed lags its events by up to a minute or more; the
// sync timer still runs.
import type { GitHubApi } from './api.ts';

const MOVES = new Set(['PullRequestEvent', 'PushEvent']);

const newer = (id: string, than: string): boolean => {
  try { return BigInt(id) > BigInt(than); } catch { return id > than; }
};

export function movedReader(api: GitHubApi): (repos: string[]) => Promise<boolean> {
  /** The newest event id each repository's feed had when it was asked last, by its lowercased name. */
  const last = new Map<string, string>();

  async function movedIn(repo: string): Promise<boolean> {
    const events = await api.repoEvents!(repo);
    const k = repo.toLowerCase();
    const before = last.get(k);
    const newest = events.reduce<string | undefined>((m, e) => (m === undefined || newer(e.id, m) ? e.id : m), undefined);
    if (newest !== undefined && (before === undefined || newer(newest, before))) last.set(k, newest);
    else if (before === undefined) last.set(k, '0');
    if (before === undefined) return false;
    return events.some((e) => MOVES.has(e.type) && newer(e.id, before));
  }

  return async (repos) => {
    if (!api.repoEvents) return false;
    const asked = await Promise.allSettled(repos.map(movedIn));
    if (asked.some((r) => r.status === 'fulfilled' && r.value)) return true;
    const failed = asked.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    return false;
  };
}
