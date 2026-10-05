// The store (design.md "Database", "Users: one hopper, separate users"): the instance store over
// the schema HOPPER_DATABASE_URL names, and a user store per user over that user's schema.
import { randomUUID } from 'node:crypto';
import { INSTANCE_DOCUMENTS, type Clock, type IdGen, type InstanceStore } from '../domain/ports.ts';
import { createContext } from './context.ts';
import { openDb } from './db.ts';
import { createConfigDocuments } from './documents.ts';
import { createLoginCodeRepository } from './login-codes.ts';
import { migrateInstance } from './migrations.ts';
import { createInstanceSettingsRepository } from './settings.ts';
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
  const userStore: InstanceStore['userStore'] = (user) =>
    openUserStore({ url: schemaUrl(o.url, userSchemaName(instanceSchema, user.id)), clock: o.clock, idGen });
  return {
    users: createUserRepository(ctx, (user) => userStore(user).close()),
    identities: createIdentityLinks(ctx),
    uiSessions: createUiSessionRepository(ctx),
    loginCodes: createLoginCodeRepository(ctx),
    documents: createConfigDocuments(ctx, INSTANCE_DOCUMENTS),
    settings: createInstanceSettingsRepository(ctx),
    userStore,
    tx: ctx.tx,
    close: () => db.close(),
  };
}
