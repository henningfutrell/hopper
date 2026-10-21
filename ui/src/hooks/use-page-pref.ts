// Page choices (model/page-prefs.ts, issue #2353), remembered per browser like the collapsed nav groups. Storage blocked:
// the choices hold for this tab only.
import { useSyncExternalStore } from 'react';
import { parsePrefs, prefOf, setPref, type PagePrefs } from '@/model/page-prefs';

const KEY = 'jh_page_prefs';
const listeners = new Set<() => void>();

const stored = (): PagePrefs => { try { return parsePrefs(localStorage.getItem(KEY)); } catch { return {}; } };
let prefs: PagePrefs = stored();

export function setPagePref(key: string, value: string) {
  if (prefs[key] === value) return;
  prefs = setPref(prefs, key, value);
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage blocked: this tab only */ }
  for (const l of listeners) l();
}

const usePrefs = (): PagePrefs => useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => prefs);

/** One choice and its setter: one of `allowed`, the fallback until a person picks. */
export function usePagePref<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const v = prefOf(usePrefs(), key, fallback, allowed);
  return [v, (next: T) => setPagePref(key, next)];
}

const OPEN = ['open', 'closed'] as const;

/** Whether a group is open, and its toggle: `open` until a person folds it, unless `openFirst` says otherwise. */
export function useGroupOpen(key: string, openFirst = true): [boolean, () => void] {
  const [v, set] = usePagePref(key, openFirst ? 'open' : 'closed', OPEN);
  return [v === 'open', () => set(v === 'open' ? 'closed' : 'open')];
}

/** Whether any of the groups `keys` is open, and a setter that opens or folds them all (issue #2373). */
export function useGroupsOpen(keys: readonly string[], openFirst = true): [boolean, (open: boolean) => void] {
  const p = usePrefs();
  const fallback = openFirst ? 'open' : 'closed';
  const anyOpen = keys.some((k) => prefOf(p, k, fallback, OPEN) === 'open');
  return [anyOpen, (open: boolean) => { for (const k of keys) setPagePref(k, open ? 'open' : 'closed'); }];
}
