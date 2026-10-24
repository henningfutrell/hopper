// The Windows steps (issue #1611, instance migration 49): one row per Windows sandbox step, from the job's ask to an
// hour after its result. The step as JSON, its inputs and outputs as bytes (across the store's text-only parameters as
// base64), its log as text. One step per job and key. The host lease is two columns: `leased_at`, once the step took
// its host, and `lease_host`, the host it has the lease on now; a unique index gives one step of a user a host at a time.
import { STEP_LOG_MAX, type WindowsStep, type WindowsStepRepository } from '../domain/windows-steps.ts';
import { parse, type StoreContext } from './context.ts';
import type { Row } from './db.ts';

export const WINDOWS_STEP_TABLE = `
  CREATE TABLE IF NOT EXISTS windows_steps (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    key TEXT NOT NULL,
    host TEXT NOT NULL,
    created_at TEXT NOT NULL,
    leased_at TEXT,
    lease_host TEXT,
    ended_at TEXT,
    body TEXT NOT NULL,
    inputs BYTEA,
    outputs BYTEA,
    log TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS windows_steps_key ON windows_steps (job_id, key);
  CREATE UNIQUE INDEX IF NOT EXISTS windows_steps_lease ON windows_steps (user_id, lease_host) WHERE lease_host IS NOT NULL;
  CREATE INDEX IF NOT EXISTS windows_steps_ended ON windows_steps (ended_at) WHERE ended_at IS NOT NULL`;

const CUT = '\n[hopper: the log is cut here; the step goes on]\n';
const COLUMNS = 'body, leased_at, lease_host';

const stepOf = (r: Row): WindowsStep => ({
  ...parse<WindowsStep>(r.body),
  ...(typeof r.leased_at === 'string' ? { leasedAt: r.leased_at } : {}), ...(r.lease_host ? { hostLeased: true as const } : {}),
});

export function createWindowsStepRepository(c: StoreContext): WindowsStepRepository {
  const get = (id: string): WindowsStep | undefined => {
    const r = c.db.get(`SELECT ${COLUMNS} FROM windows_steps WHERE id = ?`, id);
    return r ? stepOf(r) : undefined;
  };
  const bytes = (sql: string, id: string): Buffer | undefined => {
    const r = c.db.get(sql, id);
    return typeof r?.b === 'string' ? Buffer.from(r.b, 'base64') : undefined;
  };
  /** The body as kept: the host lease's fields are columns only. */
  const body = ({ leasedAt: _l, hostLeased: _h, ...s }: WindowsStep): string => JSON.stringify(s);
  return {
    add(step, inputs) {
      c.db.run(`INSERT INTO windows_steps (id, user_id, job_id, key, host, created_at, body, inputs) VALUES (?, ?, ?, ?, ?, ?, ?, decode(?, 'base64'))
        ON CONFLICT DO NOTHING`, step.id, step.userId, step.jobId, step.key, step.host, step.createdAt, body(step), inputs.toString('base64'));
      return stepOf(c.db.get(`SELECT ${COLUMNS} FROM windows_steps WHERE job_id = ? AND key = ?`, step.jobId, step.key)!);
    },
    get,
    sagaIs(id, saga) {
      c.tx(() => {
        const s = get(id);
        if (s && s.saga !== saga) c.db.run('UPDATE windows_steps SET body = ? WHERE id = ?', body({ ...s, saga }), id);
      });
    },
    inputs: (id) => bytes("SELECT encode(inputs, 'base64') AS b FROM windows_steps WHERE id = ?", id),
    appendLog(id, given) {
      // Postgres keeps no NUL in text (22021), and wsl.exe writes UTF-16LE: without its NULs, its text reads (issue #2690).
      const text = given.replaceAll('\0', '');
      // Cut once at the most: the note that it is cut is the last of it.
      c.db.run(`UPDATE windows_steps SET log = CASE WHEN length(log) + length(?::text) > ?::int THEN log || ?::text ELSE log || ?::text END
        WHERE id = ? AND right(log, ?::int) <> ?::text`, text, STEP_LOG_MAX, CUT, text, id, CUT.length, CUT);
    },
    log(id, from) {
      const r = c.db.get('SELECT substring(log from ?::int) AS t FROM windows_steps WHERE id = ?', Math.max(0, from) + 1, id);
      const text = typeof r?.t === 'string' ? r.t : '';
      return { text, next: Math.max(0, from) + text.length };
    },
    end(id, result, at, outputs) {
      return c.tx(() => {
        const s = get(id);
        if (!s || s.endedAt !== undefined) return false;
        c.db.run("UPDATE windows_steps SET ended_at = ?, body = ?, inputs = NULL, outputs = decode(?, 'base64') WHERE id = ?",
          at, body({ ...s, result, endedAt: at }), outputs ? outputs.toString('base64') : null, id);
        return true;
      });
    },
    outputs: (id) => bytes("SELECT encode(outputs, 'base64') AS b FROM windows_steps WHERE id = ?", id),
    leaseHost(id, at) {
      try {
        return c.db.run(`UPDATE windows_steps SET leased_at = ?, lease_host = host WHERE id = ? AND leased_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM windows_steps o WHERE o.user_id = windows_steps.user_id AND o.lease_host = windows_steps.host)`, at, id).changes > 0;
      } catch {
        // Another host's step took the host in the same instant: the unique index refused this one.
        return false;
      }
    },
    runAgain(id) {
      c.tx(() => {
        const s = get(id);
        if (!s || s.endedAt !== undefined) return;
        const { stopped: _stopped, ...run } = s;
        c.db.run('UPDATE windows_steps SET body = ? WHERE id = ?', body({ ...run, runs: (s.runs ?? 1) + 1 }), id);
      });
    },
    stopped(id) {
      c.tx(() => {
        const s = get(id);
        if (s && s.endedAt === undefined && !s.stopped) c.db.run('UPDATE windows_steps SET body = ? WHERE id = ?', body({ ...s, stopped: true }), id);
      });
    },
    releaseHost(id) {
      c.db.run('UPDATE windows_steps SET lease_host = NULL WHERE id = ?', id);
    },
    sweep(before) {
      c.db.run('DELETE FROM windows_steps WHERE ended_at < ? AND lease_host IS NULL', before);
    },
  };
}
