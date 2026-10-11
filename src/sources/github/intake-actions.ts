// The intake actions a person takes from Sources (issues #440, #652): Assign to me, Release claim, and Approve on a request
// card — each only on an item the source's last discover offered it for. Apart from source.ts for its size.
import type { IntakeAction, IntakeActionResult, IntakeContext, IntakeOutcome } from '../../domain/intake.ts';
import type { IntakeRequest } from '../../domain/intake-origin.ts';
import type { GitHubApi } from './api.ts';
import { HOLDER_PREFIX, LABEL_CLAIMED } from './labels.ts';

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
}

const numberOf = (url: string): number => Number(url.slice(url.lastIndexOf('/') + 1));

export async function intakeAct(c: IntakeActionContext, a: IntakeAction): Promise<IntakeActionResult> {
  const offered = new Map(c.offered.map((x) => [x.key, x]));
  const done: string[] = [];
  const failed: Record<string, string> = {};
  for (const key of [...new Set(a.keys)]) {
    const x = offered.get(key);
    if (!x?.repo) { failed[key] = NOT_IN_SCOPE; continue; }
    if (x.action !== a.kind) { failed[key] = `not offered: ${x.reason ?? 'taken'}`; continue; }
    try {
      if (a.kind === 'approve') {
        if (!await c.approve(x.repo, key, x.request, a)) { failed[key] = TEXT_CHANGED_SINCE_SHOWN; continue; }
      } else if (a.kind === 'assign') {
        if (!c.assignee) throw new Error('no GitHub account connected');
        await c.api.addAssignees(x.repo, numberOf(key), [c.assignee]);
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
