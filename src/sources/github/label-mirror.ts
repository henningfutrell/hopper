// The label mirror of one source (issues #1891, #1933, design.md "The item lifecycle"): at each discover, the end labels of
// every issue listed are compared with what its work item's state wants (`labelDrift`, item-labels.ts). It reads only what
// the discover already listed, and the ledger: no call of its own. A drift is logged once and counted. It is corrected:
// the labels change through the GitHub outbox (act `mirror`, tagged with the state), coalesced, once, so `hopper:pr-ready`
// comes off an item the item reconciler blocked, an end label comes off an item a job works, and PR open gets its waiting
// label. A drift whose act went through and that the next discover still lists is only logged. An item that moved in the
// last moments, or that has outbox rows not sent, is not judged: the move's own writes are on their way. The source passes
// no issue its discover takes as a new job (issue #1954): that job moves the item.
import { RECONCILE_GRACE_MS } from '../../domain/item-lifecycle.ts';
import type { WorkItem } from '../../domain/work-items.ts';
import { labelCorrected, labelDriftSeen } from '../../telemetry/sources.ts';
import type { GitHubIssue } from './api.ts';
import { driftWords, labelDrift } from './item-labels.ts';
import type { GitHubOutbox } from './outbox.ts';

export interface LabelMirror {
  /** Compare the issues a discover listed with their work items; answers how many items got outbox rows. */
  check(listed: readonly Pick<GitHubIssue, 'url' | 'repo' | 'labels'>[]): number;
}

export function createLabelMirror(o: {
  source: string;
  outbox: Pick<GitHubOutbox, 'queue' | 'held' | 'sent'>;
  /** The work item of an issue, by its URL. */
  item(key: string): WorkItem | undefined;
  /** Whether an item's open pull request is a part, by its URL: PR open's waiting label is then `hopper:partly-done`. */
  part(key: string): boolean;
  now(): string;
  log(line: string): void;
}): LabelMirror {
  /** The drift each item was last logged with: a drift is logged and counted once, until it changes or ends. */
  const logged = new Map<string, string>();
  return {
    check(listed) {
      let corrected = 0;
      const settledBefore = Date.parse(o.now()) - RECONCILE_GRACE_MS;
      const listedKeys = new Set(listed.map((i) => i.url));
      for (const key of [...logged.keys()]) if (!listedKeys.has(key)) logged.delete(key);
      for (const issue of listed) {
        const item = o.item(issue.url);
        if (!item || Date.parse(item.eventAt) > settledBefore || o.outbox.held(issue.url)) continue;
        const d = labelDrift(item, issue.labels, item.state === 'pr_open' ? { part: o.part(issue.url) } : {});
        if (!d) { logged.delete(issue.url); continue; }
        const words = driftWords(item, d);
        const tag = `${item.state}:${item.blockedCause ?? ''}`;
        const fix = !o.outbox.sent('mirror', issue.url, tag);
        if (logged.get(issue.url) !== words) {
          logged.set(issue.url, words);
          labelDriftSeen(o.source, item.state, fix);
          o.log(`hopper: ${o.source}: the labels of ${issue.url} differ from its work item, ${words}${fix ? ': corrected through the outbox' : ''}`);
        }
        if (!fix) continue;
        o.outbox.queue('mirror', issue.url, issue.repo, [
          ...(d.remove.length ? [{ change: { op: 'remove_labels' as const, labels: d.remove } }] : []),
          ...(d.add.length ? [{ change: { op: 'add_labels' as const, labels: d.add } }] : []),
        ], { tag });
        labelCorrected(o.source, item.state);
        corrected += 1;
      }
      return corrected;
    },
  };
}
