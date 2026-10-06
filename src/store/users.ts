// The users of one hopper and their identity links (issue #158), in the instance schema.
import type { IdentityLinks, UserRepository } from '../domain/ports.ts';
import type { User } from '../domain/types.ts';
import type { StoreContext } from './context.ts';
import { foldUserSchema } from './fold-user.ts';
import { quoteIdent } from './tenant-migrations.ts';

const MAX_ID = 24;

const rowOf = (r: Record<string, unknown>): User => ({
  id: String(r.id), name: String(r.name), createdAt: String(r.created_at), workDir: String(r.work_dir), secretPrefix: String(r.secret_prefix),
});

/** A user id from a name: lowercase letters, digits and `_`, starting with a letter, at most 24 long. */
export function idFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX_ID).replace(/_+$/, '');
  return /^[a-z]/.test(slug) ? slug : `u${slug}`.slice(0, MAX_ID);
}

/** A user's work: what `transfer` will not discard. Their config, settings and events go with their schema. */
const WORK = [['jobs', 'job'], ['questions', 'question'], ['decisions', 'decision'], ['webhooks', 'webhook']] as const;

/**
 * `onAdded(user)` creates the user's schema (the instance store opens and migrates it), once the row is in;
 * `schemaOf(id)` names it.
 */
export function createUserRepository(c: StoreContext, onAdded: (user: User) => void, schemaOf: (id: string) => string): UserRepository {
  const list = (): User[] => c.db.all('SELECT * FROM users ORDER BY seq').map(rowOf);
  return {
    list,
    get(id) {
      const r = c.db.get('SELECT * FROM users WHERE id = ?', id);
      return r ? rowOf(r) : undefined;
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
    transfer(fromId, toId) {
      if (fromId === toId) throw new Error('a transfer needs two different users');
      return c.tx(() => {
        const from = c.db.get('SELECT * FROM users WHERE id = ?', fromId);
        const to = c.db.get('SELECT * FROM users WHERE id = ?', toId);
        if (!from) throw new Error(`no user ${fromId}; hopper users lists them`);
        if (!to) throw new Error(`no user ${toId}; hopper users lists them`);
        const schema = quoteIdent(schemaOf(toId));
        const held = WORK.map(([table, noun]) => {
          const n = Number(c.db.get(`SELECT count(*) AS n FROM ${schema}.${table}`)!.n);
          return n > 0 ? `${n} ${noun}${n === 1 ? '' : 's'}` : '';
        }).filter(Boolean);
        if (held.length > 0) throw new Error(`${toId} holds work of its own (${held.join(', ')}); nothing changed`);
        for (const table of ['user_identities', 'ui_sessions', 'login_codes']) c.db.run(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`, fromId, toId);
        c.db.run('DELETE FROM users WHERE id = ?', toId);
        c.db.run('UPDATE users SET name = ? WHERE id = ?', String(to.name), fromId);
        c.db.exec(`DROP SCHEMA ${schema} CASCADE`);
        return rowOf(c.db.get('SELECT * FROM users WHERE id = ?', fromId)!);
      });
    },
    fold(fromId, intoId) {
      if (fromId === intoId) throw new Error('a fold needs two different users');
      return c.tx(() => {
        const from = c.db.get('SELECT * FROM users WHERE id = ?', fromId);
        const into = c.db.get('SELECT * FROM users WHERE id = ?', intoId);
        if (!from) throw new Error(`no user ${fromId}`);
        if (!into) throw new Error(`no user ${intoId}`);
        // `from`'s record and schema stay, holding the work that ran the hopper; `into`'s work joins them.
        const kept = schemaOf(fromId);
        const gone = schemaOf(intoId);
        foldUserSchema(c.db, kept, gone);
        c.db.exec('ALTER TABLE user_identities DROP CONSTRAINT user_identities_user_id_fkey');
        for (const table of ['user_identities', 'ui_sessions', 'login_codes']) c.db.run(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`, intoId, fromId);
        c.db.run('DELETE FROM users WHERE id = ?', intoId);
        c.db.exec(`DROP SCHEMA ${quoteIdent(gone)} CASCADE`);
        c.db.run('UPDATE users SET id = ?, name = ? WHERE id = ?', intoId, String(into.name), fromId);
        c.db.exec(`ALTER SCHEMA ${quoteIdent(kept)} RENAME TO ${quoteIdent(gone)}`);
        c.db.exec('ALTER TABLE user_identities ADD CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)');
        return rowOf(c.db.get('SELECT * FROM users WHERE id = ?', intoId)!);
      });
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
    anyIn(realms) {
      return realms.some((realm) => c.db.get('SELECT 1 FROM user_identities WHERE realm = ? LIMIT 1', realm) !== undefined);
    },
    all() {
      return c.db.all('SELECT realm, subject, user_id FROM user_identities ORDER BY realm, subject')
        .map((r) => ({ realm: String(r.realm), subject: String(r.subject), userId: String(r.user_id) }));
    },
  };
}
