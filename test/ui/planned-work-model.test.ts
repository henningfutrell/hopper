// Issue #2840: the Planned work tab's model — the work plan laid out left to right (work plan, plan pieces, plan tasks,
// jobs), each node coloured by its plan status, what a click on it opens, and the hash that names the plan.
import { describe, expect, it } from 'vitest';
import { exportPath, layoutPlan, planHash, planRefOf, STATUS_INFO } from '../../ui/src/model/planned-work.ts';
import type { PlanTask, WorkPlan } from '../../ui/src/model/wire.ts';

const issue = (n: number) => ({ id: `acme/app#${n}`, repo: 'acme/app', number: n, title: `title ${n}`, url: `https://github.com/acme/app/issues/${n}` });
const task = (n: number, status: PlanTask['status'], jobs: PlanTask['jobs'] = [], dependsOn: string[] = []): PlanTask => ({ ...issue(n), status, dependsOn, jobs });
const plan: WorkPlan = {
  ...issue(1), status: 'running', counts: { planned: 1, running: 1, done: 1, blocked: 0 }, jobs: [],
  pieces: [
    { ...issue(2), status: 'running', artifact: 'https://example.com/shot.png', jobs: [], tasks: [
      task(4, 'done', [{ id: 'j1', status: 'finished', stage: 'done', stageText: 'Done', planStatus: 'done' }]),
      task(5, 'running', [{ id: 'j2', status: 'running', stage: 'running', stageText: 'Building it', planStatus: 'running' }], ['acme/app#4']),
    ] },
    { ...issue(3), status: 'planned', artifact: 'a report', jobs: [], tasks: [task(6, 'planned')] },
  ],
};

describe('the planned-work graph (issue #2840)', () => {
  it('lays the plan out in four columns: work plan, plan pieces, plan tasks, jobs', () => {
    const l = layoutPlan(plan);
    const col = (kind: string) => [...new Set(l.nodes.filter((n) => n.kind === kind).map((n) => n.x))];
    expect([col('plan'), col('piece'), col('task'), col('job')].map((c) => c.length)).toEqual([1, 1, 1, 1]);
    expect(col('plan')[0]! < col('piece')[0]! && col('piece')[0]! < col('task')[0]! && col('task')[0]! < col('job')[0]!).toBe(true);
    expect(l.nodes.map((n) => n.id)).toEqual(['plan:acme/app#1', 'piece:acme/app#2', 'task:acme/app#4', 'job:acme/app#4:j1', 'task:acme/app#5', 'job:acme/app#5:j2', 'piece:acme/app#3', 'task:acme/app#6']);
    expect(l.edges.filter((e) => e.kind === 'depends_on')).toEqual([{ from: 'task:acme/app#5', to: 'task:acme/app#4', kind: 'depends_on' }]);
    expect(l.edges.filter((e) => e.kind === 'part')).toHaveLength(7);
  });

  it('a click opens a piece\'s artifact when it is a link, else its issue; a job opens the job', () => {
    const at = (id: string) => layoutPlan(plan).nodes.find((n) => n.id === id)!;
    expect(at('piece:acme/app#2').href).toBe('https://example.com/shot.png');
    expect(at('piece:acme/app#3').href).toBe('https://github.com/acme/app/issues/3');
    expect(at('piece:acme/app#3').artifact).toBe('a report');
    expect(at('task:acme/app#4').href).toBe('https://github.com/acme/app/issues/4');
    expect(at('job:acme/app#5:j2')).toMatchObject({ href: '#job/j2', status: 'running', text: 'Building it' });
  });

  it('each plan status has its look: done solid, running blue, planned dashed grey, blocked orange', () => {
    expect(STATUS_INFO.done).toMatchObject({ tone: 'ok', solid: true });
    expect(STATUS_INFO.running).toMatchObject({ tone: 'busy', solid: false });
    expect(STATUS_INFO.planned).toMatchObject({ tone: 'muted', dashed: true });
    expect(STATUS_INFO.blocked).toMatchObject({ tone: 'warn' });
  });

  it('a hash names the plan, and the export path its format', () => {
    expect(planHash('acme/app#1')).toBe('#jobs/planned-work/acme%2Fapp%231');
    expect(planRefOf('#jobs/planned-work/acme%2Fapp%231')).toBe('acme/app#1');
    expect(planRefOf('#jobs/planned-work')).toBe('');
    expect(exportPath('acme/app#1', 'csv')).toBe('/api/planned-work/export?issue=acme%2Fapp%231&format=csv');
  });
});
