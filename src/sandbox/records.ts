// The sandbox records in memory (issue #708), over the instance's `sandboxes` table. The vault reads a box's launch
// scope at each ask, from timers and process events too, and the hopper closes its database when it stops: those reads
// stay in memory. The hopper is the table's one writer, so each write goes to the table first, then to memory.
import type { SandboxRecord } from '../domain/sandboxes.ts';
import type { SandboxRepository } from '../domain/store.ts';

const copy = (r: SandboxRecord): SandboxRecord => structuredClone(r);
const byName = (a: SandboxRecord, b: SandboxRecord): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** `repo`, its rows read once now and kept: reads are answered from memory; writes go to `repo`, then to memory. */
export function cachedSandboxes(repo: SandboxRepository): SandboxRepository {
  const rows = new Map(repo.list().map((r) => [r.id, r]));
  return {
    list: () => [...rows.values()].sort(byName).map(copy),
    get: (id) => { const r = rows.get(id); return r && copy(r); },
    add(r) {
      const added = repo.add(r);
      if (added) rows.set(r.id, copy(r));
      return added;
    },
    update(r) {
      repo.update(r);
      if (rows.has(r.id)) rows.set(r.id, copy(r));
    },
    remove(id) {
      const removed = repo.remove(id);
      rows.delete(id);
      return removed;
    },
  };
}
