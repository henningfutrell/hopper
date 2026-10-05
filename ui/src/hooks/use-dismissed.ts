// The dismissed notices (model/dismissed.ts), remembered per browser like the overview layout.
// Storage blocked: dismissals hold for this tab only.
import { useEffect, useSyncExternalStore } from 'react';
import { dismiss, forgetCleared, parseDismissed, undismiss } from '@/model/dismissed';
import { useHopper } from '@/store';

const KEY = 'jh_dismissed';
const listeners = new Set<() => void>();

const stored = (): string[] => { try { return parseDismissed(localStorage.getItem(KEY)); } catch { return []; } };
let dismissed: string[] = stored();

function publish(next: string[]) {
  if (next === dismissed) return;
  dismissed = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked: this tab only */ }
  for (const l of listeners) l();
}

export const dismissNotice = (key: string) => publish(dismiss(dismissed, key));
export const showDismissed = (keys: string[]) => publish(undismiss(dismissed, keys));

export const useDismissed = (): string[] => useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => dismissed);

/** Once loaded, forgets each dismissed notice whose condition the daemon now reports cleared. */
export function useForgetCleared() {
  const loaded = useHopper((s) => s.loaded);
  const health = useHopper((s) => s.health);
  const sources = useHopper((s) => s.sources);
  const update = useHopper((s) => s.update);
  useEffect(() => { if (loaded) publish(forgetCleared(dismissed, { health, sources, update })); }, [loaded, health, sources, update]);
}
