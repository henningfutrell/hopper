// Tenant migration 38 (issue #688): lane tuning recommends, and an admin applies; it applies nothing by itself. A machine
// that active mode ran on applied lanes keeps them: they become its configured lanes in the plugins config, as an admin's
// edit would set them, within its bounds. The applied lanes and the mode go from the settings.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const plugins = {
  version: 1,
  machines: [
    { name: 'local', plugin: 'local', options: { lanes: 4 } },
    { name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 2, executors: ['test'] } },
    { name: 'desk', plugin: 'ssh', options: { ssh: 'desk', lanes: 2, executors: ['test'] } },
    { name: 'shelf', plugin: 'ssh', options: { ssh: 'shelf', lanes: 2, executors: ['test'] } },
  ],
};
const tuning = {
  laptop: { autoTune: true, minLanes: 1, maxLanes: 3, mode: 'active' },
  desk: { autoTune: true, minLanes: 1, maxLanes: 8, mode: 'shadow' },
  shelf: { autoTune: true, minLanes: 1, maxLanes: 8, mode: 'active' },
  local: { autoTune: true, minLanes: 1, maxLanes: 8 },
};
const applied = {
  // Applied 4, kept within the bound 3: it ran on 3.
  laptop: { lanes: 4, from: 2, at: '2026-10-10T12:00:00.000Z', reason: 'r' },
  // In shadow: its applied lanes were not in use.
  desk: { lanes: 5, from: 2, at: '2026-10-10T12:00:00.000Z', reason: 'r' },
  // Undone: back on the lanes before the change.
  shelf: { lanes: 2, from: 3, at: '2026-10-10T12:00:00.000Z', reason: 'undone by someone', undone: true },
};

describe('tenant migration 38: lane tuning applies nothing by itself', () => {
  it('the lanes active mode applied become the configured lanes; the applied lanes and the mode go', () => {
    const raw = t.tenantAt(t.url(), 37);
    raw.run('INSERT INTO config (name, value, updated_at) VALUES (?, ?, ?)', 'plugins', JSON.stringify(plugins), '2026-10-10T12:00:00.000Z');
    raw.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'laneTuning', JSON.stringify(tuning));
    raw.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'appliedLanes', JSON.stringify(applied));
    migrateTenant(raw, 38);
    const config = JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as typeof plugins;
    expect(config.machines.map((m) => [m.name, m.options.lanes])).toEqual([['local', 4], ['laptop', 3], ['desk', 2], ['shelf', 2]]);
    expect(config.machines[1]!.options).toEqual({ ssh: 'laptop', lanes: 3, executors: ['test'] });
    expect(raw.get("SELECT value FROM settings WHERE key = 'appliedLanes'")).toBeUndefined();
    expect(JSON.parse(String(raw.get("SELECT value FROM settings WHERE key = 'laneTuning'")!.value))).toEqual({
      laptop: { autoTune: true, minLanes: 1, maxLanes: 3 },
      desk: { autoTune: true, minLanes: 1, maxLanes: 8 },
      shelf: { autoTune: true, minLanes: 1, maxLanes: 8 },
      local: { autoTune: true, minLanes: 1, maxLanes: 8 },
    });
    raw.close();
  });

  it('a store with no lane tuning is left as it is', () => {
    const raw = t.tenantAt(t.url(), 37);
    raw.run('INSERT INTO config (name, value, updated_at) VALUES (?, ?, ?)', 'plugins', JSON.stringify(plugins), '2026-10-10T12:00:00.000Z');
    migrateTenant(raw, 38);
    expect(JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value))).toEqual(plugins);
    raw.close();
  });
});
