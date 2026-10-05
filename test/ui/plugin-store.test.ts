// The Plugin store card's model (design.md "Plugin store"): what each plugin's line says and offers. Pure.
import { describe, expect, it } from 'vitest';
import type { PluginStoreEntry } from '../../src/domain/types.ts';
import { storeEntryView } from '../../ui/src/model/plugin-store.ts';

const entry = (o: Partial<PluginStoreEntry>): PluginStoreEntry => ({ id: 'p', role: 'executor', describe: 'd', listed: true, restartPending: false, ...o });
const installed = (current: boolean) => ({ commit: 'a'.repeat(40), installedAt: '2026-10-05T00:00:00Z', current });

describe('plugin store model', () => {
  it('offers Install for a listed plugin that is not installed', () => {
    expect(storeEntryView(entry({}))).toEqual({ label: 'not installed', tone: 'muted', install: 'Install', removable: false });
  });

  it('offers Update for a store install that is not current, and Remove for any store install', () => {
    expect(storeEntryView(entry({ installed: installed(false) }))).toEqual({ label: 'update available', tone: 'warn', install: 'Update', removable: true });
    expect(storeEntryView(entry({ installed: installed(true) }))).toEqual({ label: 'installed', tone: 'ok', install: null, removable: true });
  });

  it('says a reinstalled plugin waits for a restart', () => {
    expect(storeEntryView(entry({ installed: installed(true), restartPending: true })).label).toBe('installed — restart pending');
  });

  it('offers only Remove for a store install the catalogue no longer lists', () => {
    expect(storeEntryView(entry({ listed: false, installed: installed(false) }))).toEqual({ label: 'no longer in the plugin store', tone: 'warn', install: null, removable: true });
  });
});
