// The sandbox runs (issue #1349, instance migration 42, design.md "Sandboxes are burned after each step"): one row per
// sandbox the hopper made for a step, in the instance schema, the run as JSON, with the columns read by.
import type { SandboxRun, SandboxRunRepository } from '../domain/sandbox-runs.ts';
import { parse, type StoreContext } from './context.ts';

export const SANDBOX_RUN_TABLE = `
  CREATE TABLE IF NOT EXISTS sandbox_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    destroyed_at TEXT,
    body TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sandbox_runs_user ON sandbox_runs (user_id, started_at);
  CREATE INDEX IF NOT EXISTS sandbox_runs_open ON sandbox_runs (started_at) WHERE destroyed_at IS NULL`;

export function createSandboxRunRepository(c: StoreContext): SandboxRunRepository {
  const get = (id: string): SandboxRun | undefined => {
    const r = c.db.get('SELECT body FROM sandbox_runs WHERE id = ?', id);
    return r ? parse<SandboxRun>(r.body) : undefined;
  };
  const write = (run: SandboxRun): void => {
    c.db.run('UPDATE sandbox_runs SET destroyed_at = ?, body = ? WHERE id = ?', run.destroyedAt ?? null, JSON.stringify(run), run.id);
  };
  return {
    start(run) {
      c.db.run('INSERT INTO sandbox_runs (id, user_id, started_at, destroyed_at, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', run.id, run.userId, run.startedAt, run.destroyedAt ?? null, JSON.stringify(run));
    },
    end(id, e) {
      const run = get(id);
      if (!run || run.endedAt !== undefined) return;
      write({ ...run, endedAt: e.at, outcome: e.outcome, ...(e.exit !== undefined ? { exit: e.exit } : {}), ...(e.problem ? { problem: e.problem } : {}) });
    },
    destroyed(id, at, o) {
      const run = get(id);
      if (!run || run.destroyedAt !== undefined) return;
      write({ ...run, destroyedAt: at, ...(o?.machineRemoved ? { machineRemoved: true as const } : {}) });
    },
    get,
    open: () => c.db.all('SELECT body FROM sandbox_runs WHERE destroyed_at IS NULL ORDER BY started_at').map((r) => parse<SandboxRun>(r.body)),
    latest: (userId, limit) => c.db.all('SELECT body FROM sandbox_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?', userId, limit).map((r) => parse<SandboxRun>(r.body)),
  };
}
