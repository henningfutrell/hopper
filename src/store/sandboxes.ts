// The sandbox records (issue #708, instance migration 34): the sandbox module's own rows, in the instance schema — the
// boxes an older build launched, of every user. The record is the body. The hopper launches no box now (issue #1349): the
// burn pass removes each record once its box is gone.
import type { SandboxRepository } from '../domain/ports.ts';
import type { SandboxRecord } from '../domain/sandboxes.ts';
import { parse, type StoreContext } from './context.ts';

export function createSandboxRepository(c: StoreContext): SandboxRepository {
  return {
    list: () => c.db.all('SELECT body FROM sandboxes ORDER BY name').map((r) => parse<SandboxRecord>(r.body)),
    add: (s) => c.db.run('INSERT INTO sandboxes (id, name, user_id, body) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', s.id, s.name, s.userId, JSON.stringify(s)).changes > 0,
    remove: (id) => c.db.run('DELETE FROM sandboxes WHERE id = ?', id).changes > 0,
  };
}
