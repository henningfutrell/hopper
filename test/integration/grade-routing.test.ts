// Grade-aware routing and the grade settings (issue #2845 part 2, design.md "Grades") over the real HTTP server and
// database: an admin sets the grade settings (POST /ui/api/grades/settings); with grade routing on, a new job goes to the
// executor whose graded jobs of the same work did best, and its spec records why (`spec.gradeRoute`); off — the
// default —, or with too few grades, it keeps its executor. A routing rule's executor wins over the grades.
//
// Feature: grade-aware routing
//   Scenario: off by default, a job keeps the executor its source gives it
//   Scenario: on, with enough grades, a job goes to the executor graded higher on matching work
//   Scenario: on, with fewer grades than the minimum, a job keeps its executor
//   Scenario: a routing rule's executor wins over the grades
//   Scenario: the settings are kept across a restart, and a bad one is refused
//   Scenario: a weight change grades the kept grades again at the next pass
import { afterEach, describe, expect, it } from 'vitest';
import type { GradeRow, GradeSettings } from '../../src/domain/grades.ts';
import { keepGrades } from '../../src/engine/grades.ts';
import type { JobGradeView } from '../../src/http/grades.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(o: { dbPath?: string; plugins?: Record<string, unknown> } = {}): Promise<{ a: TestApp; dbPath: string }> {
  let path = o.dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
  }
  const a = await startTestApp({ dbPath: path, ...(o.plugins ? { plugins: o.plugins } : {}) });
  apps.push(a);
  return { a, dbPath: path };
}

let n = 0;
/** Graded jobs of the manual source's work: no repository, work kind code. */
function seed(a: TestApp, executor: string, score: number, k: number): void {
  const rows: GradeRow[] = Array.from({ length: k }, () => ({
    jobId: `seeded-${++n}`, endedAt: new Date().toISOString(), executor, kind: 'code', auto: { score, lines: [] },
  }));
  a.user().store.grades.save(rows);
}

const settings = async (a: TestApp, body: object, token: string) => a.ui<GradeSettings>('/ui/api/grades/settings', body, { token });

describe('grade-aware routing at intake', () => {
  it('is off by default; on, a new job goes to the executor graded higher, and too few grades keep its executor', async () => {
    const { a } = await boot();
    const token = await a.login();
    seed(a, 'test', 30, 3);
    seed(a, 'scripted', 90, 3);
    expect((await a.api<GradeSettings>('GET', '/api/grades/settings')).body.routing).toEqual({ on: false, minSamples: 10 });

    const off = await a.pull({ op: 'echo', message: 'off' }, { executor: 'test', title: 'Off' });
    expect(off.spec.executor).toBe('test');
    expect(off.spec).not.toHaveProperty('gradeRoute');

    expect((await settings(a, { routing: { on: true, minSamples: 3 } }, token)).body.routing).toEqual({ on: true, minSamples: 3 });
    const on = await a.pull({ op: 'echo', message: 'on' }, { executor: 'test', title: 'On' });
    expect(on.spec).toMatchObject({ executor: 'scripted', gradeRoute: { executor: 'scripted', from: 'test', on: 'kind', score: 90, samples: 3, fromScore: 30, fromSamples: 3 } });
    expect((await a.waitForStatus(on.id, 'finished')).result).toMatchObject({ echo: 'on' });

    await settings(a, { routing: { minSamples: 4 } }, token);
    const few = await a.pull({ op: 'echo', message: 'few' }, { executor: 'test', title: 'Few' });
    expect(few.spec.executor).toBe('test');
    expect(few.spec).not.toHaveProperty('gradeRoute');
  });

  it('lets a routing rule\'s executor win over the grades', async () => {
    const { a } = await boot({ plugins: { routing: [{ name: 'test for paint', match: { title: 'paint' }, set: { executor: 'test' } }] } });
    const token = await a.login();
    seed(a, 'test', 10, 3);
    seed(a, 'scripted', 95, 3);
    await settings(a, { routing: { on: true, minSamples: 3 } }, token);
    const job = await a.pull({ op: 'echo', message: 'hi' }, { executor: 'test', title: 'Paint the shed' });
    expect(job.spec).toMatchObject({ executor: 'test', routedBy: { rule: 'test for paint' } });
    expect(job.spec).not.toHaveProperty('gradeRoute');
  });

  it('keeps the settings across a restart, and refuses a bad one', async () => {
    const { a, dbPath } = await boot();
    const token = await a.login();
    const r = await settings(a, { weights: { cost: 0 }, revertWindowDays: 3 }, token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ weights: { cost: 0, outcome: 3 }, revertWindowDays: 3 });
    expect((await settings(a, { revertWindowDays: 0 }, token)).status).toBe(400);
    expect((await settings(a, { weights: { colour: 1 } }, token)).status).toBe(400);
    expect((await settings(a, { routing: { minSamples: 0 } }, token)).status).toBe(400);
    await a.stop();
    apps.splice(apps.indexOf(a), 1);

    const { a: b } = await boot({ dbPath });
    expect((await b.api<GradeSettings>('GET', '/api/grades/settings')).body).toMatchObject({ weights: { cost: 0 }, revertWindowDays: 3, routing: { on: false } });
  });

  it('grades the kept grades again at the next pass when a weight changes', async () => {
    const { a } = await boot();
    const token = await a.login();
    const done = await a.pull({ op: 'echo', message: 'hi' });
    await a.waitForStatus(done.id, 'finished', 20_000);
    keepGrades(a.user().store, new Date());
    const signals = async () => (await a.api<JobGradeView>('GET', `/api/jobs/${done.id}/grade`)).body.grade!.auto.lines.map((l) => l.signal);
    expect(await signals()).toContain('time');
    await settings(a, { weights: { time: 0 } }, token);
    expect(keepGrades(a.user().store, new Date())).toBe(1);
    expect(await signals()).not.toContain('time');
    expect(keepGrades(a.user().store, new Date())).toBe(0);
  });
});
