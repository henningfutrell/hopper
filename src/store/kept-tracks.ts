// Kept delivery tracks and deployment records (issue #2775, tenant migration 101, design.md "Kept delivery tracks"): one
// row per job's track, its fields as JSON; one row per job's deployment record, its fields as JSON and the columns a query
// filters on; the cursor of the pass that keeps them. A track whose deployment completed is locked: neither its row nor its
// `deploy` record is written over. A `none` record is written over as a person flips it (part 2).
import type { DeploymentRecord, KeptTrack, KeptTrackRepository } from '../domain/kept-tracks.ts';
import { parse, type StoreContext } from './context.ts';

export const KEPT_TRACK_TABLES = `CREATE TABLE IF NOT EXISTS delivery_tracks (job_id TEXT PRIMARY KEY, repo TEXT, state TEXT NOT NULL, started_at TEXT NOT NULL, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS delivery_tracks_state ON delivery_tracks (state);
  CREATE TABLE IF NOT EXISTS deployment_records (job_id TEXT PRIMARY KEY, repo TEXT, kind TEXT NOT NULL, target TEXT, at TEXT NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS delivery_track_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), seq BIGINT NOT NULL)`;

const tracksOf = (rows: Record<string, unknown>[]): KeptTrack[] => rows.map((r) => parse<KeptTrack>(r.body));

export function createKeptTrackRepository(c: StoreContext): KeptTrackRepository {
  return {
    cursor() {
      const r = c.db.get('SELECT seq FROM delivery_track_cursor WHERE id = 1');
      return r ? Number(r.seq) : undefined;
    },
    open: () => tracksOf(c.db.all(`SELECT body FROM delivery_tracks WHERE state = 'open' ORDER BY started_at, job_id`)),
    closedOf(jobIds) {
      if (jobIds.length === 0) return new Set();
      return new Set(c.db.all(`SELECT job_id FROM delivery_tracks WHERE state = 'closed' AND job_id IN (${jobIds.map(() => '?').join(',')})`, ...jobIds).map((r) => String(r.job_id)));
    },
    get(jobId) {
      const r = c.db.get('SELECT body FROM delivery_tracks WHERE job_id = ?', jobId);
      return r ? parse<KeptTrack>(r.body) : undefined;
    },
    save(tracks, cursor) {
      c.tx(() => {
        for (const t of tracks) {
          c.db.run(`INSERT INTO delivery_tracks (job_id, repo, state, started_at, body) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (job_id) DO UPDATE SET repo = excluded.repo, state = excluded.state, body = excluded.body
            WHERE NOT EXISTS (SELECT 1 FROM deployment_records d WHERE d.job_id = delivery_tracks.job_id AND d.kind = 'deploy')`,
          t.jobId, t.repo ?? null, t.state, t.marks.queued, JSON.stringify(t));
          const d = t.deployment;
          if (d) {
            c.db.run(`INSERT INTO deployment_records (job_id, repo, kind, target, at, body) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (job_id) DO UPDATE SET repo = excluded.repo, kind = excluded.kind, target = excluded.target, at = excluded.at, body = excluded.body
              WHERE deployment_records.kind <> 'deploy'`,
              d.jobId, d.repo ?? null, d.kind, d.kind === 'deploy' ? d.target : null, d.at, JSON.stringify(d));
          }
        }
        if (cursor !== undefined) c.db.run('INSERT INTO delivery_track_cursor (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = GREATEST(delivery_track_cursor.seq, excluded.seq)', cursor);
      });
    },
    list(q = {}) {
      const where: string[] = [];
      const p: (string | number)[] = [];
      if (q.job !== undefined) { where.push('job_id = ?'); p.push(q.job); }
      if (q.repo !== undefined) { where.push('repo = ?'); p.push(q.repo.toLowerCase()); }
      if (q.state !== undefined) { where.push('state = ?'); p.push(q.state); }
      return tracksOf(c.db.all(`SELECT body FROM delivery_tracks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, job_id LIMIT ?`, ...p, q.limit ?? 1000));
    },
    deployments(q = {}) {
      const where: string[] = [];
      const p: (string | number)[] = [];
      if (q.job !== undefined) { where.push('job_id = ?'); p.push(q.job); }
      if (q.repo !== undefined) { where.push('repo = ?'); p.push(q.repo.toLowerCase()); }
      if (q.target !== undefined) { where.push('target = ?'); p.push(q.target); }
      if (q.kind !== undefined) { where.push('kind = ?'); p.push(q.kind); }
      return c.db.all(`SELECT body FROM deployment_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, job_id LIMIT ?`, ...p, q.limit ?? 1000)
        .map((r) => parse<DeploymentRecord>(r.body));
    },
  };
}
