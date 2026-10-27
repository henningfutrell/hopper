// Grades (issue #2845, tenant migration 102, design.md "Grades"): one row per ended job's automatic grade — its keys as
// columns a rollup filters on, its facts and grade as JSON —, and every user grade a person gave a job, kept as its
// history: the newest is the job's user grade. The grade pass's cursor is its row in `event_cursors` (consumer
// `grade-pass`), which a fold of two users resets as it does every consumer's.
import type { GradeRepository, GradeRow, UserGrade } from '../domain/grades.ts';
import { parse, type StoreContext } from './context.ts';
import type { Row } from './db.ts';

export const GRADE_TABLES = `CREATE TABLE IF NOT EXISTS job_grades (
    job_id TEXT PRIMARY KEY, ended_at TEXT NOT NULL, executor TEXT NOT NULL, model TEXT, repo TEXT, kind TEXT NOT NULL, machine_id TEXT,
    score INTEGER NOT NULL, graded_at TEXT NOT NULL, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS job_grades_ended ON job_grades (ended_at);
  CREATE TABLE IF NOT EXISTS job_user_grades (job_id TEXT NOT NULL, at TEXT NOT NULL, by_person TEXT NOT NULL, score INTEGER NOT NULL, note TEXT, PRIMARY KEY (job_id, at))`;

const CURSOR = 'grade-pass';

const userOf = (r: Row): UserGrade => ({ score: Number(r.score), ...(r.note !== null ? { note: String(r.note) } : {}), by: String(r.by_person), at: String(r.at) });

export function createGradeRepository(c: StoreContext): GradeRepository {
  const history = (jobId: string): UserGrade[] =>
    c.db.all('SELECT * FROM job_user_grades WHERE job_id = ? ORDER BY at DESC', jobId).map(userOf);
  /** The rows with each job's newest user grade. */
  const withUser = (rows: Row[]): GradeRow[] => {
    const ids = rows.map((r) => String(r.job_id));
    const users = new Map<string, UserGrade>();
    if (ids.length > 0) {
      for (const r of c.db.all(`SELECT DISTINCT ON (job_id) * FROM job_user_grades WHERE job_id IN (${ids.map(() => '?').join(',')}) ORDER BY job_id, at DESC`, ...ids)) {
        users.set(String(r.job_id), userOf(r));
      }
    }
    return rows.map((r) => {
      const g = parse<GradeRow>(r.body);
      const u = users.get(g.jobId);
      return u ? { ...g, user: u } : g;
    });
  };
  return {
    cursor() {
      const r = c.db.get('SELECT seq FROM event_cursors WHERE consumer = ?', CURSOR);
      return r ? Number(r.seq) : undefined;
    },
    save(rows, cursor) {
      c.tx(() => {
        for (const { user: _, ...g } of rows) {
          c.db.run(`INSERT INTO job_grades (job_id, ended_at, executor, model, repo, kind, machine_id, score, graded_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (job_id) DO UPDATE SET ended_at = excluded.ended_at, executor = excluded.executor, model = excluded.model, repo = excluded.repo,
            kind = excluded.kind, machine_id = excluded.machine_id, score = excluded.score, graded_at = excluded.graded_at, body = excluded.body`,
          g.jobId, g.endedAt, g.executor, g.model ?? null, g.repo ?? null, g.kind, g.machine ?? null, g.auto.score, g.gradedAt ?? g.endedAt, JSON.stringify(g));
        }
        if (cursor !== undefined) {
          c.db.run(`INSERT INTO event_cursors (consumer, seq) VALUES (?, ?)
            ON CONFLICT (consumer) DO UPDATE SET seq = GREATEST(event_cursors.seq, excluded.seq)`, CURSOR, cursor);
        }
      });
    },
    get(jobId) {
      const r = c.db.get('SELECT body, job_id FROM job_grades WHERE job_id = ?', jobId);
      return r ? withUser([r])[0] : undefined;
    },
    list(q = {}) {
      const where: string[] = [];
      const p: (string | number)[] = [];
      if (q.since !== undefined) { where.push('ended_at >= ?'); p.push(q.since); }
      if (q.repo !== undefined) { where.push('repo = ?'); p.push(q.repo.toLowerCase()); }
      return withUser(c.db.all(`SELECT job_id, body FROM job_grades ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ended_at DESC, job_id LIMIT ?`, ...p, q.limit ?? 5000));
    },
    grade(jobId, g) {
      c.db.run(`INSERT INTO job_user_grades (job_id, at, by_person, score, note) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (job_id, at) DO UPDATE SET by_person = excluded.by_person, score = excluded.score, note = excluded.note`, jobId, g.at, g.by, g.score, g.note ?? null);
    },
    history,
  };
}
