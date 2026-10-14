// The fake GitHub's sub-issues (issue #729: a job's required child issue is linked as a sub-issue of the job's issue), for
// test/support/fake-forges.ts: an issue's REST id, the link (`POST …/issues/N/sub_issues` with the child's id), and the
// list (`GET …/issues/N/sub_issues`). A link is kept on the parent as `owner/name#N`.
import { createHash } from 'node:crypto';
import type { FakeIssue } from './fake-forges.ts';

/** The fake GitHub's option for it (a field of `FakeForge`). */
export interface SubIssuesForge {
  /** GitHub: a sub-issue link answers this status and is not made. */
  subIssuesRefused?: number;
}

type Answer = { status: number; body?: unknown };

/** An issue's REST id: not its number, as on GitHub; the same for the same issue. */
export const issueIdOf = (repo: string, number: number): number =>
  Number.parseInt(createHash('sha256').update(`${repo}#${number}`).digest('hex').slice(0, 8), 16);

/** The answer to a sub-issues request of `repo`; undefined: `rest` is no sub-issues path. */
export function subIssuesRoute(
  forge: SubIssuesForge | undefined, issues: FakeIssue[], restIssue: (i: FakeIssue) => unknown,
  method: string, repo: string, rest: string, body: Record<string, unknown>,
): Answer | undefined {
  const m = /^issues\/(\d+)\/sub_issues$/.exec(rest);
  if (!m) return undefined;
  const parent = issues.find((i) => i.repo === repo && i.number === Number(m[1]));
  if (!parent) return { status: 404, body: { message: 'Not Found' } };
  if (method === 'GET') return { status: 200, body: (parent.subIssues ?? []).flatMap((k) => issues.filter((i) => `${i.repo}#${i.number}` === k)).map(restIssue) };
  if (method !== 'POST') return undefined;
  if (forge?.subIssuesRefused) return { status: forge.subIssuesRefused, body: { message: 'Validation Failed', errors: [{ message: 'the issue may not be added as a sub-issue' }] } };
  const child = issues.find((i) => issueIdOf(i.repo, i.number) === Number(body.sub_issue_id));
  if (!child) return { status: 404, body: { message: 'Not Found' } };
  parent.subIssues = [...(parent.subIssues ?? []), `${child.repo}#${child.number}`];
  return { status: 201, body: restIssue(parent) };
}
