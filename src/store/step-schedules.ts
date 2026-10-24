// Step schedules and their runs (issue #2716, tenant migration 100, design.md "Step schedules"): one row per schedule, its
// fields as JSON; one row per run, its fields as JSON and its output as text. Two unique indexes make the claim of a run
// the database's: one run per schedule and due time (a run now has none), and one run not ended per schedule.
import { SCHEDULED_RUN_LOG_MAX, type ScheduledRun, type StepSchedule, type StepScheduleRepository } from '../domain/step-schedules.ts';
import { parse, type StoreContext } from './context.ts';

export const STEP_SCHEDULE_TABLES = `CREATE TABLE IF NOT EXISTS step_schedules (name TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS scheduled_runs (id TEXT PRIMARY KEY, schedule TEXT NOT NULL, due TEXT NOT NULL, trigger TEXT NOT NULL, started_at TEXT NOT NULL,
    ended_at TEXT, body TEXT NOT NULL, log TEXT NOT NULL DEFAULT '');
  CREATE UNIQUE INDEX IF NOT EXISTS scheduled_runs_due ON scheduled_runs (schedule, due) WHERE trigger = 'due';
  CREATE UNIQUE INDEX IF NOT EXISTS scheduled_runs_open ON scheduled_runs (schedule) WHERE ended_at IS NULL`;

const CUT = '\n[hopper: the output is cut here; the run goes on]\n';

export function createStepScheduleRepository(c: StoreContext): StepScheduleRepository {
  const run = (id: string): ScheduledRun | undefined => {
    const r = c.db.get('SELECT body FROM scheduled_runs WHERE id = ?', id);
    return r ? parse<ScheduledRun>(r.body) : undefined;
  };
  const runsOf = (sql: string, ...p: (string | number)[]): ScheduledRun[] => c.db.all(sql, ...p).map((r) => parse<ScheduledRun>(r.body));
  return {
    list: () => c.db.all('SELECT body FROM step_schedules ORDER BY name').map((r) => parse<StepSchedule>(r.body)),
    get(name) {
      const r = c.db.get('SELECT body FROM step_schedules WHERE name = ?', name);
      return r ? parse<StepSchedule>(r.body) : undefined;
    },
    put(s) {
      c.db.run('INSERT INTO step_schedules (name, body) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET body = excluded.body', s.name, JSON.stringify(s));
    },
    remove(name) {
      return c.tx(() => {
        c.db.run('DELETE FROM scheduled_runs WHERE schedule = ?', name);
        return c.db.run('DELETE FROM step_schedules WHERE name = ?', name).changes > 0;
      });
    },
    claim(r) {
      return c.db.run('INSERT INTO scheduled_runs (id, schedule, due, trigger, started_at, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        r.id, r.schedule, r.due, r.trigger, r.startedAt, JSON.stringify(r)).changes > 0;
    },
    run,
    runs: (schedule, limit = 1000) => runsOf('SELECT body FROM scheduled_runs WHERE schedule = ? ORDER BY started_at DESC, id LIMIT ?', schedule, limit),
    newest: () => new Map(runsOf(`SELECT DISTINCT ON (schedule) body FROM scheduled_runs ORDER BY schedule, started_at DESC, id`).map((r) => [r.schedule, r])),
    open: () => runsOf('SELECT body FROM scheduled_runs WHERE ended_at IS NULL'),
    sagaIs(id, saga) {
      c.tx(() => {
        const r = run(id);
        if (r && r.saga !== saga) c.db.run('UPDATE scheduled_runs SET body = ? WHERE id = ?', JSON.stringify({ ...r, saga }), id);
      });
    },
    appendLog(id, given) {
      // Postgres keeps no NUL in text (22021); cut once at the most: the note that it is cut is the last of it.
      const text = given.replaceAll('\0', '');
      c.db.run(`UPDATE scheduled_runs SET log = CASE WHEN length(log) + length(?::text) > ?::int THEN log || ?::text ELSE log || ?::text END
        WHERE id = ? AND right(log, ?::int) <> ?::text`, text, SCHEDULED_RUN_LOG_MAX, CUT, text, id, CUT.length, CUT);
    },
    log: (id) => String(c.db.get('SELECT log FROM scheduled_runs WHERE id = ?', id)?.log ?? ''),
    end(id, end) {
      return c.tx(() => {
        const r = run(id);
        if (!r || r.endedAt !== undefined) return false;
        c.db.run('UPDATE scheduled_runs SET ended_at = ?, body = ? WHERE id = ?', end.endedAt, JSON.stringify({ ...r, ...end, ...(end.problem === undefined ? {} : { problem: end.problem }) }), id);
        return true;
      });
    },
    sweep(keep) {
      c.db.run(`DELETE FROM scheduled_runs WHERE ended_at IS NOT NULL AND id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY schedule ORDER BY started_at DESC, id) AS n
        FROM scheduled_runs) ranked WHERE n > ?)`, keep);
    },
  };
}
