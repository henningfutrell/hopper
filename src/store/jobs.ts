import type { JobFilter, JobRepository } from '../domain/ports.ts';
import { TERMINAL_STATUSES, type Job } from '../domain/types.ts';
import {
  awaitsOrigin, checkDue, checkedStamp, deniedStamp, editedStamp, childLevel, gate2Hold, liftedStamp, lowest, opensDoors, quarantinedStamp, ruleCeiling, signStamp, stampedEvent, stampHold, trustApprovable, trustApprovedStamp, verifiedLevel, type StampedBy, type StampedEvent, type TrustLevel,
} from '../domain/trust-stamp.ts';
import { stampView } from '../domain/stamp-view.ts';
import { waitEntryProblem } from '../domain/wait-on.ts';
import type { Row } from './db.ts';
import type { ReadDb } from './read-pool.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

/** The most ids one statement names when it reads the bodies of the jobs that changed. */
const BODIES_PER_READ = 500;

const marks = (part: readonly string[]): string => part.map(() => '?').join(',');
/** `ids` in parts of at most BODIES_PER_READ, so no statement names too many. */
const chunks = (ids: readonly string[]): string[][] => {
  const parts: string[][] = [];
  for (let i = 0; i < ids.length; i += BODIES_PER_READ) parts.push(ids.slice(i, i + BODIES_PER_READ));
  return parts;
};

/**
 * Jobs are read by row version (issue #1154). A list reads each row's id and version only, and the body only of a row
 * this store has not read at that version. The version is Postgres's `xmin`: every write of the row changes it,
 * whoever writes (the build before, a migration, the operator CLI), and a rolled back write takes it back. So a body
 * kept here is never older than its row. Before, every list sent and parsed the body of every job it named, about
 * once a second, and the call blocks the event loop. A get sends the kept version and is answered the body only when
 * the row is at another one.
 */
/** The advisory lock of an item's jobs, by its source key (`lockItem`): one per item and schema. */
export const ITEM_LOCK = "hashtext('hopper item ' || current_schema() || ' ' || ?)";

/** The ids and versions of the jobs `filter` names, newest first; `every`: the list names every job. */
function listQuery(filter?: JobFilter): { sql: string; args: (string | number)[]; every: boolean } {
  const conds = [
    ...(filter?.status?.length ? [`status IN (${filter.status.map(() => '?').join(',')})`] : []),
    // Generated columns (job-filter-columns.ts): a filter parses no body.
    ...(filter?.unassessed ? ['NOT assessed'] : []),
    ...(filter?.undismissed ? ['NOT dismissed'] : []),
    ...(filter?.followed ? ["follow IN ('open', 'closed', 'tended')"] : []),
    ...(filter?.namesPullRequest ? ['pull_request IS NOT NULL', "COALESCE(follow, '') NOT IN ('merged', 'abandoned')"] : []),
  ];
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = filter?.limit !== undefined ? 'LIMIT ?' : '';
  const args = [...(filter?.status ?? []), ...(filter?.limit !== undefined ? [filter.limit] : [])];
  return { sql: `SELECT id, xmin::text AS v FROM jobs ${where} ORDER BY created_at DESC, seq DESC ${limit}`, args, every: !conds.length && filter?.limit === undefined };
}

/** The repository, and its list read off the event loop (issue #2392): the same kept jobs, read by row version. */
export type JobRepositoryInternals = JobRepository & { listRead(read: ReadDb, filter?: JobFilter): Promise<Job[]> };

