// The fake GitHub's answers a GitHub watch reads (issue #427), for test/support/fake-forges.ts: an issue with its state
// reason, and its timeline — a `commented` event for each of its comments, then the extra events a test gives it (a
// cross-reference from a pull request, a review).
import type { FakeIssue } from './fake-forges.ts';

/** The fake GitHub's option for it (a field of `FakeForge`). */
export interface WatchForge {
  /** GitHub: more timeline events of an issue, by `owner/name#N`, after its comments. */
  timelines?: Record<string, Record<string, unknown>[]>;
}

type Answer = { status: number; body?: unknown };

/** The answer to a GET of an issue or its timeline in `repo`; undefined: `rest` is neither. */
export function watchRoute(
  forge: WatchForge | undefined, issues: FakeIssue[], restIssue: (i: FakeIssue) => Record<string, unknown>, method: string, repo: string, rest: string,
): Answer | undefined {
  const m = /^issues\/(\d+)(\/timeline)?$/.exec(rest);
  if (method !== 'GET' || !m) return undefined;
  const issue = issues.find((i) => i.repo === repo && i.number === Number(m[1]));
  if (!issue) return { status: 404, body: { message: 'Not Found' } };
  if (!m[2]) return { status: 200, body: { ...restIssue(issue), state_reason: issue.stateReason ?? null } };
  const commented = (issue.comments ?? []).map((c) => ({ event: 'commented', ...c }));
  return { status: 200, body: [...commented, ...(forge?.timelines?.[`${repo}#${issue.number}`] ?? [])] };
}
