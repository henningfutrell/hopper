// Issue #2716 through the real composition root, the real HTTP server, the real saga coordinator and the real operator CLI:
// a person saves a step schedule of an approved template, lists it, grants it the vault, runs it now and removes it, from
// the command line and the API. The container runtime is a double at its port, and no GitHub account is connected: a run
// started now is claimed, its `scheduled-run` saga runs it, and it fails before any sandbox because the repository's files
// cannot be read — a failure the run records, `step_schedule.run_failed` says, and the schedules' view lists for Needs you.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { ScheduledRun, StepScheduleRunsView, StepSchedulesView } from '../../src/domain/step-schedules.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { databaseUrlFor } from '../support/database.ts';
import { boot, stopAll, type Booted } from '../support/read-only-check.ts';

afterEach(stopAll);

const SAVE = ['schedule', 'save', 'phrase-drill-backup', '--template', 'backup', '--repo', 'acme/ops', '--input', 'ops/backup', '--script', 'ops/backup/step.sh', '--daily', '02:00', '--timeout', '1800'];

async function hopper(b: Booted, argv: string[]) {
  const out: string[] = [], err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(b.a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', b.a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

/** A template of the user's that gives a vault secret, approved by a person. */
async function approvedBackup(b: Booted): Promise<void> {
  expect((await b.a.ui('/ui/api/vault', { action: 'set', name: 'BUCKET_KEY', value: 'bucket-key-value' }, { token: b.token })).status).toBe(200);
  expect(await b.a.user().vault.saveTemplate({ name: 'backup', image: 'ghcr.io/example/box:backup', secrets: ['BUCKET_KEY'] }, 'a person')).toEqual({ ok: true });
  expect((await b.a.ui('/ui/api/vault', { action: 'approve-template', name: 'backup' }, { token: b.token })).status).toBe(200);
}

const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('step schedules from the command line and the API (issue #2716)', () => {
  it('saved, listed, granted, run now and removed; a run that cannot read its files fails and shows for Needs you', async () => {
    const b = await boot([]);
    await approvedBackup(b);

    const saved = await hopper(b, SAVE);
    expect(saved.code, saved.err).toBe(0);
    const list = JSON.parse((await hopper(b, ['schedule', 'list'])).out) as StepSchedulesView['schedules'];
    expect(list).toEqual([expect.objectContaining({ name: 'phrase-drill-backup', template: 'backup', repo: 'acme/ops', input: 'ops/backup', script: 'ops/backup/step.sh', daily: '02:00', timeoutSeconds: 1800, nextDue: expect.stringMatching(/T02:00:00\.000Z$/) })]);
    expect(list[0]!.grant).toBeUndefined();

    // A schedule the API refuses: a script out of its folder.
    const bad = await b.a.ui('/ui/api/step-schedules', { action: 'save', name: 'x', template: 'backup', repo: 'acme/ops', input: 'a', script: 'b/step.sh', daily: '02:00', timeoutSeconds: 60 }, { token: b.token });
    expect(bad.status).toBe(400);
    expect((await b.a.ui('/ui/api/step-schedules', { action: 'run', name: 'nope' }, { token: b.token })).status).toBe(404);
    expect([401, 403]).toContain((await b.a.ui('/ui/api/step-schedules', { action: 'run', name: 'phrase-drill-backup' })).status);

    expect((await hopper(b, ['schedule', 'grant', 'phrase-drill-backup'])).code).toBe(0);
    expect((await b.a.api<StepSchedulesView>('GET', '/api/step-schedules', undefined, { 'x-hopper-session': b.token })).body.schedules[0]!.grant).toMatchObject({ by: expect.any(String) });

    const ran = await hopper(b, ['schedule', 'run', 'phrase-drill-backup']);
    expect(ran.code, ran.err).toBe(0);
    const run = (JSON.parse(ran.out) as { run: ScheduledRun }).run;
    expect(run).toMatchObject({ schedule: 'phrase-drill-backup', trigger: 'now', saga: expect.any(String) });
    const read = async () => (await b.a.api<StepScheduleRunsView>('GET', '/api/step-schedules/phrase-drill-backup', undefined, { 'x-hopper-session': b.token })).body;
    const ended = await until(read, (v) => v.runs[0]?.endedAt !== undefined);
    expect(ended.runs[0]).toMatchObject({ id: run.id, outcome: 'failed', exit: 125, problem: expect.stringMatching(/^the step's files: /) });
    // No sandbox started: the run failed before its need box.
    expect([...b.runtime.ran.values()].filter((s) => s.labels[NEED_LABEL] !== undefined)).toEqual([]);
    expect((await b.a.events()).filter((e) => e.type === 'step_schedule.run_failed').map((e) => e.data)).toEqual([expect.objectContaining({ schedule: 'phrase-drill-backup', run: run.id, exit: 125, outcome: 'failed' })]);
    expect((await b.a.api<StepSchedulesView>('GET', '/api/step-schedules', undefined, { 'x-hopper-session': b.token })).body.failed).toEqual(['phrase-drill-backup']);
    const runs = JSON.parse((await hopper(b, ['schedule', 'runs', 'phrase-drill-backup'])).out) as unknown[];
    expect(runs).toHaveLength(1);

    expect((await hopper(b, ['schedule', 'revoke', 'phrase-drill-backup'])).code).toBe(0);
    expect((await hopper(b, ['schedule', 'revoke', 'phrase-drill-backup'])).code).toBe(2);
    expect((await hopper(b, ['schedule', 'remove', 'phrase-drill-backup'])).code).toBe(0);
    expect(JSON.parse((await hopper(b, ['schedule', 'list'])).out)).toEqual([]);
    expect((await hopper(b, ['schedule', 'run'])).code).toBe(2);
    expect((await b.a.events()).map((e) => e.type)).toEqual(expect.arrayContaining(['step_schedule.saved', 'step_schedule.granted', 'step_schedule.revoked', 'step_schedule.removed']));
  }, 60_000);
});
