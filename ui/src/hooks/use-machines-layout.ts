// The Machines page's layout (issue #2352): Cards or List, and its collapsed sections, remembered per browser like the
// nav groups. Storage blocked: the choice holds for this tab only.
import { useSyncExternalStore } from 'react';
import { parseMachinesMode, type MachinesMode } from '@/model/machine-list';
import { parseCollapsed, toggleCollapsed } from '@/model/nav-groups';

const MODE_KEY = 'jh_machines_mode';
const COLLAPSED_KEY = 'jh_machines_collapsed';
const listeners = new Set<() => void>();
const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage blocked: this tab only */ } };

let mode: MachinesMode = parseMachinesMode(read(MODE_KEY));
let collapsed: string[] = parseCollapsed(read(COLLAPSED_KEY));
const publish = () => { for (const l of listeners) l(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };

export function setMachinesMode(next: MachinesMode) {
  mode = next;
  write(MODE_KEY, next);
  publish();
}

export function toggleMachinesSection(id: string) {
  collapsed = toggleCollapsed(collapsed, id);
  write(COLLAPSED_KEY, JSON.stringify(collapsed));
  publish();
}

export const useMachinesMode = (): MachinesMode => useSyncExternalStore(subscribe, () => mode);
export const useMachinesCollapsed = (): string[] => useSyncExternalStore(subscribe, () => collapsed);
