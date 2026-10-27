// The plan store (issue #2861, tenant migration 106, design.md "Planned work"): each kept work plan, its plan pieces and
// plan tasks in order (a task's issues and blockers as JSON), the jobs linked to the plan, a piece or a task, and the plan
// artifacts — each a row of its own, with its type, ref, piece, task, job and times. A plan sync replaces the tree and adds
// links and artifacts; it never removes a link or an artifact.
import type { KeptPlan, KeptTaskIssue, PlanArtifact, PlanArtifactType, PlanLevel, PlanSync, WorkPlanRepository } from '../domain/work-plans.ts';
import { parse, type StoreContext } from './context.ts';
import type { Row } from './db.ts';

export const WORK_PLAN_TABLES = `CREATE TABLE IF NOT EXISTS work_plans (
    id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
    sync TEXT NOT NULL, synced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plan_pieces (
    plan_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
    PRIMARY KEY (plan_id, id));
  CREATE TABLE IF NOT EXISTS plan_tasks (
    plan_id TEXT NOT NULL, piece_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
    title TEXT NOT NULL, url TEXT NOT NULL, issues TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (plan_id, id));
  CREATE TABLE IF NOT EXISTS plan_job_links (
    plan_id TEXT NOT NULL, level TEXT NOT NULL, item TEXT NOT NULL, job_id TEXT NOT NULL, linked_at TEXT NOT NULL, PRIMARY KEY (plan_id, level, item, job_id));
  CREATE TABLE IF NOT EXISTS plan_artifacts (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, piece_id TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '', job_id TEXT, type TEXT NOT NULL, ref TEXT NOT NULL,
    source TEXT NOT NULL, by_person TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (plan_id, piece_id, task_id, type, ref));
  CREATE INDEX IF NOT EXISTS plan_artifacts_plan ON plan_artifacts (plan_id)`;

const artifactOf = (r: Row): PlanArtifact => ({
  id: String(r.id), planId: String(r.plan_id), pieceId: String(r.piece_id), ...(r.task_id ? { taskId: String(r.task_id) } : {}),
  ...(r.job_id !== null ? { jobId: String(r.job_id) } : {}), type: String(r.type) as PlanArtifactType, ref: String(r.ref),
  source: r.source === 'sync' ? 'sync' : 'person', ...(r.by_person !== null ? { by: String(r.by_person) } : {}), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});

const issueOf = (r: Row) => ({ id: String(r.id), repo: String(r.repo), number: Number(r.number), title: String(r.title), url: String(r.url) });

export function createWorkPlanRepository(c: StoreContext): WorkPlanRepository {
  const planOf = (r: Row): KeptPlan => {
    const id = String(r.id);
    const tasks = c.db.all('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY position', id);
    return {
      ...issueOf(r), sync: r.sync === 'off' ? 'off' : 'github', ...(r.synced_at !== null ? { syncedAt: String(r.synced_at) } : {}),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
      pieces: c.db.all('SELECT * FROM plan_pieces WHERE plan_id = ? ORDER BY position', id).map((p) => ({
        ...issueOf(p),
        tasks: tasks.filter((t) => t.piece_id === p.id).map((t) => ({ ...issueOf(t), issues: parse<KeptTaskIssue[]>(t.issues), dependsOn: parse<string[]>(t.depends_on) })),
      })),
      jobLinks: c.db.all('SELECT level, item, job_id FROM plan_job_links WHERE plan_id = ? ORDER BY linked_at, job_id', id)
        .map((l) => ({ level: String(l.level) as PlanLevel, item: String(l.item), jobId: String(l.job_id) })),
    };
  };
  const get = (id: string): KeptPlan | undefined => { const r = c.db.get('SELECT * FROM work_plans WHERE id = ?', id); return r ? planOf(r) : undefined; };
  const addArtifact: WorkPlanRepository['addArtifact'] = (a, now) => {
    c.db.run(`INSERT INTO plan_artifacts (id, plan_id, piece_id, task_id, job_id, type, ref, source, by_person, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (plan_id, piece_id, task_id, type, ref) DO UPDATE SET updated_at = excluded.updated_at, job_id = COALESCE(plan_artifacts.job_id, excluded.job_id)`,
    c.idGen(), a.planId, a.pieceId, a.taskId ?? '', a.jobId ?? null, a.type, a.ref, a.source, a.by ?? null, now, now);
    return artifactOf(c.db.get('SELECT * FROM plan_artifacts WHERE plan_id = ? AND piece_id = ? AND task_id = ? AND type = ? AND ref = ?', a.planId, a.pieceId, a.taskId ?? '', a.type, a.ref)!);
  };
  return {
    list: () => c.db.all('SELECT * FROM work_plans ORDER BY id').map(planOf),
    get,
    keep({ tree, jobLinks, pullRequests }, sync, now) {
      return c.tx(() => {
        c.db.run(`INSERT INTO work_plans (id, repo, number, title, url, sync, synced_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET repo = excluded.repo, number = excluded.number, title = excluded.title, url = excluded.url, synced_at = excluded.synced_at, updated_at = excluded.updated_at`,
        tree.id, tree.repo, tree.number, tree.title, tree.url, sync, now, now, now);
        c.db.run('DELETE FROM plan_pieces WHERE plan_id = ?', tree.id);
        c.db.run('DELETE FROM plan_tasks WHERE plan_id = ?', tree.id);
        tree.pieces.forEach((p, i) => {
          c.db.run('INSERT INTO plan_pieces (plan_id, id, position, repo, number, title, url) VALUES (?, ?, ?, ?, ?, ?, ?)', tree.id, p.id, i, p.repo, p.number, p.title, p.url);
          p.tasks.forEach((t, j) => {
            c.db.run('INSERT INTO plan_tasks (plan_id, piece_id, id, position, repo, number, title, url, issues, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              tree.id, p.id, t.id, j, t.repo, t.number, t.title, t.url, JSON.stringify(t.issues), JSON.stringify(t.dependsOn));
          });
        });
        for (const l of jobLinks) {
          c.db.run('INSERT INTO plan_job_links (plan_id, level, item, job_id, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', tree.id, l.level, l.item, l.jobId, now);
        }
        for (const p of pullRequests) addArtifact({ planId: tree.id, pieceId: p.pieceId, ...(p.taskId ? { taskId: p.taskId } : {}), jobId: p.jobId, type: 'pull_request', ref: p.ref, source: 'sync' }, now);
        return get(tree.id)!;
      });
    },
    setSync(id: string, sync: PlanSync, now: string) {
      return c.db.run('UPDATE work_plans SET sync = ?, updated_at = ? WHERE id = ?', sync, now, id).changes > 0;
    },
    remove(id) {
      return c.tx(() => {
        for (const t of ['plan_pieces', 'plan_tasks', 'plan_job_links', 'plan_artifacts']) c.db.run(`DELETE FROM ${t} WHERE plan_id = ?`, id);
        return c.db.run('DELETE FROM work_plans WHERE id = ?', id).changes > 0;
      });
    },
    artifacts: (planId) => c.db.all('SELECT * FROM plan_artifacts WHERE plan_id = ? ORDER BY created_at, id', planId).map(artifactOf),
    addArtifact,
    removeArtifact: (planId, id) => c.db.run('DELETE FROM plan_artifacts WHERE plan_id = ? AND id = ?', planId, id).changes > 0,
  };
}

