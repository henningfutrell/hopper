import type { Executor, ExecutorRegistry } from '../domain/ports.ts';

export function createExecutorRegistry(executors: Executor[]): ExecutorRegistry {
  const byName = new Map<string, Executor>();
  for (const e of executors) {
    if (byName.has(e.name)) throw new Error(`duplicate executor name: ${e.name}`);
    byName.set(e.name, e);
  }
  return { get: (name) => byName.get(name), names: () => [...byName.keys()] };
}
