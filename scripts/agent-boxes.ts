// The plugins-config side of scripts/agent-boxes.sh (design.md "Agent boxes", issue #295): attaching the
// agent boxes as ssh machines, and detaching them. A filter: the plugins config as JSON on stdin (what
// `hopper config get plugins` prints), the changed one on stdout (for `hopper config set plugins`).
//   node scripts/agent-boxes.ts attach '[{"name":…,"ssh":…,"hostKey":…}, …]'
//   node scripts/agent-boxes.ts detach <name>...
// A box is attached with no executors: it runs no job until one is listed for it in Plugins, so the
// queue's jobs never land on a test box by chance. Attached again, it keeps its lanes, executors and
// label; its connection (ssh, herdr, hostKey) is the box's as it runs now.
import { readFileSync } from 'node:fs';

export interface Box { name: string; ssh: string; hostKey: string }

interface Instance { name: string; plugin: string; options?: Record<string, unknown> }
type Config = Record<string, unknown> & { machines?: Instance[] };

/** Where herdr is in every agent box (deploy/agent-box/Dockerfile). */
export const BOX_HERDR = '/usr/local/bin/herdr';

/** `config` with each box an `ssh` machine instance. Throws when a box's name is another kind of machine. */
export function attachBoxes(config: Config, boxes: readonly Box[]): Config {
  const machines = [...(config.machines ?? [])];
  for (const box of boxes) {
    const at = machines.findIndex((m) => m.name === box.name);
    const old = at >= 0 ? machines[at]! : undefined;
    if (old && old.plugin !== 'ssh') throw new Error(`machine ${box.name} is a ${old.plugin} machine, not an agent box: rename it first`);
    const kept = old?.options ?? {};
    const options = {
      ...kept, ssh: box.ssh, herdr: true, herdrBin: BOX_HERDR, hostKey: box.hostKey,
      lanes: kept.lanes ?? 1, executors: kept.executors ?? [],
    };
    delete (options as Record<string, unknown>).session;
    const entry: Instance = { name: box.name, plugin: 'ssh', options };
    if (at >= 0) machines[at] = entry; else machines.push(entry);
  }
  return { ...config, machines };
}

/** `config` without the `ssh` machines named. */
export function detachBoxes(config: Config, names: readonly string[]): Config {
  if (!config.machines) return config;
  return { ...config, machines: config.machines.filter((m) => !(m.plugin === 'ssh' && names.includes(m.name))) };
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    const config = JSON.parse(readFileSync(0, 'utf8')) as Config;
    let out: Config;
    if (mode === 'attach' && rest.length === 1) out = attachBoxes(config, JSON.parse(rest[0]!) as Box[]);
    else if (mode === 'detach' && rest.length > 0) out = detachBoxes(config, rest);
    else {
      process.stderr.write('usage: agent-boxes.ts attach <boxes as JSON> | detach <name>... (the plugins config on stdin)\n');
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`agent-boxes: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
