// The label mirror of one source (issues #1891, #1933, design.md "The item lifecycle"): at each discover, the end labels of
// every issue listed are compared with what its work item's state wants (`labelDrift`, item-labels.ts). It reads only what
// the discover already listed, and the ledger: no call of its own. A drift is logged once and counted. It is corrected:
// the labels change through the GitHub outbox (act `mirror`, tagged with the state), coalesced, once, so `hopper:pr-ready`
// comes off an item the item reconciler blocked, an end label comes off an item a job works, PR open gets its waiting
// label, a failed item whose failure was reported as failed gets `hopper:failed` (`failureReported`, issue #1892), a partly done item with parts left loses its end labels (`partsLeft`), and so does an item whose job waits on a person (not a hand-off). A drift whose act went through and that the next discover still lists is only logged. An item that moved in the
// last moments, that has outbox rows not sent, or that is given back now or was in the last moments (`busy`), is not judged:
// the move's own writes are on their way. The source passes no issue its discover takes as a new job (issue #1954): that job
// moves the item.
//
// A label edited by hand (issue #1892): before the discover judges Intake, the mirror compares each listed issue's labels with
// what it saw at its last discover (`edits`). The end label the item's state wants (`labelTakenOff`), seen then and gone now,
// with the item not moved since and no outbox row of its own not sent, is a person's Run again: `work_item.label_edited`, once.
// It is not put back, nor is the label of an item whose Run again is asked (`runAgainAsked`). A label not on the issue at its
// first sight is no edit. What the mirror saw is kept in memory; after a start the source gives it the listing cache's
// labels (`start`), kept in the database, as seen when that listing was read, so an edit made while the hopper was stopped
// counts too.
import { RECONCILE_GRACE_MS } from '../../domain/item-lifecycle.ts';
import type { WorkItem } from '../../domain/work-items.ts';
import { labelCorrected, labelDriftSeen } from '../../telemetry/sources.ts';
import type { GitHubIssue } from './api.ts';
import { driftWords, labelDrift, labelTakenOff, type LabelFacts } from './item-labels.ts';
import type { GitHubOutbox } from './outbox.ts';

export interface LabelMirror {
  /** Compare the issues a discover listed with their work items; answers how many items got outbox rows. */
  check(listed: readonly Pick<GitHubIssue, 'url' | 'repo' | 'labels'>[]): number;
  /** Find the end labels a person took off by hand since the last discover, and record each (issue #1892): their issues' URLs. */
  edits(listed: readonly Pick<GitHubIssue, 'url' | 'labels'>[]): Set<string>;
  /** After a start (issue #1892): what the last listing before it held, read at `at`. Only an issue not seen yet takes it. */
  start(listed: readonly Pick<GitHubIssue, 'url' | 'labels'>[], at: string): void;
}

export function createLabelMirror(o: {
  source: string;
  outbox: Pick<GitHubOutbox, 'queue' | 'held' | 'sent'>;
  /** The work item of an issue, by its URL. */
  item(key: string): WorkItem | undefined;
  /** Whether an item's open pull request is a part, by its URL: PR open's waiting label is then `hopper:partly-done`. */
  part(key: string): boolean;
  /** Whether a failed item's failure was reported to its issue as failed (issue #1892): only then is `hopper:failed` its label. */
  failureReported?(key: string): boolean;
  /** Whether a partly done item's merged part leaves parts to run (issue #1892): only then is no end label its labels. */
  partsLeft?(key: string): boolean;
  /** Whether the item is given back now or was moments ago (issue #1892): it is not judged, the new job moves it. */
  busy?(key: string): boolean;
  now(): string;
  log(line: string): void;
  /** Record a person's label edit (`work_item.label_edited`); absent: none is recorded. */
  record?(type: 'work_item.label_edited', data: Record<string, unknown>): void;
}): LabelMirror {
  /** The drift each item was last logged with: a drift is logged and counted once, until it changes or ends. */
  const logged = new Map<string, string>();
  /** The labels each listed issue had at the last discover, and when it was. */
  const seen = new Map<string, { labels: string[]; at: string }>();
  /** The issues whose label edit the last `edits` found: not judged in the same discover. */
  let edited = new Set<string>();
  /** What the item's labels are judged by besides its state: asked only for the state that needs it. */
  const facts = (key: string, item: WorkItem): LabelFacts =>
    item.state === 'pr_open' ? { part: o.part(key) } : item.state === 'failed' ? { failureReported: o.failureReported?.(key) ?? false }
      : item.state === 'partly_done' ? { partsLeft: o.partsLeft?.(key) ?? false } : {};
  return {
    start(listed, at) {
      for (const issue of listed) if (!seen.has(issue.url)) seen.set(issue.url, { labels: [...issue.labels], at });
    },
    edits(listed) {
      const at = o.now();
      const settledBefore = Date.parse(at) - RECONCILE_GRACE_MS;
      const keys = new Set(listed.map((i) => i.url));
      for (const key of [...seen.keys()]) if (!keys.has(key)) seen.delete(key);
      edited = new Set();
      for (const issue of listed) {
        const was = seen.get(issue.url);
        seen.set(issue.url, { labels: [...issue.labels], at });
        const item = o.item(issue.url);
        if (!was || !o.record || !item || item.runAgainAsked !== undefined || o.outbox.held(issue.url) || o.busy?.(issue.url)) continue;
        if (Date.parse(item.eventAt) > Math.min(Date.parse(was.at), settledBefore)) continue;
        const label = labelTakenOff(item, was.labels, issue.labels, facts(issue.url, item));
        if (label === undefined) continue;
        o.record('work_item.label_edited', { source: o.source, key: issue.url, ...(item.jobId !== undefined ? { jobId: item.jobId } : {}), from: item.state, label, means: 'run_again' });
        o.log(`hopper: ${o.source}: ${label} was taken off ${issue.url} by hand: a Run again of its work item (${item.state})`);
        edited.add(issue.url);
      }
      return new Set(edited);
    },
    check(listed) {
      let corrected = 0;
      const settledBefore = Date.parse(o.now()) - RECONCILE_GRACE_MS;
      const listedKeys = new Set(listed.map((i) => i.url));
      for (const key of [...logged.keys()]) if (!listedKeys.has(key)) logged.delete(key);
      for (const issue of listed) {
        const item = o.item(issue.url);
        if (!item || Date.parse(item.eventAt) > settledBefore || o.outbox.held(issue.url) || o.busy?.(issue.url) || item.runAgainAsked !== undefined || edited.has(issue.url)) continue;
        const d = labelDrift(item, issue.labels, facts(issue.url, item));
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
