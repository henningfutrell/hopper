// Tenant migration 80 (issue #865 part C): a container target runs each command in a one-shot sandbox box of its image,
// through the sandbox module, not in a running container over docker exec. Every `docker` machine instance becomes a
// `container` instance of the same name — its lanes, executors and other options kept, its `docker` option gone, so it
// runs the default image —; no machine is dropped. The `dockerBin` option of every `command` executor and `claude-plan`
// usage source goes: the hopper runs no docker CLI. The build before runs on it: it knows no `container` plugin, so it
// lists no such machine and a job pinned to one waits, and it reads the other options as before.
import type { Db } from './db.ts';

interface Instance { plugin?: unknown; options?: Record<string, unknown> }

const NO_DOCKER_BIN: Record<string, string> = { executors: 'command', usageSources: 'claude-plan' };

export function containerTargets(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as Record<string, unknown>;
  let changed = false;
  for (const m of Array.isArray(value.machines) ? (value.machines as Instance[]) : []) {
    if (m?.plugin !== 'docker') continue;
    const { docker: _gone, ...rest } = m.options ?? {};
    m.plugin = 'container';
    m.options = rest;
    changed = true;
  }
  for (const [section, plugin] of Object.entries(NO_DOCKER_BIN)) {
    for (const x of Array.isArray(value[section]) ? (value[section] as Instance[]) : []) {
      if (x?.plugin !== plugin || !x.options || !('dockerBin' in x.options)) continue;
      const { dockerBin: _gone, ...rest } = x.options;
      x.options = rest;
      changed = true;
    }
  }
  if (changed) db.run("UPDATE config SET value = ? WHERE name = 'plugins'", JSON.stringify(value));
}
