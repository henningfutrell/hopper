// The work-item ledger in the database (issue #1067, tenant migration 55): one row per work item, written only here, by
// the pure reducer (src/domain/work-items.ts), in the same transaction as the event or the issue graph read that moves it
// — so two daemons on one database cannot fork it. `rebuild` replays every event and the issue graph's nodes through the
// same reducer: the migration's backfill and `hopper ledger rebuild`. Each row keeps its owner, next check and deadline
// (issue #1891, `checkOf`): what the item reconciler reads.
import type { EventType } from '../domain/types.ts';
import type { GraphNode } from '../domain/issue-graph.ts';
import {
  applyEvent, applyLandingEvent, applyRead, inFlightOf, countStates, IN_FLIGHT_STATES, jobIdOfEvent, keyOfEvent, LEDGER_EVENT_TYPES,
  type LedgerJob, type WorkItem, type WorkItemLedger, type WorkItemState,
} from '../domain/work-items.ts';
import { LANDING_LEDGER_EVENTS, landingTargets } from '../domain/work-item-landing.ts';
import { checkOf, ENDED_STATES } from '../domain/item-lifecycle.ts';
import type { Db } from './db.ts';
import { parse } from './context.ts';

export const WORK_ITEM_TABLE = `
  CREATE TABLE work_items (
    key TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    state_since TEXT NOT NULL,
    job_id TEXT,
    pull_request TEXT,
    version INTEGER NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX work_items_state ON work_items (state);
  CREATE INDEX work_items_pull_request ON work_items (pull_request);
  CREATE TABLE work_items_applied (one INTEGER PRIMARY KEY CHECK (one = 1), seq BIGINT NOT NULL);
  INSERT INTO work_items_applied (one, seq) VALUES (1, 0)`;

/**
 * The owner, next check and deadline of each row (issue #1891, tenant migration 82): added by every rebuild when the table
 * has none, so a rebuild of an older migration on a store from before them writes them too.
 */
const CHECK_COLUMNS = 'ALTER TABLE work_items ADD COLUMN IF NOT EXISTS owner TEXT, ADD COLUMN IF NOT EXISTS next_check_at TEXT, ADD COLUMN IF NOT EXISTS deadline TEXT';

/** Tenant migration 55: the ledger's tables, filled from every event and the issue graph. */
export const workItemLedger = (db: Db): void => {
  db.exec(WORK_ITEM_TABLE);
  rebuildWorkItems(db);
};

const jobOfRow = (r: Record<string, unknown>): LedgerJob | undefined => {
  if (r.source_key === null || r.source_key === undefined) return undefined;
  return {
    id: String(r.id), key: String(r.source_key),
    ...(r.kind !== null && r.kind !== undefined ? { kind: String(r.kind) } : {}),
    ...(r.pull_request !== null && r.pull_request !== undefined ? { pullRequest: String(r.pull_request) } : {}),
  };
};
const JOB_COLUMNS = "id, source_key, body::jsonb->'source'->>'kind' AS kind, body::jsonb->'sourceState'->'source'->>'pullRequest' AS pull_request";

/**
 * The job of a `job.finished` (event `seq`) whose report named no pull request yet (issue #2693): with the newest pull request
 * it opened through the hopper before that end (`github_proxy.done` of op `pr.create`), so its own result names what it waits
 * on, whatever GitHub's search or links say and however late its report comes.
 */
function withOpened(db: Db, job: LedgerJob | undefined, type: EventType, seq: number): LedgerJob | undefined {
  if (job === undefined || type !== 'job.finished' || job.pullRequest !== undefined) return job;
  const r = db.get("SELECT data::jsonb->>'url' AS url FROM events WHERE job_id = ? AND seq < ? AND type = 'github_proxy.done' AND data::jsonb->>'op' = 'pr.create' AND data::jsonb->>'url' IS NOT NULL ORDER BY seq DESC LIMIT 1", job.id, seq);
  return r ? { ...job, pullRequest: String(r.url) } : job;
}

/** What a node of the issue graph says to the ledger: an issue's state and why it closed, or a pull request's state. */
function readsOf(node: GraphNode, readAt: string): { key: string; read: Parameters<typeof applyRead>[1] } | { pullRequest: string; read: Parameters<typeof applyRead>[1] } | undefined {
  const state = node.attrs.state;
  if (typeof state !== 'string') return undefined;
  if (node.kind === 'issue') {
    const reason = node.attrs.stateReason;
    return { key: node.id, read: { kind: 'issue', at: readAt, state, ...(typeof reason === 'string' ? { reason } : {}) } };
  }
  if (node.kind === 'pull_request') return { pullRequest: node.id, read: { kind: 'pull_request', url: node.id, state } };
  return undefined;
}

