// The label mirror of one source (issues #1891, #1933, design.md "The item lifecycle"): at each discover, the end labels of
// every issue listed are compared with what its work item's state wants (`labelDrift`, item-labels.ts). It reads only what
// the discover already listed, and the ledger: no call of its own. A drift is logged once and counted. It is corrected:
// the labels change through the GitHub outbox (act `mirror`, tagged with the state), coalesced, once, so `hopper:pr-ready`
// comes off an item the item reconciler blocked, an end label comes off an item a job works, PR open gets its waiting
// label, a failed item whose failure was reported as failed gets `hopper:failed` (`failureReported`, issue #1892), one told as one the hopper fixes itself loses its end labels (`fixingReported`, part 31), one whose report waits loses every end label but `hopper:failed` (`failureReportWaits`, part 32), a partly done item with parts left loses its end labels (`partsLeft`), and so does an item whose job waits on a person; a hand-off whose failure was reported gets `hopper:failed`, and so does an item the dismiss of its failed job dropped (part 20), an item a person's Close PR or the hopper's own close dropped gets `hopper:pr-closed` (parts 21, 22), an item a person dropped by Won't do gets `hopper:rejected`, and one they did by hand (Done on its hand-off) `hopper:done`, as does a done item whose job's report found its issue closed as complete (`doneReported`, part 24); one whose report found it open gets what that report put on (part 28). A drift whose act went through and that the next discover still lists is only logged. An item that moved in the
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
// counts too. An end label a person put on a request card by hand (`labelPutOn`), not seen then and on now, is their withdraw of
// the card: `source.request_withdrawn` with the label, once. Its item is dropped, so the labels decide Intake's reason, and the
// label stays. One put on an item a cancelled or rejected job dropped (part 19) keeps the issue out: `work_item.label_edited`
// with `means: keep_out`, once. The item carries that label from then, which decides Intake's reason; taken off, it is a Run again.
//
// On several hoppers on one database (issue #1892), only the holder of the source's mirror lease judges: it corrects and
// records. Another (`edits` with `judge` false) records nothing and corrects nothing, and keeps seeing an issue a person
// edited as it was before the edit, so it records the edit itself when it takes the lease before the holder recorded it.
//
// Kill points (issue #1892, the crash harness): once a correction's rows are queued, and once a label edit is recorded. A
// hopper killed there leaves the rows or the event to the next hopper, which does not queue or record them again.
import { RECONCILE_GRACE_MS } from '../../domain/item-lifecycle.ts';
import type { WorkItem } from '../../domain/work-items.ts';
import { killPoint } from '../../sagas/kill-points.ts';
import { labelCorrected, labelDriftSeen } from '../../telemetry/sources.ts';
import type { GitHubIssue } from './api.ts';
import { driftWords, labelDrift, labelPutOn, labelTakenOff, type DoneReport, type DropReport, type LabelFacts } from './item-labels.ts';
import type { GitHubOutbox } from './outbox.ts';

/** A kill point of the mirror: after a correction's rows are queued, or after a label edit is recorded. */
export const mirrorKillPoint = (kind: 'correct' | 'edit', at: 'after-queue' | 'after-record'): string => `mirror:${kind}:${at}`;

