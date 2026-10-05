// The Plugin store card (design.md "Plugin store"), from GET /api/plugin-store: what each plugin's
// line says and which actions it offers. Pure.
import type { PluginStoreEntry } from '../../../src/domain/types.ts';

export interface StoreEntryView {
  label: string;
  tone: 'ok' | 'warn' | 'muted';
  /** The install button's word, or null when there is nothing to install. */
  install: 'Install' | 'Update' | null;
  /** A store install: it may be removed. */
  removable: boolean;
}

export function storeEntryView(e: PluginStoreEntry): StoreEntryView {
  const removable = e.installed !== undefined;
  const pending = e.restartPending ? ' — restart pending' : '';
  if (!e.listed) return { label: 'no longer in the plugin store', tone: 'warn', install: null, removable };
  if (!e.installed) return { label: 'not installed', tone: 'muted', install: 'Install', removable };
  if (!e.installed.current) return { label: `update available${pending}`, tone: 'warn', install: 'Update', removable };
  return { label: `installed${pending}`, tone: 'ok', install: null, removable };
}
