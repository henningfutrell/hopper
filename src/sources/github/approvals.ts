// Approve on a request card (issues #652, #1194), apart from source.ts for its size. Only when `hash` is the hash of the
// text the last sync showed, that text is the item's approved snapshot, recorded at once: the issue is not read again —
// the person approves what they read, and an edit since shows the card again at the sync. Its GitHub reads and writes run
// after the answer, not awaited: the assignee's comments the job would see, added to the snapshot, and on a reopened card
// (issue #1126) `hopper:done` taken off the issue, so the sync takes it again — its write-behind (`write-behind.ts`): the next
// discover waits for it, and one that failed shows until Approve again goes through. An Approve again of the same text
// before a discover listed the issue taken (a second click, another tab) is done, and records nothing more: one approval,
// one job.
import type { IntakeAction, IntakeTrust } from '../../domain/intake.ts';
import type { IntakeRequest } from '../../domain/intake-origin.ts';
import type { GitHubApi } from './api.ts';
import { contextComments } from './context.ts';
import type { WriteBehind } from './write-behind.ts';
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
  writeBehind: WriteBehind;
}

const numberOf = (url: string): number => Number(url.slice(url.lastIndexOf('/') + 1));

export function createApprovals(c: ApprovalsContext) {
  const writeBehind = async (repo: string, key: string, request: IntakeRequest): Promise<void> => {
    if (request.reopened) await c.api.removeLabels(repo, numberOf(key), [LABEL_DONE]);
    if (c.recentComments === 0) return;
    const seen = contextComments(await c.api.listComments(repo, numberOf(key)), c.assignee(), c.recentComments, await c.botLogin());
    c.trust.approvedComments(key, seen.map((x) => ({ author: x.author, at: x.createdAt, body: x.body })));
  };

  return {
    /** False: `hash` is not the hash of the text the last sync showed. */
    async approve(repo: string, key: string, request: IntakeRequest | undefined, a: IntakeAction): Promise<boolean> {
      if (!request || request.hash !== a.hash) return false;
      if (c.writeBehind.sent('approve', key, a.hash)) return true;
      c.trust.approve(c.source, key, { title: request.title, body: request.body, comments: [] }, request, a.acting);
      c.writeBehind.run('approve', key, () => writeBehind(repo, key, request), a.hash);
      return true;
    },
  };
}
