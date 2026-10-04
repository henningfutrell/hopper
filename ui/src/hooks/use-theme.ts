// Dark by default (a dashboard watched for hours); light when chosen. Remembered per browser.
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'jh_theme';
const listeners = new Set<() => void>();

const stored = (): Theme => { try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };
let theme: Theme = stored();
export const applyTheme = () => document.documentElement.classList.toggle('dark', theme === 'dark');

export function setTheme(next: Theme) {
  theme = next;
  try { localStorage.setItem(KEY, next); } catch { /* storage blocked: this tab only */ }
  applyTheme();
  for (const l of listeners) l();
}

export const useTheme = (): Theme => useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => theme);
