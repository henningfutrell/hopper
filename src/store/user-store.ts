// One user's store (issue #158): the tables of their user schema, over a connection of its own whose
// search_path is that schema (the `?schema=` of the database URL, db.ts).
import { USER_CONFIG, type Clock, type IdGen, type UserStore } from '../domain/ports.ts';
import { createContext } from './context.ts';
import { openDb } from './db.ts';
import { createDecisionRepository } from './decisions.ts';
import { createConfigRecords } from './config.ts';
import { createConnectedAccountRepository } from './connected-accounts.ts';
import { createEventLog } from './events.ts';
import { createJobRepository } from './jobs.ts';
import { createJobStreamRepository } from './job-stream.ts';
import { createLaneRepository } from './lanes.ts';
import { createFailureRepository, createProblemRepository } from './failures.ts';
import { createHandoffRepository } from './handoffs.ts';
import { createLoginRepository } from './logins.ts';
import { createReviewItemRepository } from './review-items.ts';
import { createQuestionRepository } from './questions.ts';
import { createUserSettingsRepository } from './settings.ts';
import { migrateTenant } from './tenant-migrations.ts';
import { createUsageHistoryRepository } from './usage-history.ts';
import { createMachineHistoryRepository } from './machine-history.ts';
import { createVaultRepository } from './vault.ts';
import { createWebhookRepository } from './webhooks.ts';

/** The database URL with `?schema=<schema>`: the user schema, created when absent. */
export function schemaUrl(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set('schema', schema);
  return u.toString();
}

/** Open the store of the user schema `url` names (`?schema=`), migrated on the tenant track. */
export function openUserStore(o: { url: string; clock: Clock; idGen: IdGen }): UserStore {
  const db = openDb(o.url);
  try {
    migrateTenant(db);
  } catch (e) {
    db.close();
    throw e;
  }
  // eslint-disable-next-line prefer-const -- events and the job stream need ctx, ctx's commit needs them
  let events: ReturnType<typeof createEventLog>, jobStream: ReturnType<typeof createJobStreamRepository>;
  const ctx = createContext({
    db, clock: o.clock, idGen: o.idGen,
    onCommit: () => { events.flush(); jobStream.flush(); },
    onRollback: () => { events.discard(); jobStream.discard(); },
  });
  events = createEventLog(ctx, ctx.inTx);
  jobStream = createJobStreamRepository(ctx);
  return {
    jobs: createJobRepository(ctx),
    lanes: createLaneRepository(ctx),
    decisions: createDecisionRepository(ctx),
    events,
    webhooks: createWebhookRepository(ctx),
    vault: createVaultRepository(ctx),
    jobStream,
    questions: createQuestionRepository(ctx),
    reviews: { proposal: createReviewItemRepository(ctx, 'proposal'), research: createReviewItemRepository(ctx, 'research') },
    logins: createLoginRepository(ctx),
    failures: createFailureRepository(ctx),
    problems: createProblemRepository(ctx),
    handoffs: createHandoffRepository(ctx),
    settings: createUserSettingsRepository(ctx),
    connectedAccounts: createConnectedAccountRepository(ctx),
    usageHistory: createUsageHistoryRepository(ctx),
    machineHistory: createMachineHistoryRepository(ctx),
    config: createConfigRecords(ctx, USER_CONFIG),
    tx: ctx.tx,
    close: () => db.close(),
  };
}
