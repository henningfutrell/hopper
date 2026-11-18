// The daily usage trend (issue #2966 part 4, tenant migration 110): one row per account and UTC day, counts only. The
// `claude-analytics` usage source keeps each day it read; a day read again is one row, with the newest counts.
import type { DailyUsageRepository } from '../domain/daily-usage.ts';
import type { DailyUsage } from '../domain/usage.ts';
import type { StoreContext } from './context.ts';

export const DAILY_USAGE_TABLE = `CREATE TABLE daily_usage (account TEXT NOT NULL, date TEXT NOT NULL, cost_cents DOUBLE PRECISION NOT NULL,
  input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL, cache_read_tokens BIGINT NOT NULL, cache_creation_tokens BIGINT NOT NULL,
  sessions INTEGER NOT NULL, commits INTEGER NOT NULL, pull_requests INTEGER NOT NULL, lines_added BIGINT NOT NULL, lines_removed BIGINT NOT NULL,
  accepted INTEGER NOT NULL, rejected INTEGER NOT NULL, PRIMARY KEY (account, date))`;

const COLUMNS = 'account, date, cost_cents, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, sessions, commits, pull_requests, lines_added, lines_removed, accepted, rejected';
const n = (v: unknown): number => Number(v);

function rowOf(r: Record<string, unknown>): DailyUsage {
  return {
    account: String(r.account), date: String(r.date), costCents: n(r.cost_cents),
    tokens: { input: n(r.input_tokens), output: n(r.output_tokens), cacheRead: n(r.cache_read_tokens), cacheCreation: n(r.cache_creation_tokens) },
    sessions: n(r.sessions), commits: n(r.commits), pullRequests: n(r.pull_requests), linesAdded: n(r.lines_added), linesRemoved: n(r.lines_removed),
    toolActions: { accepted: n(r.accepted), rejected: n(r.rejected) },
  };
}

export function createDailyUsageRepository(c: StoreContext): DailyUsageRepository {
  return {
    keep(days, keepFrom) {
      c.tx(() => {
        for (const d of days) {
          c.db.run(`INSERT INTO daily_usage (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (account, date) DO UPDATE SET ${COLUMNS.split(', ').slice(2).map((k) => `${k} = excluded.${k}`).join(', ')}`,
          d.account, d.date, d.costCents, d.tokens.input, d.tokens.output, d.tokens.cacheRead, d.tokens.cacheCreation,
          d.sessions, d.commits, d.pullRequests, d.linesAdded, d.linesRemoved, d.toolActions.accepted, d.toolActions.rejected);
        }
        c.db.run('DELETE FROM daily_usage WHERE date < ?', keepFrom);
      });
    },
    since(from) {
      return c.db.all(`SELECT ${COLUMNS} FROM daily_usage WHERE date >= ? ORDER BY date, account`, from).map(rowOf);
    },
  };
}
