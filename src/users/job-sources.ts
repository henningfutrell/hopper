// A user's job sources as the plugin host built them, split for the sync loop (issue #356: on every
// change of the plugins config, not only at start): the ones it runs, and fixed /api/sources entries
// for the ones that do not.
import type { JobSource } from '../domain/ports.ts';
import type { SourceStatus } from '../domain/types.ts';
import type { BuiltJobSource } from '../plugins/index.ts';
import type { JobSourceInstance } from '../plugins/sdk.ts';
import { idleStatus } from '../sources/index.ts';

export type RunningSource = Extract<JobSourceInstance, { source: JobSource }>;

export function splitSources(built: BuiltJobSource[]): { running: RunningSource[]; fixed: SourceStatus[] } {
  const running: RunningSource[] = [];
  const fixed: SourceStatus[] = [];
  for (const b of built) {
    if (!b.instance) fixed.push(idleStatus(b.spec.name, b.spec.plugin, 'error', { error: b.reason }));
    else if ('disabled' in b.instance) fixed.push(idleStatus(b.spec.name, b.instance.disabled.kind, 'disabled', { detail: b.instance.disabled.detail }));
    else running.push(b.instance);
  }
  return { running, fixed };
}
