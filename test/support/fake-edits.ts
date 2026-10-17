// The fake GitHub's edits (issue #946: a promotion made again edits what it posted), for test/support/fake-forges.ts:
// an issue's title and body changed (`PATCH …/issues/N`), and a comment's body (`PATCH …/issues/comments/ID`); a pull
// request's title and body changed, or it closed (`PATCH …/pulls/N`, issue #1734).
import type { FakeIssue, FakePull } from './fake-forges.ts';

type Answer = { status: number; body?: unknown };

/** An issue's title and body as a `PATCH` changes them. */
export function editIssue(issue: FakeIssue, body: Record<string, unknown>): void {
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
}

/** The answer to a comment's edit on `repo`; undefined: `rest` is none. */
export function commentEditRoute(issues: FakeIssue[], method: string, repo: string, rest: string, body: Record<string, unknown>): Answer | undefined {
  const m = /^issues\/comments\/(\d+)$/.exec(rest);
  if (method !== 'PATCH' || !m) return undefined;
  const comment = issues.filter((i) => i.repo === repo).flatMap((i) => i.comments ?? []).find((c) => c.id === Number(m[1]));
  if (!comment) return { status: 404, body: { message: 'Not Found' } };
  comment.body = body.body;
  return { status: 200, body: comment };
}

/** The answer to a pull request's edit or close on `repo`; undefined: `rest` is none. */
export function pullEditRoute(pulls: FakePull[], restPull: (p: FakePull) => unknown, method: string, repo: string, rest: string, body: Record<string, unknown>): Answer | undefined {
  const m = /^pulls\/(\d+)$/.exec(rest);
  if (method !== 'PATCH' || !m) return undefined;
  const pull = pulls.find((p) => p.repo === repo && p.number === Number(m[1]));
  if (!pull) return { status: 404, body: { message: 'Not Found' } };
  if (typeof body.title === 'string') pull.title = body.title;
  if (typeof body.body === 'string') pull.body = body.body;
  if (body.state === 'closed' || body.state === 'open') pull.state = body.state;
  return { status: 200, body: restPull(pull) };
}
