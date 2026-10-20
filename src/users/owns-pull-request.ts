// Which pull requests a job may edit or close through the GitHub proxy (issues #1734, #2127, #2151, #2227), from the user's
// store; the rule itself is checkRequest's (src/github-proxy/policy.ts).
import { issueText, namesItem } from '../domain/linked-pulls.ts';
import type { UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { isPullRequest, type ProxyOp } from '../github-proxy/index.ts';

/** How many of a job's newest proxy events say which pull requests it opened (issue #1734). */
const OWNED_READ = 1000;

/**
 * A pull request the job opened through the proxy, or its work item's — one an earlier job of the item opened (issue #1734) —,
 * or the one it was started to tend (issue #2127): `job.pull_request_tended` of the job it reruns names it the next job.
 * An edit also of one its issue's title or body names (issue #2151; issue #2227: the item's approved text, every name of
 * it): the job was told to update it. Else why not, for the refusal.
 */
export function ownsPullRequest(store: UserStore, job: Job, repo: string, number: number, op: ProxyOp): true | string {
  const opened = store.events.recent(OWNED_READ, ['github_proxy.done'], job.id)
    .some((e) => e.data.op === 'pr.create' && e.data.number === number && typeof e.data.repo === 'string' && e.data.repo.toLowerCase() === repo.toLowerCase());
  const itemPr = job.source ? store.workItems.get(job.source.key)?.pullRequest : undefined;
  const tends = job.rerunOf !== undefined && store.events.recent(OWNED_READ, ['job.pull_request_tended'], job.rerunOf)
    .some((e) => e.data.nextJobId === job.id && typeof e.data.pullRequest === 'string' && isPullRequest(e.data.pullRequest, repo, number));
  if (opened || tends || (itemPr !== undefined && isPullRequest(itemPr, repo, number))) return true;
  const notOwned = 'the job did not open it, was not started to tend it, and it is not its work item\'s';
  if (op !== 'pr.edit') return notOwned;
  const s = job.source;
  if (!s?.repo || s.number === undefined) return `${notOwned}, and the job has no issue that names it`;
  const snapshot = store.itemSnapshots.get(s.key);
  const named = namesItem({ repo: s.repo, number: s.number, url: s.url ?? s.key }, issueText(snapshot ?? { title: s.title ?? '', body: '' }), repo, number);
  return named === true || `${notOwned}, and ${named}`;
}
