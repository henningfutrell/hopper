// The intake actions a person takes from Sources (issues #440, #652, #798): Assign to me, Release claim, Approve and Decline
// (issue #1035) on a request card — on a reopened card (issue #1126) Approve also takes `hopper:done` off —, and Take off the backburner — each only on an item the source's last discover offered
// it for. Decline writes nothing to GitHub. Take into Intake (issue #1176): only on an issue an untracked pull request the
// last census listed closes, and that is no work item. Each GitHub write runs after the answer, its write-behind
// (`write-behind.ts`, issue #1194), and its event is recorded once GitHub took it. Apart from source.ts for its size.
import type { IntakeAction, IntakeActionResult, IntakeContext, IntakeOutcome, IntakeTrust } from '../../domain/intake.ts';
import { requestHash, type IntakeRequest } from '../../domain/intake-origin.ts';
import type { UntrackedPullRequest } from '../../domain/untracked-pull-requests.ts';
import type { GitHubApi } from './api.ts';
import type { WriteBehind } from './write-behind.ts';
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

export interface IntakeActionContext {
  source: string;
  api: GitHubApi;
  /** What the last discover listed. */
  offered: IntakeOutcome[];
  /** The labels of each issue the last discover listed, by URL: what a release removes. */
  listedLabels: Map<string, string[]>;
  assignee: string | undefined;
  intake: IntakeContext | undefined;
  /** Approve a request card (issue #652): false when it is not the text the last sync showed. Its GitHub writes run after it (issue #1194). */
  approve(repo: string, key: string, request: IntakeRequest | undefined, a: IntakeAction): Promise<boolean>;
  /** Keeps a person's decline of a request card (issue #1035); the text a person approved (issue #1045). */
  trust: Pick<IntakeTrust, 'decline' | 'approvedText'>;
  /** The source's label: what Take into Intake gives an issue. */
  label: string;
  /** The issues the last census offers to Intake, each with the untracked pull request that closes it (issue #1176). */
  takeIn: Map<string, UntrackedPullRequest>;
  /** The GitHub writes after the answer (issue #1194). */
  writeBehind: WriteBehind;
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
    if (!c.writeBehind.sent('take_in', key)) {
      c.writeBehind.run('take_in', key, async () => {
        await c.api.addLabels(u.repo, numberOf(key), [c.label]);
        await c.api.addAssignees(u.repo, numberOf(key), [assignee]);
        c.intake?.record('source.issue_taken_in', { source: c.source, key, pullRequest: u.url, assignee });
      });
    }
    done.push(key);
  }
  return { done, failed };
}

/** Decline is offered where Approve is: on a request card. */
const offeredAs = (kind: IntakeAction['kind']): IntakeAction['kind'] => (kind === 'decline' ? 'approve' : kind);

const numberOf = (url: string): number => Number(url.slice(url.lastIndexOf('/') + 1));

/** Assign to me, Release claim or Take off the backburner on GitHub, with its event once GitHub took it; a string: refused now. */
function gitHubWrite(c: IntakeActionContext, kind: IntakeAction['kind'], repo: string, key: string): (() => Promise<void>) | string {
  const n = numberOf(key);
  if (kind === 'assign') {
    const assignee = c.assignee;
    if (!assignee) return NO_ACCOUNT;
    return async () => {
      await c.api.addAssignees(repo, n, [assignee]);
      c.intake?.record('source.issues_assigned', { source: c.source, keys: [key], assignee });
    };
  }
  if (kind === 'unbackburner') {
    return async () => {
      await c.api.removeLabels(repo, n, [LABEL_BACKBURNER]);
      c.intake?.record('source.backburner_lifted', { source: c.source, key });
    };
  }
  const holders = (c.listedLabels.get(key) ?? []).filter((l) => l.startsWith(HOLDER_PREFIX));
  return async () => {
    await c.api.removeLabels(repo, n, [LABEL_CLAIMED, ...holders]);
    c.intake?.record('source.claim_released', { source: c.source, key, by: 'user', reason: 'released in Sources' });
  };
}

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
        // A reopened card (issue #1126): the approve takes `hopper:done` off, after it (issue #1194), so the sync takes it again.
        if (!await c.approve(x.repo, key, x.request, a)) { failed[key] = TEXT_CHANGED_SINCE_SHOWN; continue; }
      } else if (a.kind === 'decline') {
        // Only the text the person read, as the last sync showed it. Nothing on GitHub.
        if (!x.request || x.request.hash !== a.hash) { failed[key] = TEXT_CHANGED_SINCE_SHOWN; continue; }
        c.trust.decline(c.source, key, x.request, a.acting);
      } else if (!c.writeBehind.sent(a.kind, key)) {
        const write = gitHubWrite(c, a.kind, x.repo, key);
        if (typeof write === 'string') { failed[key] = write; continue; }
        c.writeBehind.run(a.kind, key, write);
      }
      done.push(key);
    } catch (err) {
      failed[key] = (err as Error).message;
    }
  }
  return { done, failed };
}
