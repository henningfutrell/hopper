// The intake actions a person takes from Sources (issues #440, #652, #798): Assign to me, Release claim, Approve and Decline
// (issue #1035) on a request card, and Take off the backburner — each only on an item the source's last discover offered
// it for. Decline writes nothing to GitHub. Apart from source.ts for its size.
import type { IntakeAction, IntakeActionResult, IntakeContext, IntakeOutcome, IntakeTrust } from '../../domain/intake.ts';
import type { IntakeRequest } from '../../domain/intake-origin.ts';
import type { GitHubApi } from './api.ts';
import { HOLDER_PREFIX, LABEL_BACKBURNER, LABEL_CLAIMED } from './labels.ts';

export const NOT_IN_SCOPE = 'not in this source\'s scope';
export const TEXT_CHANGED_SINCE_SHOWN = 'its title or body changed since it was shown: read it again';

export interface IntakeActionContext {
  source: string;
  api: GitHubApi;
  /** What the last discover listed. */
  offered: IntakeOutcome[];
  /** The labels of each issue the last discover listed, by URL: what a release removes. */
  listedLabels: Map<string, string[]>;
  assignee: string | undefined;
  intake: IntakeContext | undefined;
  /** Approve a request card (issue #652): false when its text changed since the person read it. */
  approve(repo: string, key: string, request: IntakeRequest | undefined, a: IntakeAction): Promise<boolean>;
  /** Keeps a person's decline of a request card (issue #1035). */
  trust: Pick<IntakeTrust, 'decline'>;
}

/** Decline is offered where Approve is: on a request card. */
const offeredAs = (kind: IntakeAction['kind']): IntakeAction['kind'] => (kind === 'decline' ? 'approve' : kind);

const numberOf = (url: string): number => Number(url.slice(url.lastIndexOf('/') + 1));

export async function intakeAct(c: IntakeActionContext, a: IntakeAction): Promise<IntakeActionResult> {
  const offered = new Map(c.offered.map((x) => [x.key, x]));
  const done: string[] = [];
  const failed: Record<string, string> = {};
  for (const key of [...new Set(a.keys)]) {
    const x = offered.get(key);
    if (!x?.repo) { failed[key] = NOT_IN_SCOPE; continue; }
    if (x.action !== offeredAs(a.kind)) { failed[key] = `not offered: ${x.reason ?? 'taken'}`; continue; }
    try {
      if (a.kind === 'approve') {
        if (!await c.approve(x.repo, key, x.request, a)) { failed[key] = TEXT_CHANGED_SINCE_SHOWN; continue; }
      } else if (a.kind === 'decline') {
        // Only the text the person read, as the last sync showed it. Nothing on GitHub.
        if (!x.request || x.request.hash !== a.hash) { failed[key] = TEXT_CHANGED_SINCE_SHOWN; continue; }
        c.trust.decline(c.source, key, x.request, a.acting);
      } else if (a.kind === 'assign') {
        if (!c.assignee) throw new Error('no GitHub account connected');
        await c.api.addAssignees(x.repo, numberOf(key), [c.assignee]);
      } else if (a.kind === 'unbackburner') {
        await c.api.removeLabels(x.repo, numberOf(key), [LABEL_BACKBURNER]);
        c.intake?.record('source.backburner_lifted', { source: c.source, key });
      } else {
        const holders = (c.listedLabels.get(key) ?? []).filter((l) => l.startsWith(HOLDER_PREFIX));
        await c.api.removeLabels(x.repo, numberOf(key), [LABEL_CLAIMED, ...holders]);
        c.intake?.record('source.claim_released', { source: c.source, key, by: 'user', reason: 'released in Sources' });
      }
      done.push(key);
    } catch (err) {
      failed[key] = (err as Error).message;
    }
  }
  if (a.kind === 'assign' && done.length > 0) c.intake?.record('source.issues_assigned', { source: c.source, keys: done, assignee: c.assignee });
  return { done, failed };
}