export function createJobRepository(c: StoreContext, onStamped: (jobId: string, data: StampedEvent) => void = () => {}): JobRepositoryInternals {
  const kept = new Map<string, { v: string; job: Job }>();
  /** The user's trust stamp key (issue #655): absent until the runtime gives it, and then no job is stamped or checked. */
  let stampKey: Buffer | undefined;
  /** The job stamped by the rules: at its rule ceiling, or `cap` when lower. */
  const stampByRules = (key: Buffer, job: Job, by: StampedBy, cap?: Job['stamp']): Job['stamp'] => {
    const ceiling = ruleCeiling(job);
    return signStamp(key, job, { level: cap ? lowest(ceiling.level, cap.level) : ceiling.level, reasons: ceiling.reasons, by, at: c.clock.now().toISOString() });
  };
  /**
   * The job as written, its stamp told as `intake.stamped` (issue #655 part 11); `from`: the level it verified at before.
   * Not at `create`: its caller appends `job.queued` first, then the stamp (`appendStamped`), so a job's timeline starts queued.
   */
  const told = (job: Job, from?: TrustLevel): Job => {
    const data = stampedEvent(job, from);
    if (data) onStamped(job.id, data);
    return job;
  };
  const keep = (r: Row): Job => {
    const job = parse<Job>(r.body);
    kept.set(String(r.id), { v: String(r.v), job });
    return job;
  };
  const one = (r: Row | undefined, id?: string): Job | undefined => {
    if (r) return keep(r);
    if (id !== undefined) kept.delete(id);
    return undefined;
  };
  /** A get sends the body only when the row is not at the version kept: most gets of a job find it unchanged. */
  const get = (id: string): Job | undefined => {
    const k = kept.get(id);
    const r = c.db.get('SELECT id, xmin::text AS v, CASE WHEN xmin::text = ? THEN NULL ELSE body END AS body FROM jobs WHERE id = ?', k?.v ?? '', id);
    if (k && r && r.body == null) return k.job;
    return one(r, id);
  };
  /** The ids of `rows` (id and version) whose kept job is not at that version, forgotten. */
  const staleOf = (rows: Row[]): string[] => {
    const stale = rows.map((r) => String(r.id)).filter((id, i) => kept.get(id)?.v !== String(rows[i]!.v));
    for (const id of stale) kept.delete(id);
    return stale;
  };
  const BODIES = (ids: string[]): string => `SELECT id, xmin::text AS v, body FROM jobs WHERE id IN (${marks(ids)})`;
  // A job deleted between the two reads is left out.
  const keptOf = (rows: Row[]): Job[] => rows.flatMap((r) => kept.get(String(r.id))?.job ?? []);
  /** The jobs of `rows` (id and version, in order): the kept ones as kept, the others read now. */
  const bodies = (rows: Row[]): Job[] => {
    for (const ids of chunks(staleOf(rows))) for (const r of c.db.all(BODIES(ids), ...ids)) keep(r);
    return keptOf(rows);
  };
  /** A list of every job forgets the jobs deleted since. */
  const forgetOthers = (rows: Row[]): void => {
    const ids = new Set(rows.map((r) => String(r.id)));
    for (const id of kept.keys()) if (!ids.has(id)) kept.delete(id);
  };
  const write = (id: string, change: (cur: Job) => Job): Job => {
    const cur = get(id);
    if (!cur) throw new Error(`job not found: ${id}`);
    const next: Job = { ...change(cur), updatedAt: c.clock.now().toISOString() };
    // A job enters waiting_on only with what it waits on (issue #1245).
    const problem = waitEntryProblem(cur, next);
    if (problem) throw new Error(problem);
    const r = c.db.get('UPDATE jobs SET status = ?, body = ? WHERE id = ? RETURNING xmin::text AS v', next.status, JSON.stringify(next), id);
    if (r) kept.set(id, { v: String(r.v), job: next });
    return next;
  };
  /**
   * The backfill's stamp: by the rules; a job a job made (a fork, a follow-on) at most its parent's rule level, never owner;
   * a job with no source `approved`, so a job queued before job sources (by hand, or an older build) runs as before.
   */
  const backfillStamp = (key: Buffer, job: Job): Job['stamp'] => {
    const parentId = job.forkOf?.jobId ?? job.followOn?.jobId;
    const parent = parentId === undefined ? undefined : get(parentId);
    if (!parent && !job.source) return signStamp(key, job, { level: 'approved', reasons: ['source:none'], by: 'backfill', at: c.clock.now().toISOString() });
    if (!parent) return stampByRules(key, job, 'backfill');
    return signStamp(key, job, { level: childLevel(ruleCeiling(parent).level), reasons: [`parent:${parent.id}`], by: 'backfill', at: c.clock.now().toISOString() });
  };
  return {
    create(spec, priority, source, parent) {
      const at = c.clock.now().toISOString();
      const job: Job = { id: c.idGen(), spec, priority, status: 'queued', approved: false, createdAt: at, updatedAt: at, attempts: 0 };
      if (source) job.source = source;
      if (stampKey && !parent) job.stamp = stampByRules(stampKey, job, 'intake');
      if (stampKey && parent) {
        // A job a job made: at most its parent's level as verified now, never owner; none when the parent's does not verify.
        const of = verifiedLevel(stampKey, parent);
        if (of !== undefined) job.stamp = signStamp(stampKey, job, { level: childLevel(of), reasons: [`parent:${parent.id}`], by: 'job', at });
      }
      const r = c.db.get('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?) RETURNING xmin::text AS v',
        job.id, job.status, at, source?.key ?? null, JSON.stringify(job));
      if (r) kept.set(job.id, { v: String(r.v), job });
      return job;
    },
    get,
    lockItem(key) { c.db.get(`SELECT pg_advisory_xact_lock(${ITEM_LOCK}) AS held`, key); },
    getBySourceKey(key) {
      const r = c.db.get('SELECT id, xmin::text AS v FROM jobs WHERE source_key = ? ORDER BY created_at DESC, seq DESC LIMIT 1', key);
      return r ? bodies([r])[0] : undefined;
    },
    idsOfItem(key) {
      return c.db.all('SELECT id FROM jobs WHERE source_key = ? ORDER BY created_at DESC, seq DESC', key).map((r) => String(r.id));
    },
    getMany(ids) {
      const rows = chunks([...new Set(ids)]).flatMap((part) => c.db.all(`SELECT id, xmin::text AS v FROM jobs WHERE id IN (${marks(part)})`, ...part));
      return new Map(bodies(rows).map((j) => [j.id, j]));
    },
    newestOfItems(keys) {
      // Postgres's DISTINCT ON keeps the first row of each key in the order given: the newest, as getBySourceKey.
      const rows = chunks([...new Set(keys)]).flatMap((part) => c.db.all(
        `SELECT DISTINCT ON (source_key) id, xmin::text AS v FROM jobs WHERE source_key IN (${marks(part)}) ORDER BY source_key, created_at DESC, seq DESC`, ...part));
      return new Map(bodies(rows).flatMap((j) => (j.source ? [[j.source.key, j] as const] : [])));
    },
    list(filter?: JobFilter) {
      const q = listQuery(filter);
      const rows = c.db.all(q.sql, ...q.args);
      if (q.every) forgetOthers(rows);
      return bodies(rows);
    },
    async listRead(read, filter) {
      const q = listQuery(filter);
      const rows = await read.all(q.sql, ...q.args);
      if (q.every) forgetOthers(rows);
      for (const ids of chunks(staleOf(rows))) for (const r of await read.all(BODIES(ids), ...ids)) keep(r);
      return keptOf(rows);
    },
    update(id, patch) {
      return write(id, (cur) => applyPatch<Job>(cur, patch));
    },
    respecify(id, spec) {
      let had: TrustLevel | undefined;
      const job = write(id, (cur) => {
        const next = { ...cur, spec };
        if (!stampKey) return next;
        // Stamped again for the new spec, at the level it had or lower; a stamp that does not verify now stays as it is.
        // Jev's check was on the old text: the new one is checked again.
        had = verifiedLevel(stampKey, cur);
        if (had === undefined || !cur.stamp) return next;
        const { check: _old, ...was } = cur.stamp;
        const stamp = signStamp(stampKey, next, { ...was, level: had, by: 'respecify', at: c.clock.now().toISOString() });
        return { ...next, stamp };
      });
      return had === undefined ? job : told(job, had);
    },
    useStampKey(key) {
      stampKey = key;
      const unstamped = c.db.all(`SELECT id FROM jobs WHERE status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(',')}) ORDER BY seq`, ...TERMINAL_STATUSES)
        .map((r) => String(r.id)).filter((id) => get(id)?.stamp === undefined);
      // A job of an item with no origin waits for it (issue #1974): the next sync judges it and stamps it again.
      const pending = (cur: Job): Partial<Job> => (awaitsOrigin(cur) && !cur.forkOf && !cur.followOn ? { originPending: true } : {});
      for (const id of unstamped) told(write(id, (cur) => ({ ...cur, ...pending(cur), stamp: backfillStamp(key, cur) })));
      return unstamped;
    },
    restamp(id) {
      const key = stampKey;
      if (!key) return get(id)!;
      let from: TrustLevel | undefined;
      return told(write(id, (cur) => {
        const stamp = stampByRules(key, cur, 'intake');
        from = verifiedLevel(key, cur);
        // A quarantine stays: the rules' level is the one its lift gives back (issue #655, part 2).
        if (from !== 'quarantined') return { ...cur, stamp };
        return { ...cur, stamp: quarantinedStamp(key, { ...cur, stamp }, c.clock.now().toISOString()) };
      }), from);
    },
    stampHold(job, brake) {
      return stampKey ? stampHold(stampKey, job, brake) : undefined;
    },
    stampView(job, brake) {
      return stampView(stampKey, job, brake);
    },
    quarantine(id) {
      const key = stampKey;
      return key ? write(id, (cur) => ({ ...cur, stamp: quarantinedStamp(key, cur, c.clock.now().toISOString()) })) : get(id)!;
    },
    liftQuarantine(id) {
      const key = stampKey;
      return key ? write(id, (cur) => ({ ...cur, stamp: liftedStamp(key, cur, c.clock.now().toISOString()) })) : get(id)!;
    },
    checkDue(job) {
      return stampKey ? checkDue(stampKey, job) : false;
    },
    checkTrust(id, out) {
      const key = stampKey;
      const cur = get(id);
      // Written only while the check is still due: another hopper's check, a new spec or a person's act came first.
      if (!key || !cur || TERMINAL_STATUSES.includes(cur.status) || !checkDue(key, cur)) return undefined;
      const stamp = checkedStamp(key, cur, out, c.clock.now().toISOString());
      return stamp ? write(id, (j) => ({ ...j, stamp })) : undefined;
    },
    approveTrust(id) {
      const key = stampKey;
      const cur = get(id);
      if (!key || !cur || !trustApprovable(key, cur)) return undefined;
      return write(id, (j) => ({ ...j, stamp: trustApprovedStamp(key, j, c.clock.now().toISOString()) }));
    },
    deny(id, by) {
      const key = stampKey;
      const cur = get(id);
      if (!key || !cur || TERMINAL_STATUSES.includes(cur.status)) return undefined;
      const stamp = deniedStamp(key, cur, c.clock.now().toISOString(), by);
      return stamp ? write(id, (j) => ({ ...j, stamp })) : undefined;
    },
    edited(id) {
      const key = stampKey;
      const cur = get(id);
      if (!key || !cur || TERMINAL_STATUSES.includes(cur.status)) return undefined;
      const stamp = editedStamp(key, cur, c.clock.now().toISOString());
      return stamp ? write(id, (j) => ({ ...j, stamp })) : undefined;
    },
    gate2Hold(job, brake) {
      return stampKey ? gate2Hold(stampKey, job, brake) : undefined;
    },
    trustLevel(job) {
      return stampKey ? verifiedLevel(stampKey, job) : undefined;
    },
    opensDoors(job) {
      return stampKey ? opensDoors(stampKey, job) : true;
    },
  };
}
