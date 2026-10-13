// The dashboard layout (model/dashboard-layout.ts), remembered per browser like the theme. Storage
// blocked: the layout holds for this tab only.
import { useSyncExternalStore } from 'react';
import { DEFAULT_LAYOUT, parseLayout, type DashboardLayout } from '@/model/dashboard-layout';

const KEY = 'jh_overview'; // the view's name before it was the Dashboard (issue #951): kept, so a stored layout still loads
const listeners = new Set<() => void>();

const stored = (): DashboardLayout => { try { return parseLayout(localStorage.getItem(KEY)); } catch { return DEFAULT_LAYOUT; } };
let layout: DashboardLayout = stored();

function publish(next: DashboardLayout) {
  layout = next;
  for (const l of listeners) l();
}

export function setDashboardLayout(next: DashboardLayout) {
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked: this tab only */ }
  publish(next);
}

/** Back to the default layout; the browser forgets the stored one. */
export function resetDashboardLayout() {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked: this tab only */ }
  publish(DEFAULT_LAYOUT);
}

export const useDashboardLayout = (): DashboardLayout => useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => layout);
