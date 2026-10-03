import type { LaneRepository } from '../domain/ports.ts';
import type { Lane } from '../domain/types.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

export function createLaneRepository(c: StoreContext): LaneRepository {
  return {
    list(machineId) {
      const rows = machineId === undefined
        ? c.db.prepare('SELECT body FROM lanes ORDER BY machine_id, number').all()
        : c.db.prepare('SELECT body FROM lanes WHERE machine_id = ? ORDER BY number').all(machineId);
      return rows.map((r) => parse<Lane>(r.body));
    },
    open(machineId) {
      const used = new Set(c.db.prepare('SELECT number FROM lanes WHERE machine_id = ?').all(machineId).map((r) => r.number));
      let n = 1;
      while (used.has(n)) n++;
      const at = c.clock.now().toISOString();
      const lane: Lane = { id: `${machineId}/lane-${n}`, machineId, state: 'idle', openedAt: at, idleSince: at };
      c.db.prepare('INSERT INTO lanes (id, machine_id, number, body) VALUES (?, ?, ?, ?)')
        .run(lane.id, machineId, n, JSON.stringify(lane));
      return lane;
    },
    update(id, patch) {
      const r = c.db.prepare('SELECT body FROM lanes WHERE id = ?').get(id);
      if (!r) throw new Error(`lane not found: ${id}`);
      const next: Lane = applyPatch<Lane>(parse<Lane>(r.body), patch);
      c.db.prepare('UPDATE lanes SET body = ? WHERE id = ?').run(JSON.stringify(next), id);
      return next;
    },
    close(id) {
      c.db.prepare('DELETE FROM lanes WHERE id = ?').run(id);
    },
  };
}
