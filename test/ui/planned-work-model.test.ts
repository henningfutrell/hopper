// Issues #2840, #2861: the Planned work tab's model — the work plan laid out left to right (work plan, plan pieces, plan tasks,
// jobs), each node coloured by its plan status, what a click on it opens, and the hash that names the plan.
import { describe, expect, it } from 'vitest';
import { artifactsOf, exportPath, layoutPlan, planHash, planPath, planRefOf, STATUS_INFO } from '../../ui/src/model/planned-work.ts';
import type { PlanArtifactView, PlanTask, WorkPlan } from '../../ui/src/model/wire.ts';

const issue = (n: number) => ({ id: `acme/app#${n}`, repo: 'acme/app', number: n, title: `title ${n}`, url: `https://github.com/acme/app/issues/${n}` });
const at = '2026-10-03T00:00:00Z';
const artifact = (id: string, ref: string): PlanArtifactView => ({ id, type: 'link', ref, source: 'person', by: 'someone', createdAt: at, updatedAt: at });
const task = (n: number, status: PlanTask['status'], jobs: PlanTask['jobs'] = [], dependsOn: string[] = [], artifacts: PlanArtifactView[] = []): PlanTask =>
  ({ ...issue(n), status, dependsOn, jobs, artifacts });
const plan: WorkPlan = {
  ...issue(1), status: 'running', sync: 'github', counts: { planned: 1, running: 1, done: 1, blocked: 0 }, jobs: [],
  pieces: [
    { ...issue(2), status: 'running', artifacts: [artifact('a1', 'https://example.com/shot.png')], jobs: [], tasks: [
      task(4, 'done', [{ id: 'j1', status: 'finished', stage: 'done', stageText: 'Done', planStatus: 'done' }], [], [artifact('a3', 'report-id-1'), artifact('a4', 'https://example.com/r')]),
      task(5, 'running', [{ id: 'j2', status: 'running', stage: 'running', stageText: 'Building it', planStatus: 'running' }], ['acme/app#4']),
    ] },
    { ...issue(3), status: 'planned', artifacts: [artifact('a2', 'report-id-2')], jobs: [], tasks: [task(6, 'planned')] },
  ],
};

describe('the planned-work graph (issues #2840, #2861)', () => {
  it('lays the plan out in four columns: work plan, plan pieces, plan tasks, jobs', () => {
    const l = layoutPlan(plan);
    const col = (kind: string) => [...new Set(l.nodes.filter((n) => n.kind === kind).map((n) => n.x))];
    expect([col('plan'), col('piece'), col('task'), col('job')].map((c) => c.length)).toEqual([1, 1, 1, 1]);
    expect(col('plan')[0]! < col('piece')[0]! && col('piece')[0]! < col('task')[0]! && col('task')[0]! < col('job')[0]!).toBe(true);
    expect(l.nodes.map((n) => n.id)).toEqual(['plan:acme/app#1', 'piece:acme/app#2', 'task:acme/app#4', 'job:acme/app#4:j1', 'task:acme/app#5', 'job:acme/app#5:j2', 'piece:acme/app#3', 'task:acme/app#6']);
    expect(l.edges.filter((e) => e.kind === 'depends_on')).toEqual([{ from: 'task:acme/app#5', to: 'task:acme/app#4', kind: 'depends_on' }]);
    expect(l.edges.filter((e) => e.kind === 'part')).toHaveLength(7);
  });

  it('a click opens a node\'s first artifact that is a link, else its issue; a job opens the job', () => {
    const node = (id: string) => layoutPlan(plan).nodes.find((n) => n.id === id)!;
    expect(node('piece:acme/app#2').href).toBe('https://example.com/shot.png');
    expect(node('piece:acme/app#3').href).toBe('https://github.com/acme/app/issues/3');
    expect(node('piece:acme/app#3').artifact).toBe('report-id-2');
    expect(node('task:acme/app#4').href).toBe('https://example.com/r');
    expect(node('task:acme/app#5').href).toBe('https://github.com/acme/app/issues/5');
    expect(node('job:acme/app#5:j2')).toMatchObject({ href: '#job/j2', status: 'running', text: 'Building it' });
  });

  it('each plan status has its look: done solid, running blue, planned dashed grey, blocked orange', () => {
    expect(STATUS_INFO.done).toMatchObject({ tone: 'ok', solid: true });
    expect(STATUS_INFO.running).toMatchObject({ tone: 'busy', solid: false });
    expect(STATUS_INFO.planned).toMatchObject({ tone: 'muted', dashed: true });
    expect(STATUS_INFO.blocked).toMatchObject({ tone: 'warn' });
  });

  it('lists every artifact with the piece and task it is on, in the plan\'s order', () => {
    expect(artifactsOf(plan).map((a) => [a.id, a.piece, a.task])).toEqual([
      ['a1', 'acme/app#2', undefined], ['a3', 'acme/app#2', 'acme/app#4'], ['a4', 'acme/app#2', 'acme/app#4'], ['a2', 'acme/app#3', undefined],
    ]);
  });

  it('a hash names the plan, and the read and export paths name it as plan', () => {
    expect(planHash('acme/app#1')).toBe('#jobs/planned-work/acme%2Fapp%231');
    expect(planRefOf('#jobs/planned-work/acme%2Fapp%231')).toBe('acme/app#1');
    expect(planRefOf('#jobs/planned-work')).toBe('');
    expect(exportPath('acme/app#1', 'csv')).toBe('/api/planned-work/export?plan=acme%2Fapp%231&format=csv');
    expect(planPath('acme/app#1')).toBe('/api/planned-work?plan=acme%2Fapp%231');
  });
});
