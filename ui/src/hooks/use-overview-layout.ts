// The overview layout (model/overview-layout.ts), remembered per browser like the theme. Storage
// blocked: the layout holds for this tab only.
import { useSyncExternalStore } from 'react';
import { DEFAULT_LAYOUT, parseLayout, type OverviewLayout } from '@/model/overview-layout';

const KEY = 'jh_overview';
const listeners = new Set<() => void>();

const stored = (): OverviewLayout => { try { return parseLayout(localStorage.getItem(KEY)); } catch { return DEFAULT_LAYOUT; } };
let layout: OverviewLayout = stored();

function publish(next: OverviewLayout) {
  layout = next;
  for (const l of listeners) l();
}

export function setOverviewLayout(next: OverviewLayout) {
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked: this tab only */ }
  publish(next);
}

/** Back to the default layout; the browser forgets the stored one. */
export function resetOverviewLayout() {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked: this tab only */ }
  publish(DEFAULT_LAYOUT);
}

export const useOverviewLayout = (): OverviewLayout => useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => layout);
