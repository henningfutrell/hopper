import { randomUUID } from 'node:crypto';
import type { Clock, IdGen, Store } from '../domain/ports.ts';
import type { StoreContext } from './context.ts';
import { openDb } from './db.ts';
import { createDecisionRepository } from './decisions.ts';
import { createConfigDocuments } from './documents.ts';
import { createLoginCodeRepository } from './login-codes.ts';
import { createEventLog } from './events.ts';
import { createJobRepository } from './jobs.ts';
import { createLaneRepository } from './lanes.ts';
import { createQuestionRepository } from './questions.ts';
import { migrate } from './migrations.ts';
import { createSettingsRepository } from './settings.ts';
import { createUiSessionRepository } from './ui-sessions.ts';
import { createWebhookRepository } from './webhooks.ts';


/** `url`: JOB_HOPPER_DATABASE_URL, `postgres://…` (design.md "Database"). */
export function openStore(o: { url: string; clock: Clock; idGen?: IdGen }): Store {
  const db = openDb(o.url);
  try {
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }

  let depth = 0;
  // eslint-disable-next-line prefer-const -- events needs ctx, ctx.tx needs events
  let events: ReturnType<typeof createEventLog>;
  const ctx: StoreContext = {
    db,
    clock: o.clock,
    idGen: o.idGen ?? randomUUID,
    tx<T>(fn: () => T): T {
      if (depth > 0) {
        depth++;
        try { return fn(); } finally { depth--; }
      }
      db.exec('BEGIN');
      depth = 1;
      let result: T;
      try {
        result = fn();
        db.exec('COMMIT');
      } catch (e) {
        depth = 0;
        events.discard();
        db.exec('ROLLBACK');
        throw e;
      }
      depth = 0;
      events.flush();
      return result;
    },
  };
  events = createEventLog(ctx, () => depth > 0);

  return {
    jobs: createJobRepository(ctx),
    lanes: createLaneRepository(ctx),
    decisions: createDecisionRepository(ctx),
    events,
    webhooks: createWebhookRepository(ctx),
    questions: createQuestionRepository(ctx),
    settings: createSettingsRepository(ctx),
    uiSessions: createUiSessionRepository(ctx),
    documents: createConfigDocuments(ctx),
    loginCodes: createLoginCodeRepository(ctx),
    tx: ctx.tx,
    close: () => db.close(),
  };
}