const put = (db: Db, i: WorkItem): void => {
  const check = checkOf(i.state, i.eventAt);
  db.run(`INSERT INTO work_items (key, state, state_since, job_id, pull_request, version, body, owner, next_check_at, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state, state_since = EXCLUDED.state_since, job_id = EXCLUDED.job_id,
      pull_request = EXCLUDED.pull_request, version = EXCLUDED.version, body = EXCLUDED.body, owner = EXCLUDED.owner,
      next_check_at = EXCLUDED.next_check_at, deadline = EXCLUDED.deadline`,
  i.key, i.state, i.stateSince, i.jobId ?? null, i.pullRequest ?? null, i.version, JSON.stringify(i), check?.owner ?? null, check?.nextCheckAt ?? null, check?.deadline ?? null);
};

/** How many events a rebuild reads at a time. */
const REBUILD_PAGE = 5000;

/** Replay every event and the issue graph's nodes through the reducer, in place of the rows there are. Over `db` alone: the migration's backfill too. */
export function rebuildWorkItems(db: Db): number {
  db.exec(CHECK_COLUMNS);
  const jobs = new Map<string, LedgerJob>();
  for (const r of db.all(`SELECT ${JOB_COLUMNS} FROM jobs`)) {
    const j = jobOfRow(r);
    if (j) jobs.set(j.id, j);
  }
  const items = new Map<string, WorkItem>();
  const types = [...LEDGER_EVENT_TYPES] as EventType[];
  const marks = types.map(() => '?').join(',');
  for (let after = 0; ;) {
    const rows = db.all(`SELECT seq, type, at, job_id, data FROM events WHERE seq > ? AND type IN (${marks}) ORDER BY seq LIMIT ?`, after, ...types, REBUILD_PAGE);
    for (const r of rows) {
      const event = { type: r.type as EventType, at: String(r.at), data: parse<Record<string, unknown>>(r.data), ...(r.job_id !== null ? { jobId: String(r.job_id) } : {}) };
      if (LANDING_LEDGER_EVENTS.has(event.type)) {
        for (const i of items.values()) {
          const next = applyLandingEvent(i, event);
          if (next) items.set(i.key, next);
        }
        continue;
      }
      const jobId = jobIdOfEvent(event);
      const job = withOpened(db, jobId !== undefined ? jobs.get(jobId) : undefined, event.type, Number(r.seq));
      const key = job?.key ?? keyOfEvent(event);
      if (key === undefined) continue;
      const next = applyEvent(items.get(key), event, key, job);
      if (next) items.set(key, next);
    }
    if (rows.length < REBUILD_PAGE) break;
    after = Number(rows.at(-1)!.seq);
  }
  // What the issue graph's reads last said of each issue and pull request.
  const byPullRequest = new Map<string, string[]>();
  for (const i of items.values()) if (i.pullRequest) byPullRequest.set(i.pullRequest, [...byPullRequest.get(i.pullRequest) ?? [], i.key]);
  for (const r of db.all("SELECT id, kind, attrs, read_at FROM graph_nodes WHERE kind IN ('issue', 'pull_request')")) {
    const node: GraphNode = { id: String(r.id), kind: r.kind as GraphNode['kind'], attrs: parse(r.attrs) };
    const at = r.read_at !== null ? String(r.read_at) : '';
    const reads = readsOf(node, at);
    if (!reads) continue;
    for (const key of 'key' in reads ? [reads.key] : byPullRequest.get(reads.pullRequest) ?? []) {
      const item = items.get(key);
      const next = item && applyRead(item, reads.read);
      if (next) items.set(key, next);
    }
  }
  db.run('DELETE FROM work_items');
  for (const i of items.values()) put(db, i);
  db.run('UPDATE work_items_applied SET seq = (SELECT coalesce(max(seq), 0) FROM events)');
  return items.size;
}

/**
 * The ledger over `db`. `catchUp`: rebuild when an event it reads was appended without it — by the build before, on a
 * store moved to an older update channel — and answer how many items; undefined when it missed none.
 */
