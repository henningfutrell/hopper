// Fold one user into another (issue #265, design.md "The leftover default admin account"): the work of
// the user schema `from` joins the user schema `keep`. Rows keyed by id (jobs, questions, decisions,
// events, webhooks and their deliveries) all move, in their order, after `keep`'s; a row whose key `keep`
// already holds (a lane's machine and number, a webhook's name, a setting, a config record) is `keep`'s.
// Two exceptions: the plugins config takes the instances only `from` names, and the connected account is
// `from`'s — its user's own connection, its tokens in the vault with it (issue #658). The work-item ledger (issue #1067)
// does not move: `keep`'s store rebuilds it from the moved events when it next opens; nor do the event cursors (issue #1572)
// or the kept-track pass's cursor (issue #2775).
// Runs inside the caller's transaction.
import type { Db, Param } from './db.ts';
import { quoteIdent } from './tenant-migrations.ts';

/** Sections of the plugins config that list a user's own instances under unique names: `from`'s other names join. */
const INSTANCE_LISTS = ['executors', 'jobSources', 'machines', 'usageSources', 'notifiers'] as const;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const nameOf = (v: unknown): unknown => (isObject(v) ? v.name : undefined);

/** `keep`'s plugins config with what only `from`'s has: a section it lacks, and the instances it does not name. */
export function foldPluginsConfig(keep: unknown, from: unknown): unknown {
  if (!isObject(keep) || !isObject(from)) return keep;
  const out: Json = { ...keep };
  for (const [section, value] of Object.entries(from)) {
    if (!(section in out)) out[section] = value;
    else if ((INSTANCE_LISTS as readonly string[]).includes(section) && Array.isArray(out[section]) && Array.isArray(value)) {
      const names = new Set((out[section] as unknown[]).map(nameOf));
      out[section] = [...(out[section] as unknown[]), ...value.filter((v) => !names.has(nameOf(v)))];
    }
  }
  return out;
}

/** A table's columns that take a value: a generated column (job-filter-columns.ts) is computed from the row, never copied. */
const columnsOf = (db: Db, schema: string, table: string): string[] =>
  db.all("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND is_generated = 'NEVER' ORDER BY ordinal_position", schema, table)
    .map((r) => String(r.c));

/** Move every row of `from`'s schema into `keep`'s; `from`'s schema is left as it was, for the caller to drop. */
export function foldUserSchema(db: Db, keep: string, from: string): void {
  const k = quoteIdent(keep);
  const f = quoteIdent(from);
  const tables = db.all("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", from)
    .map((r) => String(r.t)).filter((t) => !['schema_version', 'work_items', 'work_items_applied', 'event_cursors', 'delivery_track_cursor'].includes(t));
  // Deliveries name their subscription and their event: after webhooks and events.
  const ordered = [...tables.filter((t) => t !== 'deliveries'), ...tables.filter((t) => t === 'deliveries')];
  for (const table of ordered) {
    const theirs = columnsOf(db, from, table);
    const ours = new Set(columnsOf(db, keep, table));
    if (ours.size === 0) continue;
    const cols = theirs.filter((c) => c !== 'seq' && ours.has(c));
    const list = cols.map(quoteIdent).join(', ');
    const order = theirs.includes('seq') ? ' ORDER BY seq' : '';
    const t = quoteIdent(table);
    if (table === 'config') {
      for (const r of db.all(`SELECT name, value, updated_at FROM ${f}.config`)) {
        const mine = db.get(`SELECT value FROM ${k}.config WHERE name = ?`, r.name as Param);
        if (!mine) db.run(`INSERT INTO ${k}.config (name, value, updated_at) VALUES (?, ?, ?)`, r.name as Param, r.value as Param, r.updated_at as Param);
        else if (r.name === 'plugins') {
          const next = JSON.stringify(foldPluginsConfig(JSON.parse(String(mine.value)), JSON.parse(String(r.value))));
          if (next !== String(mine.value)) db.run(`UPDATE ${k}.config SET value = ?, updated_at = ? WHERE name = 'plugins'`, next, new Date().toISOString());
        }
      }
    } else if (table === 'connected_accounts') {
      db.run(`DELETE FROM ${k}.${t} WHERE provider IN (SELECT provider FROM ${f}.${t})`);
      db.run(`INSERT INTO ${k}.${t} (${list}) SELECT ${list} FROM ${f}.${t}`);
    } else if (table === 'vault_secrets') {
      // A connection's tokens (issue #658) are `from`'s with its connection: `keep`'s go first, so none is left beside them.
      db.run(`DELETE FROM ${k}.${t} WHERE name LIKE 'system/connected-account.%' AND EXISTS (SELECT 1 FROM ${f}.connected_accounts)`);
      db.run(`INSERT INTO ${k}.${t} (${list}) SELECT ${list} FROM ${f}.${t}${order} ON CONFLICT DO NOTHING`);
    } else if (table === 'deliveries') {
      // Only a moved subscription's; its event by its new seq (the dispatcher reads the event by it).
      for (const r of db.all(`SELECT ${list} FROM ${f}.deliveries WHERE subscription_id IN (SELECT id FROM ${k}.webhooks) ORDER BY seq`)) {
        const body = JSON.parse(String(r.body)) as Json;
        const moved = typeof body.eventSeq === 'number'
          ? db.get(`SELECT e.seq FROM ${k}.events e JOIN ${f}.events o ON o.id = e.id WHERE o.seq = ?`, body.eventSeq) : undefined;
        if (moved) body.eventSeq = Number(moved.seq);
        const row: Record<string, unknown> = { ...r, body: JSON.stringify(body) };
        db.run(`INSERT INTO ${k}.deliveries (${list}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`, ...cols.map((c) => row[c] as Param));
      }
    } else {
      db.run(`INSERT INTO ${k}.${t} (${list}) SELECT ${list} FROM ${f}.${t}${order} ON CONFLICT DO NOTHING`);
    }
  }
  // The event cursors (issue #1572) stay `keep`'s, past the moved events: a consumer is not handed `from`'s history again.
  if (columnsOf(db, keep, 'event_cursors').length > 0) db.run(`UPDATE ${k}.event_cursors SET seq = (SELECT COALESCE(MAX(seq), 0) FROM ${k}.events)`);
  // So does the kept-track pass's (issue #2775): `from`'s tracks moved with their events.
  if (columnsOf(db, keep, 'delivery_track_cursor').length > 0) db.run(`UPDATE ${k}.delivery_track_cursor SET seq = (SELECT COALESCE(MAX(seq), 0) FROM ${k}.events)`);
}
