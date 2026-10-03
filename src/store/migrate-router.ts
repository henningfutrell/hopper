// Migration 4: Jev → router names in stored rows (design.md "Persisted-state migrations").
// Rows are rewritten field by field; nothing is dropped — `jevUsed` moves into `details`.
// Stored events are not rewritten: they keep their v1 payloads and are read by version.
import type { DatabaseSync } from 'node:sqlite';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{ …, jevUsed, details }` → `{ …, details: { …details, jevUsed } }`. */
function renameAdvice(a: Obj): Obj {
  const { jevUsed, details, ...rest } = a;
  return { ...rest, details: { ...(isObj(details) ? details : {}), ...(jevUsed === undefined ? {} : { jevUsed }) } };
}

export function renameJob(job: Obj): Obj {
  if (!('jevAdvice' in job)) return job;
  const { jevAdvice, ...rest } = job;
  return isObj(jevAdvice) ? { ...rest, advice: renameAdvice(jevAdvice) } : rest;
}

function renameMode(o: Obj): Obj {
  if (!('jevMode' in o)) return o;
  const { jevMode, ...rest } = o;
  return { ...rest, routerMode: jevMode };
}

function renameInputs(inputs: Obj): Obj {
  const out = renameMode(inputs);
  if (isObj(out.policy) && 'jevCheapBoost' in out.policy) {
    const { jevCheapBoost, ...policy } = out.policy;
    out.policy = { ...policy, routerCheapBoost: jevCheapBoost };
  }
  for (const key of ['waiting', 'running']) {
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map((j) => (isObj(j) ? renameJob(j) : j));
  }
  return out;
}

function renameDivergence(x: unknown): unknown {
  if (!isObj(x) || !('withJev' in x)) return x;
  const { withJev, ...div } = x;
  return { ...div, withAdvice: withJev };
}

export function renameDecision(d: Obj): Obj {
  const out = renameMode(d);
  const { jev, ...rest } = out;
  const renamed: Obj = 'jev' in out ? { ...rest, advice: Array.isArray(jev) ? jev.map(renameDivergence) : jev } : out;
  if (isObj(renamed.inputs)) renamed.inputs = renameInputs(renamed.inputs);
  return renamed;
}

function rewrite(db: DatabaseSync, table: 'jobs' | 'decisions', fn: (o: Obj) => Obj): void {
  const update = db.prepare(`UPDATE ${table} SET body = ? WHERE seq = ?`);
  for (const row of db.prepare(`SELECT seq, body FROM ${table}`).all()) {
    const before = row.body as string;
    const after = JSON.stringify(fn(JSON.parse(before) as Obj));
    if (after !== before) update.run(after, row.seq as number);
  }
}

export function migrateRouterNames(db: DatabaseSync): void {
  rewrite(db, 'jobs', renameJob);
  rewrite(db, 'decisions', renameDecision);
  db.exec("UPDATE settings SET key = 'routerMode' WHERE key = 'jevMode'");
}
