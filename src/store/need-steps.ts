// The need steps (issues #1524, #1568, instance migration 47): one row per need step or box step, from the job's ask
// to an hour after its result. The step as JSON, its inputs and outputs as bytes (across the store's text-only
// parameters as base64), its log as text. One step per job and key.
import { NEED_STEP_LOG_MAX, type NeedStep, type NeedStepRepository } from '../domain/need-steps.ts';
import { parse, type StoreContext } from './context.ts';

export const NEED_STEP_TABLE = `
  CREATE TABLE IF NOT EXISTS need_steps (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ended_at TEXT,
    body TEXT NOT NULL,
    inputs BYTEA,
    outputs BYTEA,
    log TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS need_steps_key ON need_steps (job_id, key);
  CREATE INDEX IF NOT EXISTS need_steps_ended ON need_steps (ended_at) WHERE ended_at IS NOT NULL`;

const CUT = '\n[hopper: the log is cut here; the step goes on]\n';

export function createNeedStepRepository(c: StoreContext): NeedStepRepository {
  const get = (id: string): NeedStep | undefined => {
    const r = c.db.get('SELECT body FROM need_steps WHERE id = ?', id);
    return r ? parse<NeedStep>(r.body) : undefined;
  };
  const bytes = (sql: string, id: string): Buffer | undefined => {
    const r = c.db.get(sql, id);
    return typeof r?.b === 'string' ? Buffer.from(r.b, 'base64') : undefined;
  };
  return {
    add(step, inputs) {
      c.db.run(`INSERT INTO need_steps (id, user_id, job_id, key, created_at, body, inputs) VALUES (?, ?, ?, ?, ?, ?, decode(?, 'base64'))
        ON CONFLICT DO NOTHING`, step.id, step.userId, step.jobId, step.key, step.createdAt, JSON.stringify(step), inputs.toString('base64'));
      return parse<NeedStep>(c.db.get('SELECT body FROM need_steps WHERE job_id = ? AND key = ?', step.jobId, step.key)!.body);
    },
    get,
    sagaIs(id, saga) {
      c.tx(() => {
        const s = get(id);
        if (s && s.saga !== saga) c.db.run('UPDATE need_steps SET body = ? WHERE id = ?', JSON.stringify({ ...s, saga }), id);
      });
    },
    inputs: (id) => bytes("SELECT encode(inputs, 'base64') AS b FROM need_steps WHERE id = ?", id),
    appendLog(id, given) {
      // Postgres keeps no NUL in text (22021): a step's output with NUL bytes keeps the rest (issue #2690).
      const text = given.replaceAll('\0', '');
      // Cut once at the most: the note that it is cut is the last of it.
      c.db.run(`UPDATE need_steps SET log = CASE WHEN length(log) + length(?::text) > ?::int THEN log || ?::text ELSE log || ?::text END
        WHERE id = ? AND right(log, ?::int) <> ?::text`, text, NEED_STEP_LOG_MAX, CUT, text, id, CUT.length, CUT);
    },
    log(id, from) {
      const r = c.db.get('SELECT substring(log from ?::int) AS t FROM need_steps WHERE id = ?', Math.max(0, from) + 1, id);
      const text = typeof r?.t === 'string' ? r.t : '';
      return { text, next: Math.max(0, from) + text.length };
    },
    end(id, result, at, outputs) {
      return c.tx(() => {
        const s = get(id);
        if (!s || s.endedAt !== undefined) return false;
        c.db.run("UPDATE need_steps SET ended_at = ?, body = ?, inputs = NULL, outputs = decode(?, 'base64') WHERE id = ?",
          at, JSON.stringify({ ...s, result, endedAt: at }), outputs ? outputs.toString('base64') : null, id);
        return true;
      });
    },
    outputs: (id) => bytes("SELECT encode(outputs, 'base64') AS b FROM need_steps WHERE id = ?", id),
    sweep(before) {
      c.db.run('DELETE FROM need_steps WHERE ended_at < ?', before);
    },
  };
}
