// The store (design.md "Database", "Users: one hopper, separate users"): the instance store over
// the schema HOPPER_DATABASE_URL names, and a user store per user over that user's schema.
import { randomUUID } from 'node:crypto';
import { fingerprintOf } from '../secrets/master-key.ts';
import { INSTANCE_CONFIG, type Clock, type IdGen, type InstanceStore } from '../domain/ports.ts';
import { createContext } from './context.ts';
import { openDb } from './db.ts';
import { createAccessRepository } from './access.ts';
import { createConfigRecords } from './config.ts';
import { createJoinCodeRepository, createLanePoolKeyRepository, createLoginCodeRepository } from './login-codes.ts';
import { migrateInstance } from './migrations.ts';
import { keptSecrets } from './kept-secrets.ts';
import { resealUnderNewKey } from './rotate-master-key.ts';
import { createSandboxRepository } from './sandboxes.ts';
import { createSandboxRunRepository } from './sandbox-runs.ts';
import { createNeedStepRepository } from './need-steps.ts';
import { createWindowsStepRepository } from './windows-steps.ts';
import { createSagaRepository } from './sagas.ts';
import { createSweepLeaseRepository } from './sweep-leases.ts';
import { createOutboundKeyRepository } from './outbound-keys.ts';
import { createInstanceSettingsRepository } from './settings.ts';
import { createSignInConfigRepository } from './sign-in-config.ts';
import { userSchemaName } from './tenant-migrations.ts';
import { createApiGrantRepository } from './api-grants.ts';
import { createUiSessionRepository } from './ui-sessions.ts';
import { openUserStore, schemaUrl } from './user-store.ts';
import { createIdentityLinks, createUserRepository } from './users.ts';
import { createLocalAccountPasskeyRepository, createLocalAccountRepository } from './local-accounts.ts';
import { createVaultRepository } from './vault.ts';
import { createDatabaseStats } from './database-stats.ts';
import { createStackHistoryRepository } from './stack-history.ts';

export type { UserStore, InstanceStore } from '../domain/ports.ts';

/** `url`: HOPPER_DATABASE_URL, `postgres://…` (design.md "Database"). Migrates the instance schema. */
/** `version`: migrate only up to it (a migration's own test); default the latest. */
export function openInstanceStore(o: { url: string; clock: Clock; idGen?: IdGen; version?: number }): InstanceStore {
  const db = openDb(o.url);
  let instanceSchema: string;
  try {
    migrateInstance(db, o.version);
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
  const settings = createInstanceSettingsRepository(ctx);
  // The instance's own vault too (issue #658): the sign-in realms' secrets.
  const schemas = (): string[] => [instanceSchema, ...db.all('SELECT id FROM users').map((r) => schemaOf(String(r.id)))];
  return {
    users: createUserRepository(ctx, (user) => userStore(user).close(), schemaOf),
    identities: createIdentityLinks(ctx),
    localAccounts: createLocalAccountRepository(ctx),
    localAccountPasskeys: createLocalAccountPasskeyRepository(ctx),
    uiSessions: createUiSessionRepository(ctx),
    apiGrants: createApiGrantRepository(ctx),
    loginCodes: createLoginCodeRepository(ctx),
    joinCodes: createJoinCodeRepository(ctx),
    lanePoolKeys: createLanePoolKeyRepository(ctx),
    sandboxes: createSandboxRepository(ctx),
    sandboxRuns: createSandboxRunRepository(ctx),
    needSteps: createNeedStepRepository(ctx),
    windowsSteps: createWindowsStepRepository(ctx),
    sagas: createSagaRepository(ctx),
    sweepLeases: createSweepLeaseRepository(ctx),
    outboundKeys: createOutboundKeyRepository(ctx),
    config,
    signInConfig: createSignInConfigRepository(ctx, config),
    settings,
    access: createAccessRepository(ctx),
    vault: createVaultRepository(ctx),
    databaseStats: createDatabaseStats(db),
    stackHistory: createStackHistoryRepository(ctx),
    userStore,
    keptSecrets: () => keptSecrets(db, schemas()),
    // One transaction over every schema (issue #659): the user stores' own connections take no part in it.
    rotateMasterKey: (keys) => ctx.tx(() => {
      const done = resealUnderNewKey(db, schemas(), keys);
      settings.setMasterKeyFingerprint(fingerprintOf(keys.to));
      settings.setMasterKeyRotation({ from: fingerprintOf(keys.from.key), at: o.clock.now().toISOString() });
      return done;
    }),
    // Session-level: held while this connection lives, one key per instance schema. Each daemon holds it shared, so several
    // hoppers run on one database (issue #1662); an operator command that needs the database alone holds it exclusive.
    holdDaemonLock: () => db.get("SELECT pg_try_advisory_lock_shared(hashtext('hopper daemon ' || current_schema())) AS held")!.held === true,
    holdSoleLock: () => db.get("SELECT pg_try_advisory_lock(hashtext('hopper daemon ' || current_schema())) AS held")!.held === true,
    tx: ctx.tx,
    close: () => db.close(),
  };
}
