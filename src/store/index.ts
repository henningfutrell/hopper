// The store (design.md "Database", "Users: one hopper, separate users"): the instance store over
// the schema HOPPER_DATABASE_URL names, and a user store per user over that user's schema.
import { randomUUID } from 'node:crypto';
import { INSTANCE_CONFIG, type Clock, type IdGen, type InstanceStore } from '../domain/ports.ts';
import { createContext } from './context.ts';
import { openDb } from './db.ts';
import { createConfigRecords } from './config.ts';
import { createLoginCodeRepository } from './login-codes.ts';
import { migrateInstance } from './migrations.ts';
import { createInstanceSettingsRepository } from './settings.ts';
import { createSignInConfigRepository } from './sign-in-config.ts';
import { userSchemaName } from './tenant-migrations.ts';
import { createUiSessionRepository } from './ui-sessions.ts';
import { openUserStore, schemaUrl } from './user-store.ts';
import { createIdentityLinks, createUserRepository } from './users.ts';

export type { UserStore, InstanceStore } from '../domain/ports.ts';

/** `url`: HOPPER_DATABASE_URL, `postgres://…` (design.md "Database"). Migrates the instance schema. */
export function openInstanceStore(o: { url: string; clock: Clock; idGen?: IdGen }): InstanceStore {
  const db = openDb(o.url);
  let instanceSchema: string;
  try {
    migrateInstance(db);
    instanceSchema = String(db.get('SELECT current_schema() AS s')!.s);
  } catch (e) {
    db.close();
    throw e;
  }
  const idGen = o.idGen ?? randomUUID;
  const ctx = createContext({ db, clock: o.clock, idGen });
  const schemaOf = (id: string): string => userSchemaName(instanceSchema, id);
  const userStore: InstanceStore['userStore'] = (user) =>
    openUserStore({ url: schemaUrl(o.url, schemaOf(user.id)), clock: o.clock, idGen });
  const config = createConfigRecords(ctx, INSTANCE_CONFIG);
  return {
    users: createUserRepository(ctx, (user) => userStore(user).close(), schemaOf),
    identities: createIdentityLinks(ctx),
    uiSessions: createUiSessionRepository(ctx),
    loginCodes: createLoginCodeRepository(ctx),
    config,
    signInConfig: createSignInConfigRepository(ctx, config),
    settings: createInstanceSettingsRepository(ctx),
    userStore,
    // Session-level: held while this connection lives, one key per instance schema.
    holdDaemonLock: () => db.get("SELECT pg_try_advisory_lock(hashtext('hopper daemon ' || current_schema())) AS held")!.held === true,
    tx: ctx.tx,
    close: () => db.close(),
  };
}
