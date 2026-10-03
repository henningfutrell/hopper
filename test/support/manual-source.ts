// A JobSource a test scripts by hand: items it offers, signals it raises, reports it receives.
// Integration tests pull every non-GitHub job through it (nothing pushes jobs to the hopper).
import type { JobSource, SourceItem, SourceReport, SourceSignal } from '../../src/domain/ports.ts';

export interface ManualSource extends JobSource {
  /** Offer an item from the next sync on (replaces one with the same key). */
  add(item: SourceItem): void;
  remove(key: string): void;
  /** Raise a signal on the next sync's check. */
  signal(s: SourceSignal): void;
  readonly reports: SourceReport[];
}

let counter = 0;

export function manualItem(o: Partial<SourceItem> = {}): SourceItem {
  const key = o.key ?? `manual:${++counter}:${Date.now()}`;
  return {
    key, url: `https://example.invalid/${encodeURIComponent(key)}`, title: `item ${key}`, body: 'body', prompt: 'prompt',
    env: {}, author: 'owner', priority: 50, priorityReason: 'default', cwd: '/tmp', labels: [],
    executor: 'scripted', ...o,
  };
}

export function createManualSource(name = 'manual'): ManualSource {
  const items = new Map<string, SourceItem>();
  let signals: SourceSignal[] = [];
  const reports: SourceReport[] = [];
  return {
    name,
    kind: 'manual',
    reports,
    describe: () => ({ items: items.size }),
    add(item) { items.set(item.key, item); },
    remove(key) { items.delete(key); },
    signal(s) { signals.push(s); },
    async discover() { return [...items.values()]; },
    async check(active) {
      const ids = new Set(active.map((j) => j.id));
      const mine = signals.filter((s) => ids.has(s.jobId));
      signals = signals.filter((s) => !ids.has(s.jobId));
      return mine;
    },
    async report(r) {
      reports.push(r);
      const prev = (r.job.sourceState?.source?.reported as string[] | undefined) ?? [];
      return { ...(r.job.sourceState?.source ?? {}), reported: [...prev, r.kind] };
    },
  };
}
