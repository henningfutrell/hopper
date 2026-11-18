// The implicit claude-analytics source (issue #2966, design.md "The meter of an account"): when a usage source's account
// resolves to the analytics meter and the plugins config names no claude-analytics source, one runs with the default
// options. Never written to the plugins config: an explicit instance wins.
import type { UsageSource } from '../domain/ports.ts';
import type { InstanceSpec } from '../domain/types.ts';

const ANALYTICS = 'claude-analytics';

/** The instance to run besides the usage sources `specs` names, given the sources built now: none, or the implicit one. */
export function implicitUsage(specs: InstanceSpec[], built: readonly { instance?: UsageSource }[] | undefined): InstanceSpec[] {
  if (specs.some((s) => s.plugin === ANALYTICS) || !(built ?? []).some((b) => b.instance?.state?.().meter === 'analytics')) return [];
  const taken = new Set(specs.map((s) => s.name));
  let name = ANALYTICS;
  for (let n = 2; taken.has(name); n++) name = `${ANALYTICS}-${n}`;
  return [{ name, plugin: ANALYTICS }];
}
