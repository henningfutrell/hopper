import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Clock, IdGen, Store } from '../domain/ports.ts';
import type { StoreContext } from './context.ts';
import { createDecisionRepository } from './decisions.ts';
import { createEventLog } from './events.ts';
import { createJobRepository } from './jobs.ts';
import { createLaneRepository } from './lanes.ts';
import { createQuestionRepository } from './questions.ts';
import { migrate } from './migrations.ts';
import { createSettingsRepository } from './settings.ts';
import { createWebhookRepository } from './webhooks.ts';

export function openStore(o: { path: string; clock: Clock; idGen?: IdGen }): Store {
  mkdirSync(dirname(o.path), { recursive: true });
  const db = new DatabaseSync(o.path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);

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
      db.exec('BEGIN IMMEDIATE');
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
    tx: ctx.tx,
    close: () => db.close(),
  };
}
