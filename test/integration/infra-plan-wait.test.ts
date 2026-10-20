// Issue #2205: a job waits on a person's approval of a production infra plan. The plan is where the owner looks at once —
// Infra and Needs you read it, and the operator CLI lists it —; a person approves it from the UI or the CLI, and the job
// goes on. A plan that is not recorded where the UI looks ends the wait at once, and the job is told so. Real daemon,
// real HTTP server, real CLI, over the fake herdr.
//
// Feature: a job's wait on an infra plan
//   Background:
//     Given a production plan a job recorded, high risk: an admin approves it
//   Scenario: the job names the plan as a gated outside event; it waits on the plan, which Infra lists as waiting,
//     and the CLI lists and approves it by its short id: the job goes on, told who approved it
//   Scenario: a person approves it on Infra: the job goes on
//   Scenario: the job waits on a plan that is not recorded: the wait ends at once, and the job is told why
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { Job } from '../../src/domain/types.ts';
import type { PlanView } from '../../src/domain/infra-plans.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 300, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Restart the Keycloak statefulset in production', cwd: '/tmp', env: {} };
const DONE = { output: ['● Restarted.', '  HOPPER_DONE'] };
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
/** `terraform show -json` of a plan that replaces the production Keycloak database. */
const PROD = JSON.stringify({
  format_version: '1.2', planned_values: {}, resource_changes: [{
    address: 'aws_db_instance.keycloak', mode: 'managed', type: 'aws_db_instance', provider_name: 'registry.terraform.io/hashicorp/aws',
    change: { actions: ['delete', 'create'], before: { name: 'keycloak' }, after: { name: 'keycloak', tags_all: { 'map-migrated': 'migXWT2TUR4TJ' } }, after_unknown: {} },
  }],
});

/** The job's turn that ends in a wait on `on`, as the job in the issue wrote it. */
const waitOn = (on: string) => ({
  output: ['● The restart needs an approved plan.', '  HOPPER_WAITING', '  for: admin approval of the Keycloak restart plan', `  on: ${on}`],
  background: { work: '1 shell', polls: 1_000_000 },
});

async function start(): Promise<{ a: TestApp; herdr: FakeHerdrClient; plan: string }> {
  const herdr = createFakeHerdrClient({ session: 'jh-test' });
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  const kept = a.user().githubProxy.infraPlans.record({ id: 'recorder' } as Job, {
    tool: 'terraform', asset: { kind: 'aws-role', name: '123456789012/deploy' }, target: 'prod-keycloak', repo: 'octo/infra', ref: 'restart',
    commit: 'a'.repeat(40), text: 'Plan: 1 to add, 0 to change, 1 to destroy.', json: PROD,
  });
  if ('no' in kept) throw new Error(kept.no);
  return { a, herdr, plan: kept.plan.id };
}

async function hopper(a: TestApp, argv: string[]): Promise<{ code: number; json: unknown }> {
  const out: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => {} };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, json: code === 0 ? JSON.parse(out.join('')) as unknown : undefined };
}

describe('a job that waits on an infra plan (issue #2205)', () => {
  it('waits on the plan, which Infra and the CLI list; the CLI approves it and the job goes on', async () => {
    const { a, herdr, plan } = await start();
    herdr.setTurns(waitOn(`outside: gated: admin approval of infra plan ${plan} (Keycloak statefulset restart, production)`), DONE);
    const job = await a.waitForStatus((await a.pull({}, item)).id, 'waiting_on', 8000);
    expect(job.wait?.on).toEqual({ kind: 'plan', planId: plan });

    const session = await a.login();
    const listed = (await a.api('GET', '/api/infra-plans', undefined, { 'x-hopper-session': session })).body as { plans: PlanView[] };
    expect(listed.plans).toEqual([expect.objectContaining({ id: plan, approver: expect.objectContaining({ who: 'admin' }) })]);
    expect(listed.plans[0]!.approval).toBeUndefined();

    const waiting = await hopper(a, ['infra', 'plans']);
    expect(waiting).toMatchObject({ code: 0, json: [{ id: plan, state: 'waiting', approver: 'admin', level: 'high', job: 'recorder' }] });

    expect(await hopper(a, ['infra', 'approve', plan.slice(0, 8)])).toMatchObject({ code: 0, json: { id: plan, state: 'approved' } });
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.prompts.at(-1)?.text).toContain(`infra plan ${plan} was approved by`);
    expect((await hopper(a, ['infra', 'plans'])).json).toEqual([]);
  });

  it('a person approves it on Infra: the job goes on', async () => {
    const { a, herdr, plan } = await start();
    herdr.setTurns(waitOn(`infra plan ${plan}`), DONE);
    const job = await a.waitForStatus((await a.pull({}, item)).id, 'waiting_on', 8000);
    const session = await a.login();
    expect((await a.ui('/ui/api/infra-plans', { action: 'approve', plan }, { token: session })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.prompts.at(-1)?.text).toContain(`The hopper ended your wait (approval of infra plan ${plan})`);
  });

  it('a plan not recorded where the UI looks ends the wait at once, and the job is told so', async () => {
    const { a, herdr } = await start();
    herdr.setTurns(waitOn(`infra plan ${UNKNOWN}`), DONE);
    const pulled = await a.pull({}, item);
    await a.waitForStatus(pulled.id, 'finished', 8000);
    expect(herdr.prompts.at(-1)?.text).toContain(`no infra plan ${UNKNOWN} is recorded on this hopper, so no person can see or approve it`);
    const ended = (await a.events()).find((e) => e.jobId === pulled.id && e.type === 'job.wait_ended');
    expect(ended?.data).toMatchObject({ by: 'hopper' });
  });
});
