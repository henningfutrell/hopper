// The Plugin store card (design.md "Plugin store"), from GET /api/plugin-store: what each plugin's
// line says and which actions it offers. Pure.
import type { PluginStoreEntry, PluginStoreReport } from '../../../src/domain/types.ts';

export interface StoreEntryView {
  label: string;
  tone: 'ok' | 'warn' | 'muted';
  /** The install button's word, or null when there is nothing to install. */
  install: 'Install' | 'Update' | null;
  /** A store install: it may be removed. */
  removable: boolean;
}

/** `installable` false: the catalogue shown was read from another plugin store (`from`), so nothing installs from it. */
export function storeEntryView(e: PluginStoreEntry, installable = true): StoreEntryView {
  if (!installable) return { ...storeEntryView(e), install: null };
  const removable = e.installed !== undefined;
  const pending = e.restartPending ? ' — restart pending' : '';
  if (!e.listed) return { label: 'no longer in the plugin store', tone: 'warn', install: null, removable };
  if (!e.installed) return { label: 'not installed', tone: 'muted', install: 'Install', removable };
  if (!e.installed.current) return { label: `update available${pending}`, tone: 'warn', install: 'Update', removable };
  return { label: `installed${pending}`, tone: 'ok', install: null, removable };
}

/** Where the plugin store setting points, in words: the card's line above the field. */
export function storeSourceLabel(r: Pick<PluginStoreReport, 'source' | 'repo'>): string {
  if (r.source === 'none') return 'No plugin store is set.';
  if (r.source === 'default') return r.repo ? 'The default plugin store.' : 'This build has no default plugin store.';
  return 'Set by an admin.';
}
