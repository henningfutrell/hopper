// The users of one hopper and their identity links (issue #158), in the instance schema.
import type { IdentityLinks, UserRepository } from '../domain/ports.ts';
import type { User } from '../domain/types.ts';
import type { StoreContext } from './context.ts';

const MAX_ID = 24;

const rowOf = (r: Record<string, unknown>): User => ({
  id: String(r.id), name: String(r.name), createdAt: String(r.created_at), workDir: String(r.work_dir), secretPrefix: String(r.secret_prefix),
});

/** A user id from a name: lowercase letters, digits and `_`, starting with a letter, at most 24 long. */
export function idFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX_ID).replace(/_+$/, '');
  return /^[a-z]/.test(slug) ? slug : `u${slug}`.slice(0, MAX_ID);
}

/** `onAdded(user)` creates the user's schema (the instance store opens and migrates it), once the row is in. */
export function createUserRepository(c: StoreContext, onAdded: (user: User) => void): UserRepository {
  const list = (): User[] => c.db.all('SELECT * FROM users ORDER BY seq').map(rowOf);
  return {
    list,
    get(id) {
      const r = c.db.get('SELECT * FROM users WHERE id = ?', id);
      return r ? rowOf(r) : undefined;
    },
    owner() {
      const first = list()[0];
      if (!first) throw new Error('the store has no user (migration 17 creates owner)');
      return first;
    },
    add(name) {
      const trimmed = name.trim();
      if (trimmed === '') throw new Error('a user needs a name');
      const user = c.tx(() => {
        if (c.db.get('SELECT 1 FROM users WHERE lower(name) = lower(?)', trimmed)) throw new Error(`the name ${trimmed} is taken`);
        const base = idFromName(trimmed);
        let id = base;
        for (let n = 2; c.db.get('SELECT 1 FROM users WHERE id = ?', id); n++) id = `${base.slice(0, MAX_ID - String(n).length - 1)}_${n}`;
        const user: User = { id, name: trimmed, createdAt: c.clock.now().toISOString(), workDir: `users/${id}`, secretPrefix: `HOPPER_USER_${id.toUpperCase()}_` };
        c.db.run('INSERT INTO users (id, name, created_at, work_dir, secret_prefix) VALUES (?, ?, ?, ?, ?)', user.id, user.name, user.createdAt, user.workDir, user.secretPrefix);
        return user;
      });
      onAdded(user);
      return user;
    },
  };
}

export function createIdentityLinks(c: StoreContext): IdentityLinks {
  return {
    userOf(realm, subject) {
      const r = c.db.get('SELECT user_id FROM user_identities WHERE realm = ? AND subject = ?', realm, subject);
      return r ? String(r.user_id) : undefined;
    },
    link(realm, subject, userId) {
      c.db.run('INSERT INTO user_identities (realm, subject, user_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', realm, subject, userId);
    },
  };
}
