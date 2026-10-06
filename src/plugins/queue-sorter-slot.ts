// The queue-sorter role's one slot (design.md "Queue sorter (issue #18)"): the instance the plugins config
// names (absent: the built-in `priority`), answered through a live QueueSorter swapped between
// calls. A sorter that cannot run, throws, or returns anything but distinct ids of the jobs it was
// given → `priority`'s order for that call, the reason kept for /api/plugins. Its rejections of jobs
// not yet accepted (issue #159) are checked the same way; an unusable answer rejects nothing.
import type { Detection, InstanceSpec, JobId, PreSortReject, QueueSorterStatus } from '../domain/types.ts';
import type { QueueEntry, QueueSorter } from '../domain/ports.ts';
import { byPriority } from './queue-sorter/priority/index.ts';
import { instantiate, type SlotDeps } from './router-slot.ts';

export interface BuiltQueueSorter {
  spec: InstanceSpec;
  /** Absent: it cannot run (`fallback` says why); priority answers. */
  sorter?: QueueSorter;
  plugin: string;
  detection: Detection;
  fallback?: string;
}

const PRIORITY = 'priority';
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const byPriorityIds = (entries: readonly QueueEntry[]): JobId[] => [...entries].sort(byPriority).map((e) => e.job.id);

export async function buildQueueSorter(spec: InstanceSpec, deps: SlotDeps): Promise<BuiltQueueSorter> {
  const built = await instantiate('queue-sorter', spec, deps);
  if (built.ok) return { spec, sorter: built.instance, plugin: built.plugin, detection: built.detection };
  deps.logger.warn(`hopper: queue sorter ${spec.name} (${spec.plugin}) unavailable, using priority: ${built.why}`);
  return { spec, plugin: PRIORITY, detection: built.detection, fallback: built.why };
}

/** Why a sort result is not usable, or undefined: distinct ids, each one of the given jobs. */
function problemWith(out: unknown, entries: readonly QueueEntry[]): string | undefined {
  if (!Array.isArray(out) || out.some((id) => typeof id !== 'string')) return 'not a list of job ids';
  const known = new Set(entries.map((e) => e.job.id));
  const seen = new Set<string>();
  for (const id of out as string[]) {
    if (!known.has(id)) return `names job ${id}, which is not waiting`;
    if (seen.has(id)) return `names job ${id} twice`;
    seen.add(id);
  }
  return undefined;
}

/** Why a reject result is not usable, or undefined: `{ jobId, reason }` of the given jobs, each once. */
function problemWithRejects(out: unknown, entries: readonly QueueEntry[]): string | undefined {
  if (!Array.isArray(out)) return 'rejected with something other than a list';
  const known = new Set(entries.map((e) => e.job.id));
  const seen = new Set<string>();
  for (const r of out as unknown[]) {
    const { jobId, reason } = (r ?? {}) as Record<string, unknown>;
    if (typeof jobId !== 'string' || typeof reason !== 'string' || !reason) return 'rejected with something other than { jobId, reason }';
    if (!known.has(jobId)) return `rejected job ${jobId}, which is not waiting`;
    if (seen.has(jobId)) return `rejected job ${jobId} twice`;
    seen.add(jobId);
  }
  return undefined;
}

export interface LiveQueueSorter {
  sorter: QueueSorter;
  current(): BuiltQueueSorter;
  swap(next: BuiltQueueSorter): void;
  status(): QueueSorterStatus;
}

export function createLiveQueueSorter(first: BuiltQueueSorter, logger: SlotDeps['logger']): LiveQueueSorter {
  let current = first;
  /** Set while the current instance's last sort was unusable. */
  let sortFallback: string | undefined;
  /** The last unusable reject answer, logged once. */
  let rejectProblem: string | undefined;
  const sorter: QueueSorter = {
    get name() { return current.spec.name; },
    sort(entries) {
      const c = current;
      if (!c.sorter) return byPriorityIds(entries);
      let why: string | undefined;
      let out: unknown;
      try {
        out = c.sorter.sort(entries);
        why = problemWith(out, entries);
      } catch (e) {
        why = `sort failed: ${message(e)}`;
      }
      if (c !== current) return why ? byPriorityIds(entries) : (out as JobId[]);
      if (why) {
        const reason = `queue sorter ${c.spec.name} ${why}; priority's order used`;
        if (reason !== sortFallback) logger.warn(`hopper: ${reason}`);
        sortFallback = reason;
        return byPriorityIds(entries);
      }
      sortFallback = undefined;
      return out as JobId[];
    },
    reject(entries) {
      const c = current;
      if (!c.sorter?.reject || entries.length === 0) return [];
      let why: string | undefined;
      let out: unknown;
      try {
        out = c.sorter.reject(entries);
        why = problemWithRejects(out, entries);
      } catch (e) {
        why = `reject failed: ${message(e)}`;
      }
      if (!why) return (out as PreSortReject[]).map(({ jobId, reason }) => ({ jobId, reason }));
      const reason = `queue sorter ${c.spec.name} ${why}; nothing rejected`;
      if (reason !== rejectProblem) logger.warn(`hopper: ${reason}`);
      rejectProblem = reason;
      return [];
    },
  };
  return {
    sorter,
    current: () => current,
    swap(next) {
      current = next;
      sortFallback = undefined;
    },
    status() {
      const { spec, plugin, detection, fallback } = current;
      const reason = fallback ?? sortFallback;
      return { instance: spec, detection, active: plugin, fallback: reason !== undefined, ...(reason === undefined ? {} : { reason }) };
    },
  };
}
