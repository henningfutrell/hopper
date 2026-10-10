// A JobSource a test scripts by hand: items it offers, signals it raises, reports it receives.
// Integration tests pull every non-GitHub job through it (nothing pushes jobs to the hopper).
// Like the GitHub source's markers (hopper:done, hopper:failed, hopper:rejected), a reported finished, failed or rejected end
// stops the item being offered; add it again to re-run it, or run its job again (`rerun` offers it again and answers it).
// A hand-off's resolution (issue #551) is kept in `resolutions`.
import type { JobSource, SourceItem, SourceReport, SourceSignal } from '../../src/domain/ports.ts';
import type { HandoffResolution } from '../../src/domain/types.ts';

export interface ManualSource extends JobSource {
  /** Offer an item from the next sync on (replaces one with the same key). */
  add(item: SourceItem): void;
  remove(key: string): void;
  /** Raise a signal on the next sync's check. */
  signal(s: SourceSignal): void;
  /** Close the item at the source, as an issue closed on GitHub (issue #529): `itemClosed` answers true. */
  close(key: string): void;
  readonly reports: SourceReport[];
  /** The hand-off resolutions it was told (issue #551), in order. */
  readonly resolutions: { jobId: string; resolution: HandoffResolution }[];
  /** A pull request of the item's own job is open (issue #630): `pullRequestOpen` answers true. */
  openPullRequest(key: string): void;
  /** From now on `pullRequestOpen` fails, as a source that is down. */
  failPullRequestLookups(): void;
}

let counter = 0;

export function manualItem(o: Partial<SourceItem> = {}): SourceItem {
  const key = o.key ?? `manual:${++counter}:${Date.now()}`;
  return {
    key, url: `https://example.invalid/${encodeURIComponent(key)}`, title: `item ${key}`, body: 'body', prompt: 'prompt',
    env: {}, author: 'owner', priority: 50, priorityReason: 'default', labels: [],
    executor: 'scripted', ...o,
  };
}

export function createManualSource(name = 'manual'): ManualSource {
  const items = new Map<string, SourceItem>();
  const ended = new Map<string, SourceItem>();
  const closed = new Set<string>();
  const pullRequests = new Set<string>();
  let lookupsFail = false;
  let signals: SourceSignal[] = [];
  const reports: SourceReport[] = [];
  const resolutions: { jobId: string; resolution: HandoffResolution }[] = [];
  return {
    name,
    kind: 'manual',
    reports,
    resolutions,
    async resolved(job, resolution) { resolutions.push({ jobId: job.id, resolution }); },
    describe: () => ({ items: items.size }),
    add(item) { items.set(item.key, item); },
    remove(key) { items.delete(key); },
    signal(s) { signals.push(s); },
    close(key) { closed.add(key); items.delete(key); },
    async itemClosed(job) { return closed.has(job.source!.key); },
    openPullRequest(key) { pullRequests.add(key); },
    failPullRequestLookups() { lookupsFail = true; },
    async pullRequestOpen(job) {
      if (lookupsFail) throw new Error('the source is down');
      return pullRequests.has(job.source!.key);
    },
    async discover() { return [...items.values()]; },
    async check(active) {
      const ids = new Set(active.map((j) => j.id));
      const mine = signals.filter((s) => ids.has(s.jobId));
      signals = signals.filter((s) => !ids.has(s.jobId));
      return mine;
    },
    async rerun(job) {
      const key = job.source!.key;
      const item = ended.get(key) ?? items.get(key);
      if (!item) throw new Error(`no item ${key}`);
      items.set(key, item);
      return item;
    },
    async report(r) {
      reports.push(r);
      const key = r.job.source!.key;
      if (r.kind === 'finished' || r.kind === 'failed' || r.kind === 'rejected') {
        const item = items.get(key);
        if (item) ended.set(key, item);
        items.delete(key);
      }
      const prev = (r.job.sourceState?.source?.reported as string[] | undefined) ?? [];
      return { ...(r.job.sourceState?.source ?? {}), reported: [...prev, r.kind] };
    },
  };
}
