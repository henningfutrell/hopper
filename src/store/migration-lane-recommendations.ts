// Tenant migration 38 (issue #688): lane tuning recommends and an admin applies; the hopper applies nothing by itself,
// and there is no shadow or active mode. A machine in active mode with auto-tune on ran on its applied lanes, kept within
// its bounds: those lanes become its configured lanes in the plugins config, as an admin's edit of the machine sets
// them, so no machine changes its lanes on the upgrade. The applied lanes and each machine's mode go from the settings.
// The build before runs on it: it reads a setting with no mode as shadow, and the configured lanes with nothing applied.
import type { Db } from './db.ts';

interface Tuning { autoTune: boolean; minLanes: number; maxLanes: number; mode?: string }
interface Applied { lanes: number }
interface Instance { name?: unknown; options?: Record<string, unknown> }

const setting = <T>(db: Db, key: string): T | undefined => {
  const row = db.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(String(row.value)) as T : undefined;
};

export function laneRecommendationsOnly(db: Db): void {
  const tuning = setting<Record<string, Tuning>>(db, 'laneTuning');
  const applied = setting<Record<string, Applied>>(db, 'appliedLanes') ?? {};
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (tuning && row) {
    const plugins = JSON.parse(String(row.value)) as { machines?: Instance[] };
    let changed = false;
    for (const m of plugins.machines ?? []) {
      const id = typeof m.name === 'string' ? m.name : undefined;
      const t = id === undefined ? undefined : tuning[id];
      const a = id === undefined ? undefined : applied[id];
      if (!t || !a || t.mode !== 'active' || !t.autoTune || !m.options) continue;
      const lanes = Math.min(t.maxLanes, Math.max(t.minLanes, a.lanes));
      if (m.options.lanes === lanes) continue;
      m.options = { ...m.options, lanes };
      changed = true;
    }
    if (changed) db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(plugins));
  }
  if (tuning) {
    const kept = Object.fromEntries(Object.entries(tuning).map(([id, t]) => [id, { autoTune: t.autoTune, minLanes: t.minLanes, maxLanes: t.maxLanes }]));
    db.run("UPDATE settings SET value = ? WHERE key = 'laneTuning'", JSON.stringify(kept));
  }
  db.run("DELETE FROM settings WHERE key = 'appliedLanes'");
}
