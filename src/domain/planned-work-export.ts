// Planned work's export (issue #2840, design.md "Planned work"): a work plan as one CSV row per plan task, for a
// spreadsheet, and as nested JSON with snake_case keys, for other tools. Made from the work plan GET /api/planned-work
// answers, so the numbers are the same. Pure.
import { csvOf } from './database-read.ts';
import type { PlanJob, PlanStatus, WorkPlan } from './planned-work.ts';

export const PLANNED_WORK_CSV_COLUMNS = [
  'plan_id', 'plan_title', 'piece_id', 'piece_title', 'piece_status', 'task_id', 'task_status', 'job_ids', 'job_statuses', 'artifact', 'updated_at',
] as const;

/**
 * A text cell a spreadsheet would read as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a carriage return) starts
 * with a quote mark: an issue title is anyone's text.
 */
const text = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/** One row per plan task: its plan and plan piece, its jobs (ids and stages, joined by `|`), its piece's artifact; an empty cell is empty. */
export function plannedWorkCsv(plan: WorkPlan): string {
  const rows = plan.pieces.flatMap((p) => p.tasks.map((t) => [
    plan.id, text(plan.title), p.id, text(p.title), p.status, t.id, t.status,
    t.jobs.map((j) => j.id).join('|'), t.jobs.map((j) => j.stage).join('|'), text(p.artifact ?? ''), t.updatedAt ?? '',
  ].map((v) => (v === '' ? null : v))));
  return csvOf(PLANNED_WORK_CSV_COLUMNS, rows);
}

interface ExportJob { id: string; status: string }
interface ExportIssue { title: string; status: PlanStatus; url: string }
export interface PlannedWorkExport extends ExportIssue {
  plan_id: string; counts: Record<PlanStatus, number>; jobs: ExportJob[];
  pieces: (ExportIssue & { piece_id: string; artifact: string | null; jobs: ExportJob[]; tasks: (ExportIssue & { task_id: string; depends_on: string[]; updated_at: string | null; jobs: ExportJob[] })[] })[];
}

/** A job as the export has it: its id, and its stage as the Jobs view has it. */
const jobs = (js: readonly PlanJob[]): ExportJob[] => js.map((j) => ({ id: j.id, status: j.stage }));

/** The work plan nested: plan, plan pieces, plan tasks, jobs. */
export function plannedWorkJson(plan: WorkPlan): PlannedWorkExport {
  return {
    plan_id: plan.id, title: plan.title, status: plan.status, url: plan.url, counts: plan.counts, jobs: jobs(plan.jobs),
    pieces: plan.pieces.map((p) => ({
      piece_id: p.id, title: p.title, status: p.status, url: p.url, artifact: p.artifact ?? null, jobs: jobs(p.jobs),
      tasks: p.tasks.map((t) => ({ task_id: t.id, title: t.title, status: t.status, url: t.url, depends_on: t.dependsOn, updated_at: t.updatedAt ?? null, jobs: jobs(t.jobs) })),
    })),
  };
}
