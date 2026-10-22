// GitLab's labels through the outbox (issue #1892 part 17, design.md "GitLab's labels through the outbox"): the GitLab
// source keeps its follow's and its report's label changes as rows of the user's outbox, under its own source name, as the
// GitHub source does (parts 14 and 15): act `follow` or `report`, tagged with the job and its end, and sends them in that
// pass. A write GitLab refuses for now waits its backoff, and the sync loop's flush sends it later, after a restart too;
// while GitLab refuses the token, the rows wait for a new one with no attempt counted. Only label rows are GitLab's.
import { SourceError } from '../domain/ports.ts';
import type { GitHubOutbox, OutboxSend } from '../sources/github/outbox.ts';
import type { LabelSink } from '../sources/github/report.ts';
import type { GitLabAccount } from './account.ts';
import { GitLabNotFound } from './api.ts';

/** An issue's number in its project, from its URL (`…/-/issues/N`). */
const iidOf = (key: string): number => Number(key.slice(key.lastIndexOf('/') + 1));

/** Each coalesced label change on the GitLab issue, through the account; GitLab not finding the issue is permanent. */
export function gitlabOutboxSend(account: Pick<GitLabAccount, 'act'>): OutboxSend {
  return async (project, key, change) => {
    if (change.op !== 'add_labels' && change.op !== 'remove_labels') throw new SourceError(`${change.op} is not a GitLab write`, true);
    const iid = iidOf(key);
    if (!Number.isInteger(iid) || iid <= 0) throw new SourceError(`${key} is not a GitLab issue's URL`, true);
    const edit = change.op === 'add_labels' ? { add: change.labels, remove: [] } : { add: [], remove: change.labels };
    try {
      await account.act((a) => a.editLabels(project, iid, edit));
    } catch (err) {
      if (err instanceof GitLabNotFound) throw new SourceError(err.message, true, 404);
      throw new SourceError((err as Error).message, false);
    }
  };
}

/** A follow's or a report's label change: outbox rows, once per tag, sent in its own pass. Rows tagged `replaces` not sent yet go. */
export const gitlabLabelRows = (outbox: GitHubOutbox, send: OutboxSend) => (act: 'follow' | 'report'): LabelSink => async (key, project, change, tag, replaces) => {
  if (replaces !== undefined) outbox.drop(act, key, replaces);
  if (!change.add.length && !change.remove.length) return;
  if (outbox.sent(act, key, tag)) return;
  outbox.queue(act, key, project, [
    ...(change.remove.length ? [{ change: { op: 'remove_labels' as const, labels: change.remove } }] : []),
    ...(change.add.length ? [{ change: { op: 'add_labels' as const, labels: change.add } }] : []),
  ], { tag });
  await outbox.sendOf(act, key, send);
};
