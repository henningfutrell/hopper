// The sandbox records (issue #708, instance migration 34): the sandbox module's own rows, in the instance schema — the
// boxes the hopper launched, of every user. The record is the body; the name is unique, so two launches never share one.
import type { SandboxRepository } from '../domain/ports.ts';
import type { SandboxRecord } from '../domain/sandboxes.ts';
import { parse, type StoreContext } from './context.ts';

export function createSandboxRepository(c: StoreContext): SandboxRepository {
  return {
    list: () => c.db.all('SELECT body FROM sandboxes ORDER BY name').map((r) => parse<SandboxRecord>(r.body)),
    get(id) {
      const r = c.db.get('SELECT body FROM sandboxes WHERE id = ?', id);
      return r ? parse<SandboxRecord>(r.body) : undefined;
    },
    add: (s) => c.db.run('INSERT INTO sandboxes (id, name, user_id, body) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', s.id, s.name, s.userId, JSON.stringify(s)).changes > 0,
    update(s) {
      c.db.run('UPDATE sandboxes SET body = ? WHERE id = ?', JSON.stringify(s), s.id);
    },
    remove: (id) => c.db.run('DELETE FROM sandboxes WHERE id = ?', id).changes > 0,
  };
}
