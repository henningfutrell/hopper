// The collapsed nav groups (model/nav-groups.ts, issue #906), remembered per browser like the dismissed notices. One
// list for the sidebar and the mobile drawer. Storage blocked: the groups hold for this tab only.
import { useSyncExternalStore } from 'react';
import { parseCollapsed, toggleCollapsed } from '@/model/nav-groups';

const KEY = 'jh_nav_collapsed';
const listeners = new Set<() => void>();

const stored = (): string[] => { try { return parseCollapsed(localStorage.getItem(KEY)); } catch { return []; } };
let collapsed: string[] = stored();

export function toggleNavGroup(id: string) {
  collapsed = toggleCollapsed(collapsed, id);
  try { localStorage.setItem(KEY, JSON.stringify(collapsed)); } catch { /* storage blocked: this tab only */ }
  for (const l of listeners) l();
}

export const useNavCollapsed = (): string[] => useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => collapsed);
