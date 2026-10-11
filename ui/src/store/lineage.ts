// Issue lineage in the store (issue #729): the `job.child_issue_filed` events, read when the stream opens and again on
// each new one (debounced), folded into links (model/lineage.ts). A read that fails keeps the links the page has.
import { create } from 'zustand';
import { get } from '@/lib/api';
import { lineageLinks, type LineageLink } from '@/model/lineage';
import type { DomainEvent } from '@/model/wire';

export const useLineage = create<{ links: LineageLink[] }>(() => ({ links: [] }));

export async function refreshLineage(): Promise<void> {
  try {
    const { events } = await get<{ events: DomainEvent[] }>('/api/events?limit=5000&types=job.child_issue_filed');
    useLineage.setState({ links: lineageLinks(events) });
  } catch { /* keeps what it has; the next event or reconnect reads again */ }
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** Debounced: a burst of events costs one read. */
export function refreshLineageSoon(): void {
  clearTimeout(soon);
  soon = setTimeout(() => { void refreshLineage(); }, 150);
}