export interface LabelMirror {
  /** Compare the issues a discover listed with their work items; answers how many items got outbox rows. */
  check(listed: readonly Pick<GitHubIssue, 'url' | 'repo' | 'labels'>[]): number;
  /**
   * Find the end labels a person took off or put on by hand since the last discover, and record each (issue #1892): the URLs
   * of the issues whose label taken off is a Run again.
   * With `judge` false (another hopper holds the mirror's lease), nothing is recorded, and an issue edited is still seen as before.
   */
  edits(listed: readonly Pick<GitHubIssue, 'url' | 'labels'>[], judge?: boolean): Set<string>;
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
  /** Whether a failed item's failure was reported as one the hopper fixes itself (issue #1892 part 31): no end label is then its labels. */
  fixingReported?(key: string): boolean;
  /** Whether a failed item's failure is not reported yet (issue #1892 part 32): `hopper:failed` or no end label is then its labels. */
  failureReportWaits?(key: string): boolean;
  /** Whether a partly done item's merged part leaves parts to run (issue #1892): only then is no end label its labels. */
  partsLeft?(key: string): boolean;
  /** What a dropped item's cancelled or rejected job's report left (issue #1892 parts 19, 23): only once reported is it judged. */
  dropReported?(key: string): DropReport | undefined;
  /** What a done item's job's final report put on (issue #1892 parts 24, 28): only then is a done a job's end made judged. */
  doneReported?(key: string): DoneReport | undefined;
  /**
   * When the listing of a repository was read (issue #1892): a correction any hopper sent after it is not queued again, as
   * that listing may not show it. Absent: only this hopper's own sends count.
   */
  listedAt?(repo: string): string | undefined;
  /** Whether the item is given back now or was moments ago (issue #1892): it is not judged, the new job moves it. */
  busy?(key: string): boolean;
  now(): string;
  log(line: string): void;
  /** Record a person's label edit (`work_item.label_edited`: a Run again, or a label put on that keeps a dropped item out), or a card's withdraw by a label put on (`source.request_withdrawn`); absent: none is recorded. */
  record?(type: 'work_item.label_edited' | 'source.request_withdrawn', data: Record<string, unknown>): void;
}): LabelMirror {
  /** The drift each item was last logged with: a drift is logged and counted once, until it changes or ends. */
  const logged = new Map<string, string>();
  /** The labels each listed issue had at the last discover, and when it was. */
  const seen = new Map<string, { labels: string[]; at: string }>();
  /** The issues whose label edit the last `edits` found: not judged in the same discover. Of them, the Run agains (`edits` answers those). */
  let edited = new Set<string>(); let runAgain = new Set<string>();
  /** What the item's labels are judged by besides its state: asked only for the state that needs it. */
  const facts = (key: string, item: WorkItem): LabelFacts =>
    item.state === 'pr_open' ? { part: o.part(key) } : item.state === 'failed' ? { failureReported: o.failureReported?.(key) ?? false, fixingReported: o.fixingReported?.(key) ?? false, failureReportWaits: o.failureReportWaits?.(key) ?? false }
      : item.state === 'needs_you' ? { failureReported: o.failureReported?.(key) ?? false }
      : item.state === 'partly_done' ? { partsLeft: o.partsLeft?.(key) ?? false } : item.state === 'done' ? { doneReported: o.doneReported?.(key) } : item.state === 'dropped'
        ? (item.dismissed === true ? { failureReported: o.failureReported?.(key) ?? false } : { dropReported: o.dropReported?.(key) }) : {};
  /** A person's label edit on the issue since `was`: an end label put on a request card, or the one its state wants taken off. */
  const editOf = (issue: Pick<GitHubIssue, 'url' | 'labels'>, was: { labels: string[]; at: string }, settledBefore: number): { item: WorkItem; put?: string; label?: string } | undefined => {
    const item = o.item(issue.url);
    if (!o.record || !item || item.runAgainAsked !== undefined || o.outbox.held(issue.url) || o.busy?.(issue.url)) return undefined;
    if (Date.parse(item.eventAt) > Math.min(Date.parse(was.at), settledBefore)) return undefined;
    const put = labelPutOn(item, was.labels, issue.labels, facts(issue.url, item));
    if (put !== undefined) return { item, put };
    const label = labelTakenOff(item, was.labels, issue.labels, facts(issue.url, item));
    return label === undefined ? undefined : { item, label };
  };
  return {
    start(listed, at) {
      for (const issue of listed) if (!seen.has(issue.url)) seen.set(issue.url, { labels: [...issue.labels], at });
    },
    edits(listed, judge = true) {
      const at = o.now();
      const settledBefore = Date.parse(at) - RECONCILE_GRACE_MS;
      const keys = new Set(listed.map((i) => i.url));
      for (const key of [...seen.keys()]) if (!keys.has(key)) seen.delete(key);
      edited = new Set(); runAgain = new Set();
      for (const issue of listed) {
        const was = seen.get(issue.url);
        const edit = was && editOf(issue, was, settledBefore);
        // A host that does not judge keeps what it saw of an edit: the holder records it, or this host once it takes the lease.
        if (edit && !judge) continue;
        seen.set(issue.url, { labels: [...issue.labels], at });
        if (!edit) continue;
        if (edit.put !== undefined && edit.item.state === 'dropped') {
          o.record!('work_item.label_edited', { source: o.source, key: issue.url, ...(edit.item.jobId !== undefined ? { jobId: edit.item.jobId } : {}), from: 'dropped', label: edit.put, means: 'keep_out' });
          killPoint(mirrorKillPoint('edit', 'after-record'));
          o.log(`hopper: ${o.source}: ${edit.put} was put on ${issue.url} by hand: it keeps its dropped work item out`);
          edited.add(issue.url);
          continue;
        }
        if (edit.put !== undefined) {
          o.record!('source.request_withdrawn', { source: o.source, key: issue.url, label: edit.put });
          o.log(`hopper: ${o.source}: ${edit.put} was put on ${issue.url} by hand: its request card is withdrawn`);
          continue;
        }
        const { item, label } = edit;
        o.record!('work_item.label_edited', { source: o.source, key: issue.url, ...(item.jobId !== undefined ? { jobId: item.jobId } : {}), from: item.state, label, means: 'run_again' });
        killPoint(mirrorKillPoint('edit', 'after-record'));
        o.log(`hopper: ${o.source}: ${label} was taken off ${issue.url} by hand: a Run again of its work item (${item.state})`);
        edited.add(issue.url); runAgain.add(issue.url);
      }
      return new Set(runAgain);
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
        const fix = !o.outbox.sent('mirror', issue.url, tag, o.listedAt?.(issue.repo));
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
        killPoint(mirrorKillPoint('correct', 'after-queue'));
        labelCorrected(o.source, item.state);
        corrected += 1;
      }
      return corrected;
    },
  };
}
