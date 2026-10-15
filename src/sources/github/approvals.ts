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
import type { IntakeAction, IntakeTrust } from '../../domain/intake.ts';
import type { IntakeRequest } from '../../domain/intake-origin.ts';
import type { AutoApproval } from '../../domain/intake-auto-approve.ts';
import { autoApprovals, cardsOf } from './auto-approve.ts';
import type { OutboxChange } from '../../domain/github-outbox.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import { contextComments } from './context.ts';
import type { GitHubOutbox } from './outbox.ts';
import type { BotLogin } from './identity.ts';
import { LABEL_DONE } from './labels.ts';

export interface ApprovalsContext {
  source: string;
  api: GitHubApi;
  trust: Pick<IntakeTrust, 'approve' | 'approvedComments' | 'trusted' | 'autoApproval' | 'autoApprove' | 'approvedText' | 'takenIn'>;
  /** The source's `recentComments`: 0 reads none. */
  recentComments: number;
  assignee(): string | undefined;
  botLogin(): Promise<BotLogin>;
  outbox: GitHubOutbox;
}

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

  return {
    /** False: `hash` is not the hash of the text the last sync showed. */
    approve(repo: string, key: string, request: IntakeRequest | undefined, a: IntakeAction): boolean {
      if (!request || request.hash !== a.hash) return false;
      queue(repo, key, request, () => c.trust.approve(c.source, key, text(request), request, a.acting));
      return true;
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
      const seen = contextComments(await c.api.listComments(repo, numberOf(key)), c.assignee(), c.recentComments, await c.botLogin());
      c.trust.approvedComments(key, seen.map((x) => ({ author: x.author, at: x.createdAt, body: x.body })));
    },
  };
}
