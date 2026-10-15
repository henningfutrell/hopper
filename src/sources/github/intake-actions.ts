// The intake actions a person takes from Sources (issues #440, #652, #798): Assign to me, Release claim, Approve and Decline
// (issue #1035) on a request card — on a reopened card (issue #1126) Approve also takes `hopper:done` off —, and Take off the backburner — each only on an item the source's last discover offered
// it for. Decline writes nothing to GitHub. Take into Intake (issue #1176): only on an issue an untracked pull request the
// last census listed closes, and that is no work item. Apart from source.ts for its size.
import type { IntakeAction, IntakeActionResult, IntakeContext, IntakeOutcome, IntakeTrust } from '../../domain/intake.ts';
import { requestHash, type IntakeRequest } from '../../domain/intake-origin.ts';
import type { UntrackedPullRequest } from '../../domain/untracked-pull-requests.ts';
import type { GitHubApi } from './api.ts';
import { HOLDER_PREFIX, LABEL_BACKBURNER, LABEL_CLAIMED, LABEL_DONE } from './labels.ts';

export const NOT_IN_SCOPE = 'not in this source\'s scope';
export const TEXT_CHANGED_SINCE_SHOWN = 'its title or body changed since it was shown: read it again';
/** Approve on an item taken with a text a person approved, but not this text (issue #1045). */
export const ALREADY_APPROVED = 'already approved';
/** Approve on an item taken with no approval: its origin is trusted (issue #1045). */
export const ALREADY_TAKEN = 'already taken, no approval needed';
/** Take into Intake on an issue the last census did not offer (issue #1176). */
export const NOT_OFFERED_TAKE_IN = 'not offered: no untracked pull request closes it';

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
  /** Keeps a person's decline of a request card (issue #1035); the text a person approved (issue #1045). */
  trust: Pick<IntakeTrust, 'decline' | 'approvedText'>;
  /** The source's label: what Take into Intake gives an issue. */
  label: string;
  /** The issues the last census offers to Intake, each with the untracked pull request that closes it (issue #1176). */
  takeIn: Map<string, UntrackedPullRequest>;
}

/** Take into Intake (issue #1176): the source's label and an assignment to the connected account, a GitHub write the user makes. */
async function takeIn(c: IntakeActionContext, keys: string[]): Promise<IntakeActionResult> {
  const done: string[] = [];
  const failed: Record<string, string> = {};
  for (const key of [...new Set(keys)]) {
    const u = c.takeIn.get(key);
    if (!u) { failed[key] = NOT_OFFERED_TAKE_IN; continue; }
    try {
      if (!c.assignee) throw new Error('no GitHub account connected');
      await c.api.addLabels(u.repo, numberOf(key), [c.label]);
      await c.api.addAssignees(u.repo, numberOf(key), [c.assignee]);
      c.intake?.record('source.issue_taken_in', { source: c.source, key, pullRequest: u.url, assignee: c.assignee });
      done.push(key);
    } catch (err) {
      failed[key] = (err as Error).message;
    }
  }
  return { done, failed };
}

/** Decline is offered where Approve is: on a request card. */
const offeredAs = (kind: IntakeAction['kind']): IntakeAction['kind'] => (kind === 'decline' ? 'approve' : kind);

const numberOf = (url: string): number => Number(url.slice(url.lastIndexOf('/') + 1));

export async function intakeAct(c: IntakeActionContext, a: IntakeAction): Promise<IntakeActionResult> {
  if (a.kind === 'take_in') return takeIn(c, a.keys);
  const offered = new Map(c.offered.map((x) => [x.key, x]));
  const done: string[] = [];
  const failed: Record<string, string> = {};
  for (const key of [...new Set(a.keys)]) {
    const x = offered.get(key);
    if (!x?.repo) { failed[key] = NOT_IN_SCOPE; continue; }
    if (x.action !== offeredAs(a.kind)) {
      // Approve again of a text already approved, from a page that still shows the card or another client, is done:
      // nothing more to do (issue #1045).
      const text = a.kind === 'approve' ? c.trust.approvedText(key) : undefined;
      if (text && requestHash(text) === a.hash) { done.push(key); continue; }
      failed[key] = a.kind === 'approve' && x.reason === undefined ? (text ? ALREADY_APPROVED : ALREADY_TAKEN) : `not offered: ${x.reason ?? 'taken'}`;
      continue;
    }
    try {
      if (a.kind === 'approve') {
        if (!await c.approve(x.repo, key, x.request, a)) { failed[key] = TEXT_CHANGED_SINCE_SHOWN; continue; }
        // A reopened card (issue #1126): `hopper:done` goes, so the next sync takes the issue again.
        if (x.request?.reopened) await c.api.removeLabels(x.repo, numberOf(key), [LABEL_DONE]);
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
