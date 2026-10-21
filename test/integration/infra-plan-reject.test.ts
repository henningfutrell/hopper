// Issue #2368: a person rejects an infra plan the user decided against. A rejected plan is never approved after, from the
// UI or the CLI, and the vault mints nothing for it; who rejected it, when, and the note are kept. The job that waits on
// the plan is woken with the rejection and its note, and goes on. Real daemon, real HTTP server, real CLI, over the fake
// herdr.
//
// Feature: reject an infra plan
//   Background:
//     Given a production plan a job recorded, high risk: an admin approves it
//   Scenario: a job waits on the plan; a person rejects it with a note on Infra: the job is woken with the note and goes
//     on, the plan is rejected, and an approve from the UI or the CLI fails
//   Scenario: the CLI rejects a plan by its short id with a note; the vault refuses an apply of it
//   Scenario: a job that starts to wait on a plan rejected already is told so at once, with the note
//   Scenario: a plan approved already is not rejected; a reject with no note is refused
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
const item = { executor: 'herdr-claude', prompt: 'Delete the production statefulset, keep its pods', cwd: '/tmp', env: {} };
const DONE = { output: ['● Changed course.', '  HOPPER_DONE'] };
const NOTE = 'Keep the statefulset: we move the database another way';
const ASSET = { kind: 'aws-role', name: '123456789012/deploy' } as const;
/** `terraform show -json` of a plan that replaces a production database. */
const PROD = JSON.stringify({
  format_version: '1.2', planned_values: {}, resource_changes: [{
    address: 'aws_db_instance.identity', mode: 'managed', type: 'aws_db_instance', provider_name: 'registry.terraform.io/hashicorp/aws',
    change: { actions: ['delete', 'create'], before: { name: 'identity' }, after: { name: 'identity', tags_all: { 'map-migrated': 'migXWT2TUR4TJ' } }, after_unknown: {} },
  }],
});

const waitOn = (on: string) => ({
  output: ['● The delete needs an approved plan.', '  HOPPER_WAITING', '  for: admin approval of the delete plan', `  on: ${on}`],
  background: { work: '1 shell', polls: 1_000_000 },
});

async function start(): Promise<{ a: TestApp; herdr: FakeHerdrClient; plan: string }> {
  const herdr = createFakeHerdrClient({ session: 'jh-test' });
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  const kept = a.user().githubProxy.infraPlans.record({ id: 'recorder' } as Job, {
    tool: 'terraform', asset: ASSET, target: 'prod-identity', repo: 'octo/infra', ref: 'delete', commit: 'a'.repeat(40),
    text: 'Plan: 1 to add, 0 to change, 1 to destroy.', json: PROD,
  });
  if ('no' in kept) throw new Error(kept.no);
  return { a, herdr, plan: kept.plan.id };
}

async function hopper(a: TestApp, argv: string[]): Promise<{ code: number; json: unknown; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, json: code === 0 ? JSON.parse(out.join('')) as unknown : undefined, err: err.join('') };
}

describe('reject an infra plan (issue #2368)', () => {
  it('a person rejects a plan a job waits on: the job is woken with the note, and the plan is never approved', async () => {
    const { a, herdr, plan } = await start();
    herdr.setTurns(waitOn(`infra plan ${plan}`), DONE);
    const job = await a.waitForStatus((await a.pull({}, item)).id, 'waiting_on', 8000);
    const session = await a.login();

    const rejected = await a.ui('/ui/api/infra-plans', { action: 'reject', plan, note: NOTE }, { token: session });
    expect(rejected.status).toBe(200);
    expect((rejected.body as { plan: PlanView }).plan.rejection).toMatchObject({ plan, note: NOTE, by: expect.any(String), at: expect.any(String) });
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.prompts.at(-1)?.text).toContain(`infra plan ${plan} was rejected by`);
    expect(herdr.prompts.at(-1)?.text).toContain(NOTE);
    expect((await a.events()).find((e) => e.type === 'infra.plan_rejected')).toMatchObject({ jobId: 'recorder', data: { plan, note: NOTE } });

    // Reject, then approve: refused from the UI and from the CLI, and the plan stays rejected.
    const approve = await a.ui('/ui/api/infra-plans', { action: 'approve', plan }, { token: session });
    expect(approve.status).toBe(409);
    expect(JSON.stringify(approve.body)).toContain(`plan ${plan} was rejected`);
    expect((await hopper(a, ['infra', 'approve', plan.slice(0, 8)])).code).not.toBe(0);
    const listed = (await a.api('GET', '/api/infra-plans', undefined, { 'x-hopper-session': session })).body as { plans: PlanView[] };
    expect(listed.plans[0]).toMatchObject({ id: plan, rejection: { note: NOTE } });
    expect(listed.plans[0]!.approval).toBeUndefined();
    expect((await hopper(a, ['infra', 'plans', '--all'])).json).toEqual([expect.objectContaining({ id: plan, state: 'rejected', note: NOTE })]);
    expect((await hopper(a, ['infra', 'plans'])).json).toEqual([]);
  });

  it('the CLI rejects a plan by its short id with a note; the vault refuses an apply of it', async () => {
    const { a, plan } = await start();
    const r = await hopper(a, ['infra', 'reject', plan.slice(0, 8), '--note', NOTE]);
    expect(r).toMatchObject({ code: 0, json: { id: plan, state: 'rejected', note: NOTE } });
    const no = await a.user().githubProxy.infraPlans.gate({ operation: 'apply', asset: ASSET }, plan);
    expect(no).toContain(`plan ${plan} was rejected`);
    expect((await hopper(a, ['infra', 'reject', plan.slice(0, 8)])).code).not.toBe(0);
  });

  it('a job that starts to wait on a plan rejected already is told so at once, with the note', async () => {
    const { a, herdr, plan } = await start();
    expect(a.user().githubProxy.infraPlans.reject(plan, 'Ada', NOTE)).toMatchObject({ rejection: { by: 'Ada', note: NOTE } });
    herdr.setTurns(waitOn(`infra plan ${plan}`), DONE);
    const pulled = await a.pull({}, item);
    await a.waitForStatus(pulled.id, 'finished', 8000);
    expect(herdr.prompts.at(-1)?.text).toContain(`infra plan ${plan} was rejected by Ada: ${NOTE}`);
  });

  it('a plan approved already is not rejected; a reject with no note is refused', async () => {
    const { a, plan } = await start();
    const session = await a.login();
    expect((await a.ui('/ui/api/infra-plans', { action: 'reject', plan }, { token: session })).status).toBe(400);
    expect((await a.ui('/ui/api/infra-plans', { action: 'reject', plan, note: '  ' }, { token: session })).status).toBe(400);
    expect((await a.ui('/ui/api/infra-plans', { action: 'approve', plan }, { token: session })).status).toBe(200);
    const late = await a.ui('/ui/api/infra-plans', { action: 'reject', plan, note: NOTE }, { token: session });
    expect(late.status).toBe(409);
    expect((await a.events()).some((e) => e.type === 'infra.plan_rejected')).toBe(false);
  });
});
