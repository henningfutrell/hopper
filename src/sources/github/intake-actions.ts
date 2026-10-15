// The intake actions a person takes from Sources (issues #440, #652, #798): Assign to me, Release claim, Approve and Decline
// (issue #1035) on a request card — on a reopened card (issue #1126) Approve also takes `hopper:done` off —, and Take off the backburner — each only on an item the source's last discover offered
// it for. Decline writes nothing to GitHub. Take into Intake (issue #1176): only on an issue an untracked pull request the
// last census listed closes, and that is no work item. Each GitHub write is a row in the GitHub outbox (`outbox.ts`,
// issue #1238), sent after the answer, and its event is recorded once GitHub took it. Apart from source.ts for its size.
import type { IntakeAction, IntakeActionResult, IntakeContext, IntakeOutcome, IntakeTrust } from '../../domain/intake.ts';
import { requestHash, type IntakeRequest } from '../../domain/intake-origin.ts';
import type { UntrackedPullRequest } from '../../domain/untracked-pull-requests.ts';
import type { GitHubOutbox } from './outbox.ts';
import type { OutboxChange, OutboxEvent } from '../../domain/github-outbox.ts';
import { HOLDER_PREFIX, LABEL_BACKBURNER, LABEL_CLAIMED } from './labels.ts';

export const NOT_IN_SCOPE = 'not in this source\'s scope';
export const TEXT_CHANGED_SINCE_SHOWN = 'its title or body changed since it was shown: read it again';
/** Approve on an item taken with a text a person approved, but not this text (issue #1045). */
export const ALREADY_APPROVED = 'already approved';
/** Approve on an item taken with no approval: its origin is trusted (issue #1045). */
export const ALREADY_TAKEN = 'already taken, no approval needed';
/** Take into Intake on an issue the last census did not offer (issue #1176). */
export const NOT_OFFERED_TAKE_IN = 'not offered: no untracked pull request closes it';
const NO_ACCOUNT = 'no GitHub account connected';
const NOTHING_FAILED = 'no GitHub write of this item failed';

export interface IntakeActionContext {
  source: string;
  /** What the last discover listed. */
  offered: IntakeOutcome[];
  /** The labels of each issue the last discover listed, by URL: what a release removes. */
  listedLabels: Map<string, string[]>;
  assignee: string | undefined;
  intake: IntakeContext | undefined;
  /** Approve a request card (issue #652): false when it is not the text the last sync showed. Its GitHub work is outbox rows (issue #1238). */
  approve(repo: string, key: string, request: IntakeRequest | undefined, a: IntakeAction): boolean;
  /** Keeps a person's decline of a request card (issue #1035); the text a person approved (issue #1045). */
  trust: Pick<IntakeTrust, 'decline' | 'approvedText'>;
  /** The source's label: what Take into Intake gives an issue. */
  label: string;
  /** The issues the last census offers to Intake, each with the untracked pull request that closes it (issue #1176). */
  takeIn: Map<string, UntrackedPullRequest>;
  /** The GitHub writes after the answer (issues #1194, #1238). */
  outbox: GitHubOutbox;
}

/** Take into Intake (issue #1176): the source's label and an assignment to the connected account, a GitHub write the user makes. */
function takeIn(c: IntakeActionContext, keys: string[]): IntakeActionResult {
  const done: string[] = [];
  const failed: Record<string, string> = {};
  for (const key of [...new Set(keys)]) {
    const u = c.takeIn.get(key);
    if (!u) { failed[key] = NOT_OFFERED_TAKE_IN; continue; }
    const assignee = c.assignee;
    if (!assignee) { failed[key] = NO_ACCOUNT; continue; }
    if (!c.outbox.sent('take_in', key)) {
      c.outbox.queue('take_in', key, u.repo, [
        { change: { op: 'add_labels', labels: [c.label] } },
        { change: { op: 'add_assignees', assignees: [assignee] }, event: { type: 'source.issue_taken_in', data: { source: c.source, key, pullRequest: u.url, assignee } } },
      ]);
    }
    done.push(key);
  }
  return { done, failed };
}

/** Decline is offered where Approve is: on a request card. */
const offeredAs = (kind: IntakeAction['kind']): IntakeAction['kind'] => (kind === 'decline' ? 'approve' : kind);

/** Assign to me, Release claim or Take off the backburner on GitHub: its change, with its event once GitHub took it; a string: refused now. */
function gitHubWrite(c: IntakeActionContext, kind: IntakeAction['kind'], key: string): { change: OutboxChange; event: OutboxEvent } | string {
  if (kind === 'assign') {
    const assignee = c.assignee;
    if (!assignee) return NO_ACCOUNT;
    return { change: { op: 'add_assignees', assignees: [assignee] }, event: { type: 'source.issues_assigned', data: { source: c.source, keys: [key], assignee } } };
  }
  if (kind === 'unbackburner') {
    return { change: { op: 'remove_labels', labels: [LABEL_BACKBURNER] }, event: { type: 'source.backburner_lifted', data: { source: c.source, key } } };
  }
  const holders = (c.listedLabels.get(key) ?? []).filter((l) => l.startsWith(HOLDER_PREFIX));
  return {
    change: { op: 'remove_labels', labels: [LABEL_CLAIMED, ...holders] },
    event: { type: 'source.claim_released', data: { source: c.source, key, by: 'user', reason: 'released in Sources' } },
  };
}

/** A person's Retry on Sources (issue #1238): each item's failed outbox rows are sent again. */
function retryOutbox(c: IntakeActionContext, keys: string[]): IntakeActionResult {
  const done: string[] = [];
  const failed: Record<string, string> = {};
  for (const key of new Set(keys)) if (c.outbox.retry(key) > 0) done.push(key); else failed[key] = NOTHING_FAILED;
  return { done, failed };
}

export async function intakeAct(c: IntakeActionContext, a: IntakeAction): Promise<IntakeActionResult> {
  if (a.kind === 'take_in') return takeIn(c, a.keys);
  if (a.kind === 'retry_outbox') return retryOutbox(c, a.keys);
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
        // A reopened card (issue #1126): the approve takes `hopper:done` off, after it (issue #1194), so the sync takes it again.
        if (!c.approve(x.repo, key, x.request, a)) { failed[key] = TEXT_CHANGED_SINCE_SHOWN; continue; }
      } else if (a.kind === 'decline') {
        // Only the text the person read, as the last sync showed it. Nothing on GitHub.
        if (!x.request || x.request.hash !== a.hash) { failed[key] = TEXT_CHANGED_SINCE_SHOWN; continue; }
        c.trust.decline(c.source, key, x.request, a.acting);
      } else if (!c.outbox.sent(a.kind, key)) {
        const write = gitHubWrite(c, a.kind, key);
        if (typeof write === 'string') { failed[key] = write; continue; }
        c.outbox.queue(a.kind, key, x.repo, [write]);
      }
      done.push(key);
    } catch (err) {
      failed[key] = (err as Error).message;
    }
  }
  return { done, failed };
}
