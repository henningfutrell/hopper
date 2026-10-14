// The fake GitHub's repository listings (issue #985), for test/support/fake-forges.ts: `POST /graphql` with `r<i>:
// repository(owner: $o<i>, name: $n<i>)` aliases, each answering the open issues of that repository with one of the labels,
// one page. Its pull requests carry no labels, so none is listed. An issue's `updatedAt` is a stamp of what it holds now:
// it moves on each change, as on GitHub, which the hopper's listed reads compare.
import { createHash } from 'node:crypto';
import type { FakeIssue } from './fake-forges.ts';

/** When the issue changed last, as GitHub would say it: the same for the same content, another one after a change. */
export const updatedAtOf = (i: FakeIssue): string => {
  const hash = createHash('sha256').update(JSON.stringify([i.title, i.body, i.labels, i.assignees, i.state, i.stateReason, i.comments?.length, i.subIssues])).digest('hex');
  return new Date(Date.UTC(2026, 9, 6) + (Number.parseInt(hash.slice(0, 8), 16) % 86_400_000)).toISOString();
};

/** The answer to a repository listing; undefined: the query is none. */
export function listingRoute(base: string, issues: FakeIssue[], method: string, path: string, body: Record<string, unknown>): { status: number; body: unknown } | undefined {
  const query = String(body.query ?? '');
  if (method !== 'POST' || path !== '/graphql' || !/r0: repository\(owner/.test(query)) return undefined;
  const vars = (body.variables ?? {}) as Record<string, unknown>;
  const labels = (vars.labels as string[] | undefined) ?? [];
  const data: Record<string, unknown> = {};
  for (const m of query.matchAll(/(r\d+): repository\(owner: \$(o\d+), name: \$(n\d+)\) \{/g)) {
    const [, alias, o, n] = m as unknown as [string, string, string, string];
    const repo = `${String(vars[o])}/${String(vars[n])}`;
    const nodes = issues.filter((i) => i.repo === repo && (i.state ?? 'open') === 'open' && i.labels.some((l) => labels.includes(l))).map((i) => ({
      number: i.number, url: `${base}/${i.repo}/issues/${i.number}`, title: i.title, updatedAt: updatedAtOf(i), author: { login: i.author },
      labels: { nodes: i.labels.map((name) => ({ name })) }, assignees: { nodes: (i.assignees ?? [i.author]).map((login) => ({ login })) },
    }));
    data[alias] = { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
  }
  return { status: 200, body: { data } };
}
