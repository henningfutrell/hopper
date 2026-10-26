// Issue #2840: planned work's export — one CSV row per plan task with the issue's columns, and the nested JSON with
// snake_case keys, both made from the work plan GET /api/planned-work answers. Pure.
import { describe, expect, it } from 'vitest';
import { PLANNED_WORK_CSV_COLUMNS, plannedWorkCsv, plannedWorkJson } from '../../src/domain/planned-work-export.ts';
import type { PlanTask, WorkPlan } from '../../src/domain/planned-work.ts';

const issue = (n: number, title: string) => ({ id: `acme/app#${n}`, repo: 'acme/app', number: n, title, url: `https://github.com/acme/app/issues/${n}` });
const task = (n: number, status: PlanTask['status'], jobs: PlanTask['jobs'], over: Partial<PlanTask> = {}): PlanTask =>
  ({ ...issue(n, `task ${n}`), status, dependsOn: [], jobs, updatedAt: '2026-01-15T12:00:00Z', ...over });
const job = (id: string, stage: PlanTask['jobs'][number]['stage']) => ({ id, status: 'finished' as const, stage, stageText: stage });

const plan: WorkPlan = {
  ...issue(1, 'Example plan'), status: 'running', counts: { planned: 1, running: 1, done: 1, blocked: 0 }, jobs: [],
  pieces: [
    { ...issue(2, 'First, piece'), status: 'running', artifact: 'screenshot of the result', jobs: [], tasks: [
      task(4, 'done', [job('job-1', 'done')]),
      task(5, 'running', [job('job-2', 'running'), job('job-3', 'done')], { dependsOn: ['acme/app#4'], updatedAt: '2026-01-15T12:30:00Z' }),
    ] },
    { ...issue(3, '=HYPERLINK("x")'), status: 'planned', jobs: [], tasks: [task(6, 'planned', [])] },
  ],
};

describe('the planned-work CSV (issue #2840)', () => {
  it('has the issue\'s columns and one row per plan task, jobs joined by |', () => {
    expect(PLANNED_WORK_CSV_COLUMNS).toEqual(['plan_id', 'plan_title', 'piece_id', 'piece_title', 'piece_status', 'task_id', 'task_status', 'job_ids', 'job_statuses', 'artifact', 'updated_at']);
    const lines = plannedWorkCsv(plan).trimEnd().split('\n');
    expect(lines).toEqual([
      PLANNED_WORK_CSV_COLUMNS.join(','),
      'acme/app#1,Example plan,acme/app#2,"First, piece",running,acme/app#4,done,job-1,done,screenshot of the result,2026-01-15T12:00:00Z',
      'acme/app#1,Example plan,acme/app#2,"First, piece",running,acme/app#5,running,job-2|job-3,running|done,screenshot of the result,2026-01-15T12:30:00Z',
      // A cell a spreadsheet would read as a formula starts with a quote mark.
      'acme/app#1,Example plan,acme/app#3,"\'=HYPERLINK(""x"")",planned,acme/app#6,planned,,,,2026-01-15T12:00:00Z',
    ]);
  });
});

describe('the planned-work nested JSON (issue #2840)', () => {
  it('nests plan, pieces, tasks and jobs with snake_case keys', () => {
    const j = plannedWorkJson(plan);
    expect(j).toMatchObject({ plan_id: 'acme/app#1', title: 'Example plan', status: 'running', url: plan.url, counts: plan.counts });
    expect(j.pieces[0]).toEqual({
      piece_id: 'acme/app#2', title: 'First, piece', status: 'running', url: plan.pieces[0]!.url, artifact: 'screenshot of the result', jobs: [],
      tasks: [
        { task_id: 'acme/app#4', title: 'task 4', status: 'done', url: plan.pieces[0]!.tasks[0]!.url, depends_on: [], updated_at: '2026-01-15T12:00:00Z', jobs: [{ id: 'job-1', status: 'done' }] },
        { task_id: 'acme/app#5', title: 'task 5', status: 'running', url: plan.pieces[0]!.tasks[1]!.url, depends_on: ['acme/app#4'], updated_at: '2026-01-15T12:30:00Z', jobs: [{ id: 'job-2', status: 'running' }, { id: 'job-3', status: 'done' }] },
      ],
    });
    expect(j.pieces[1]!.artifact).toBeNull();
  });
});
