// Approve on a request card (issues #652, #1194), apart from source.ts for its size. Only when `hash` is the hash of the
// text the last sync showed, that text is the item's approved snapshot, recorded at once: the issue is not read again —
// the person approves what they read, and an edit since shows the card again at the sync. Its GitHub work is rows in the
// GitHub outbox (`outbox.ts`, issue #1238), kept in the transaction of the approval and sent after the answer: the
// assignee's comments the job would see, read and added to the snapshot (`readComments`), and on a reopened card
// (issue #1126) `hopper:done` taken off the issue, so the sync takes it again. A discover does not take the issue while
// they are not sent; one that failed shows until Approve again goes through. An Approve again of the same text before a
// discover listed the issue taken (a second click, another tab) is done, and records nothing more: one approval, one job.
// An auto-approval (issue #1268) is the same approval, by the hopper: recorded at the sync that found it, its rows the
// same, so a sync after they are sent takes the item.
// Approve takes at the first click (issue #1316): the card leaves Intake in the answer (`on`). A sync that read the item
// before the approval, and lists the card again, does not bring it back; a sync that lists the item otherwise ends that
// (`listed`). Approve on an item the last sync does not list with that text — no sync since a restart, or a read older
// than the page — is resolved again (`resolve`): the issue is read now, and approved while it is a request card of that text.
// For an item the ledger holds (issue #1892), its state says whether it is a card, not the end labels on its issue: a card
// with `hopper:done` left on (the label mirror takes it off) is approved, an item in another state is not shown. The end
// labels decide only for an item the hopper does not know.
import type { IntakeAction, IntakeOutcome, IntakeTrust } from '../../domain/intake.ts';
import { requestHash, type IntakeRequest } from '../../domain/intake-origin.ts';
import type { AutoApproval } from '../../domain/intake-auto-approve.ts';
import { autoApprovals, cardsOf } from './auto-approve.ts';
import type { OutboxChange } from '../../domain/github-outbox.ts';
import type { WorkItem } from '../../domain/work-items.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import { contextComments } from './context.ts';
import type { GitHubOutbox } from './outbox.ts';
import { LABEL_CLAIMED, LABEL_DONE } from './labels.ts';
import { originsOf } from './origin.ts';
import { ALREADY_TAKEN, DECLINED, HAS_JOB, NOT_SHOWN, TEXT_CHANGED_SINCE_SHOWN } from './intake-actions.ts';

export interface ApprovalsContext {
  source: string;
  api: GitHubApi;
  trust: IntakeTrust;
  /** The source's `recentComments`: 0 reads none. */
  recentComments: number;
  assignee(): string | undefined;
  outbox: GitHubOutbox;
  /** The source's label: an issue resolved again still has it. */
  label: string;
  /** The job repositories the source scans: an issue resolved again is in one. */
  scope(): readonly string[];
  /** Whether the item has a job here: it is never resolved again, so its snapshot stays its job's. */
  known(key: string): boolean;
  /** The item's work item in the ledger, when it holds one: its state, not the end labels, says whether it is a card. */
  item?(key: string): WorkItem | undefined;
}

/** What Approve resolved again (`resolve`) did: `approved`, `done` (its text was approved before), or why not. */
export type Resolved = 'approved' | 'done' | (string & {});


const numberOf = (url: string): number => Number(url.slice(url.lastIndexOf('/') + 1));

