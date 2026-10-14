// A machine's configured lanes set as an admin's edit of the machine sets them (issue #688, design.md "Lane tuning"):
// the plugins config edit of its machine-source instance's options (POST /ui/api/plugins), with `lanes` changed and
// every other option kept, against the config's version read now. Lane tuning's Apply and Undo take this path.
import type { PluginsView } from '../domain/ports.ts';
import { EngineError } from '../engine/index.ts';

export function machineLanesEditor(plugins: Pick<PluginsView, 'report' | 'edit'>): (machineId: string, lanes: number) => Promise<void> {
  return async (machineId, lanes) => {
    const report = plugins.report();
    const found = report.instances.find((i) => i.role === 'machine-source' && i.instance.name === machineId);
    if (!found) throw new EngineError('not_found', `no machine ${machineId} in the plugins config`);
    const r = await plugins.edit({
      action: 'options', role: 'machine-source', name: machineId, options: { ...found.instance.options, lanes }, version: report.config.version,
    });
    if (!r.ok) throw new EngineError(r.code, r.error);
  };
}
