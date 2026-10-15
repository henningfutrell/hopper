// Approve on a request card (issues #652, #1194), apart from source.ts for its size. Only when `hash` is the hash of the
// text the last sync showed, that text is the item's approved snapshot, recorded at once: the issue is not read again —
// the person approves what they read, and an edit since shows the card again at the sync. Its GitHub work is rows in the
// GitHub outbox (`outbox.ts`, issue #1238), kept in the transaction of the approval and sent after the answer: the
// assignee's comments the job would see, read and added to the snapshot (`readComments`), and on a reopened card
// (issue #1126) `hopper:done` taken off the issue, so the sync takes it again. A discover does not take the issue while
// they are not sent; one that failed shows until Approve again goes through. An Approve again of the same text before a
// discover listed the issue taken (a second click, another tab) is done, and records nothing more: one approval, one job.
import type { IntakeAction, IntakeTrust } from '../../domain/intake.ts';
import type { IntakeRequest } from '../../domain/intake-origin.ts';
import type { OutboxChange } from '../../domain/github-outbox.ts';
import type { GitHubApi } from './api.ts';
import { contextComments } from './context.ts';
import type { GitHubOutbox } from './outbox.ts';
import type { BotLogin } from './identity.ts';
import { LABEL_DONE } from './labels.ts';

export interface ApprovalsContext {
  source: string;
  api: GitHubApi;
  trust: Pick<IntakeTrust, 'approve' | 'approvedComments'>;
  /** The source's `recentComments`: 0 reads none. */
  recentComments: number;
  assignee(): string | undefined;
  botLogin(): Promise<BotLogin>;
  outbox: GitHubOutbox;
}

const numberOf = (url: string): number => Number(url.slice(url.lastIndexOf('/') + 1));

export function createApprovals(c: ApprovalsContext) {
  return {
    /** False: `hash` is not the hash of the text the last sync showed. */
    approve(repo: string, key: string, request: IntakeRequest | undefined, a: IntakeAction): boolean {
      if (!request || request.hash !== a.hash) return false;
      if (c.outbox.sent('approve', key, a.hash)) return true;
      const changes: { change: OutboxChange }[] = [];
      if (request.reopened) changes.push({ change: { op: 'remove_labels', labels: [LABEL_DONE] } });
      if (c.recentComments > 0) changes.push({ change: { op: 'read_comments' } });
      c.outbox.queue('approve', key, repo, changes, {
        tag: a.hash,
        local: () => c.trust.approve(c.source, key, { title: request.title, body: request.body, comments: [] }, request, a.acting),
      });
      return true;
    },
    /** The outbox's `read_comments`: the assignee's comments the job would see, added to the approved snapshot. */
    async readComments(repo: string, key: string): Promise<void> {
      const seen = contextComments(await c.api.listComments(repo, numberOf(key)), c.assignee(), c.recentComments, await c.botLogin());
      c.trust.approvedComments(key, seen.map((x) => ({ author: x.author, at: x.createdAt, body: x.body })));
    },
  };
}
