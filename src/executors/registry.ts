import type { Executor, ExecutorRegistry } from '../domain/ports.ts';
import type { ExecutorUnavailable } from '../domain/types.ts';

/** The runnable executors, plus the configured ones that cannot run (their jobs are held). Names are unique across both. */
export function createExecutorRegistry(executors: Executor[], unavailable: ExecutorUnavailable[]): ExecutorRegistry {
  const byName = new Map<string, Executor>();
  const seen = new Set<string>();
  for (const name of [...executors.map((e) => e.name), ...unavailable.map((u) => u.name)]) {
    if (seen.has(name)) throw new Error(`duplicate executor name: ${name}`);
    seen.add(name);
  }
  for (const e of executors) byName.set(e.name, e);
  const down = unavailable.map((u) => ({ ...u }));
  return { get: (name) => byName.get(name), names: () => [...byName.keys()], unavailable: () => down.map((u) => ({ ...u })) };
}
