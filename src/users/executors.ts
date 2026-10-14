// A user's executors (issue #142): they follow the plugins config live, so every lookup reads the plugin host's
// instances now, with the seams' executors after them.
import type { Executor, ExecutorRegistry } from '../domain/ports.ts';
import { createExecutorRegistry } from '../executors/index.ts';
import { unavailableExecutors } from '../plugins/executor-slot.ts';
import type { PluginHost } from '../plugins/index.ts';

export function liveExecutors(host: Pick<PluginHost, 'executors'>, seamed: readonly Executor[]): ExecutorRegistry {
  const current = (): ExecutorRegistry => {
    const built = host.executors();
    return createExecutorRegistry([...built.flatMap((b): Executor[] => (b.executor ? [b.executor] : [])), ...seamed], unavailableExecutors(built));
  };
  return {
    get: (name) => current().get(name),
    names: () => current().names(),
    unavailable: () => current().unavailable(),
  };
}