export function createWorkItemLedger(db: Db, tx: <T>(fn: () => T) => T): WorkItemLedger & { catchUp(): number | undefined } {
  const get = (key: string): WorkItem | undefined => {
    const r = db.get('SELECT body FROM work_items WHERE key = ?', key);
    return r ? parse<WorkItem>(r.body) : undefined;
  };
  return {
    applyEvent(event) {
      if (!LEDGER_EVENT_TYPES.has(event.type)) return;
      if (LANDING_LEDGER_EVENTS.has(event.type)) {
        db.run('UPDATE work_items_applied SET seq = ?', event.seq);
        const t = landingTargets(event);
        if (!t) return;
        // The items of the event's repository with a merged pull request; the reducer picks the ones it moves.
        for (const r of db.all("SELECT body FROM work_items WHERE lower(pull_request) LIKE ? AND body::jsonb->>'pullRequestState' = 'merged'", `%/${t.repo.replace(/[\\%_]/g, '\\$&')}/pull/%`)) {
          const next = applyLandingEvent(parse<WorkItem>(r.body), event);
          if (next) put(db, next);
        }
        return;
      }
      const jobId = jobIdOfEvent(event);
      const job = withOpened(db, jobId !== undefined ? jobOfRow(db.get(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, jobId) ?? {}) : undefined, event.type, event.seq);
      const key = job?.key ?? keyOfEvent(event);
      db.run('UPDATE work_items_applied SET seq = ?', event.seq);
      if (key === undefined) return;
      const next = applyEvent(get(key), event, key, job);
      if (next) put(db, next);
    },
    applyNodes(nodes, readAt) {
      for (const node of nodes) {
        const reads = readsOf(node, readAt);
        if (!reads) continue;
        const keys = 'key' in reads ? [reads.key] : db.all('SELECT key FROM work_items WHERE pull_request = ?', reads.pullRequest).map((r) => String(r.key));
        for (const key of keys) {
          const item = get(key);
          const next = item && applyRead(item, reads.read);
          if (next) put(db, next);
        }
      }
    },
    get,
    byPullRequest(url) {
      const r = db.get('SELECT body FROM work_items WHERE lower(pull_request) = lower(?) ORDER BY state_since DESC, key LIMIT 1', url);
      return r ? parse<WorkItem>(r.body) : undefined;
    },
    list(filter) {
      const states = filter?.state ?? [];
      const conds = [
        ...(states.length ? [`state IN (${states.map(() => '?').join(',')})`] : []),
        ...(filter?.keptWork ? ["body::jsonb->'keptWork' <> '[]'::jsonb"] : []),
        ...(filter?.landing ? ["body::jsonb->'landing' IS NOT NULL"] : []),
      ];
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const limit = filter?.limit !== undefined ? 'LIMIT ?' : '';
      const args = [...states, ...(filter?.limit !== undefined ? [filter.limit] : [])];
      return db.all(`SELECT body FROM work_items ${where} ORDER BY state_since DESC, key ${limit}`, ...args).map((r) => parse<WorkItem>(r.body));
    },
    counts() {
      const out = countStates([]);
      for (const r of db.all('SELECT state, count(*) AS n FROM work_items GROUP BY state')) out[r.state as WorkItemState] = Number(r.n);
      return out;
    },
    inFlight() {
      const states = [...IN_FLIGHT_STATES];
      return inFlightOf(db.all(`SELECT body FROM work_items WHERE state IN (${states.map(() => '?').join(',')})`, ...states).map((r) => parse<WorkItem>(r.body)));
    },
    due(now, limit) {
      const ended = ENDED_STATES.map(() => '?').join(',');
      return db.all(`SELECT body FROM work_items WHERE state NOT IN (${ended}) AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at NULLS FIRST, key LIMIT ?`, ...ENDED_STATES, now, limit)
        .map((r) => parse<WorkItem>(r.body));
    },
    checked(key, version, nextCheckAt) {
      db.run('UPDATE work_items SET next_check_at = ? WHERE key = ? AND version = ?', nextCheckAt, key, version);
    },
    rebuild: () => tx(() => rebuildWorkItems(db)),
    catchUp() {
      const behind = db.get(`SELECT 1 AS behind FROM events WHERE seq > (SELECT seq FROM work_items_applied) AND type IN (${[...LEDGER_EVENT_TYPES].map(() => '?').join(',')}) LIMIT 1`, ...LEDGER_EVENT_TYPES);
      return behind ? tx(() => rebuildWorkItems(db)) : undefined;
    },
  };
}
