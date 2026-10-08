// Tenant migration 20 (issue #485): a question stored before the raising machine was recorded gets it where
// it can be known — the lane of its `question.asked` event, else its job's `resumeOn`, else its job's machine
// pin — with the name from the machines config while that machine is still in it (its `label` option, else
// its instance name). A question with no source stays without one. Only `raisedBy` is added; a question that
// has one is left alone, so a second run changes nothing. Events are never rewritten.
import { raisedBy } from '../domain/raised-by.ts';
import type { Db } from './db.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The configured machines by id, with the name people read. */
function machineNames(db: Db): Map<string, string> {
  const row = db.get("SELECT value FROM config WHERE name = 'plugins'");
  const doc = row ? JSON.parse(String(row.value)) as unknown : undefined;
  const machines = isObj(doc) && Array.isArray(doc.machines) ? doc.machines : [];
  const names = new Map<string, string>();
  for (const m of machines) {
    const name = isObj(m) ? str(m.name) : undefined;
    if (name) names.set(name, str(isObj(m.options) ? m.options.label : undefined) ?? name);
  }
  return names;
}

export function raisedByBackfill(db: Db): void {
  const machines = machineNames(db);
  for (const row of db.all('SELECT id, job_id, body FROM questions')) {
    const q = JSON.parse(String(row.body)) as Obj;
    if (q.raisedBy !== undefined) continue;
    const laneId = str(db.get("SELECT lane_id FROM events WHERE type = 'question.asked' AND question_id = ? ORDER BY seq LIMIT 1", String(row.id))?.lane_id);
    const jobRow = db.get('SELECT body FROM jobs WHERE id = ?', String(row.job_id));
    const job = jobRow ? JSON.parse(String(jobRow.body)) as Obj : {};
    const pin = isObj(job.spec) ? str(job.spec.machineId) : undefined;
    const raised = raisedBy({ laneId, resumeOn: str(job.resumeOn), pin, machines });
    if (raised) db.run('UPDATE questions SET body = ? WHERE id = ?', JSON.stringify({ ...q, raisedBy: raised }), String(row.id));
  }
}