export function createApprovals(c: ApprovalsContext) {
  /** An approval's rows, kept with `local`, its record, in one transaction; nothing when the same text's are on their way. */
  const queue = (repo: string, key: string, request: IntakeRequest, local: () => void): void => {
    if (c.outbox.sent('approve', key, request.hash)) return;
    const changes: { change: OutboxChange }[] = [];
    if (request.reopened) changes.push({ change: { op: 'remove_labels', labels: [LABEL_DONE] } });
    if (c.recentComments > 0) changes.push({ change: { op: 'read_comments' } });
    c.outbox.queue('approve', key, repo, changes, { tag: request.hash, local });
  };
  const text = (r: IntakeRequest) => ({ title: r.title, body: r.body, comments: [] });
  /** The cards approved here that no sync since listed otherwise: key → the hash approved. */
  const fresh = new Map<string, string>();
  const isFresh = (x: IntakeOutcome): boolean => x.action === 'approve' && x.request !== undefined && fresh.get(x.key) === x.request.hash;

  const approve = (repo: string, key: string, request: IntakeRequest | undefined, a: IntakeAction): boolean => {
    if (!request || request.hash !== a.hash) return false;
    queue(repo, key, request, () => c.trust.approve(c.source, key, text(request), request, a.acting));
    fresh.set(key, request.hash);
    return true;
  };

  return {
    /** False: `hash` is not the hash of the text the last sync showed. */
    approve,
    /** The outcomes with each card approved here taken, as a discover lists an approved item it takes. */
    on: (xs: readonly IntakeOutcome[]): IntakeOutcome[] => xs.map((x) => {
      if (!isFresh(x)) return x;
      const { reason: _reason, action: _action, group: _group, request: _request, ...taken } = x;
      return taken;
    }),
    /** At a discover's end: an approval whose card it lists no more is the sync's now. */
    listed(xs: readonly IntakeOutcome[]): void {
      for (const key of [...fresh.keys()]) if (!xs.some((x) => x.key === key && isFresh(x))) fresh.delete(key);
    },
    /**
     * Approve resolved again: the issue `key` read now, and approved when it is still a request card of this source with
     * the text `a.hash` names — open, labelled, assigned to the user, not claimed, not reopened (its card needs the sync's
     * history), no job here, not declined, its origin not trusted. For an item the ledger holds, its state decides in place of
     * `hopper:done`: a request card is one, any other state is not.
     */
    async resolve(key: string, a: IntakeAction): Promise<Resolved> {
      const at = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(key);
      const repo = at ? c.scope().find((r) => r.toLowerCase() === at[1]!.toLowerCase()) : undefined;
      const assignee = c.assignee();
      if (!at || !repo || !assignee || !a.hash) return NOT_SHOWN;
      if (c.known(key)) return HAS_JOB;
      const issue = await c.api.getIssue(repo, Number(at[2]));
      const assigned = issue.assignees.some((x) => x.toLowerCase() === assignee.toLowerCase());
      const item = c.item?.(key);
      const ended = item === undefined && issue.labels.includes(LABEL_DONE);
      if (issue.state !== 'open' || !issue.labels.includes(c.label) || !assigned || issue.labels.includes(LABEL_CLAIMED) || ended) return NOT_SHOWN;
      if (requestHash(issue) !== a.hash) return TEXT_CHANGED_SINCE_SHOWN;
      if (c.trust.declined(key, a.hash)) return DECLINED;
      if (item !== undefined && item.state !== 'waiting_for_approval') return NOT_SHOWN;
      const v = (await originsOf(c.api, c.trust, [issue], c.label, assignee)).get(key);
      if (!v || !('request' in v)) return v?.origin === 'approved' ? 'done' : ALREADY_TAKEN;
      return approve(repo, key, v.request, a) ? 'approved' : TEXT_CHANGED_SINCE_SHOWN;
    },
    /**
     * The cards of `requests` a rule approves (issue #1268), each recorded as the hopper's approval with Approve's rows, and
     * taken out of `requests`: no card, and a sync after the rows are sent takes the item. `issues`: the sync's, read or listed.
     */
    async auto(requests: Map<string, IntakeRequest>, issues: readonly GitHubIssue[]): Promise<Map<string, AutoApproval>> {
      const cards = cardsOf(requests, issues);
      const found = c.trust.autoApprove ? await autoApprovals(c.api, c.trust, cards, c.assignee() ?? '') : new Map<string, AutoApproval>();
      for (const { issue, request } of cards) {
        const approval = found.get(issue.url);
        if (approval) queue(issue.repo, issue.url, request, () => c.trust.autoApprove!(c.source, issue.url, text(request), request, approval));
      }
      for (const key of found.keys()) requests.delete(key);
      return found;
    },
    /** The outbox's `read_comments`: the assignee's comments the job would see, added to the approved snapshot. */
    async readComments(repo: string, key: string): Promise<void> {
      const seen = contextComments(await c.api.listComments(repo, numberOf(key)), c.assignee(), c.recentComments);
      c.trust.approvedComments(key, seen.map((x) => ({ author: x.author, at: x.createdAt, body: x.body })));
    },
  };
}
