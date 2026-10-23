// Issue #2392: the HTTP read routes that read many rows read them off the event loop, through the read pool
// (design.md "Database": "Reads off the loop"). A read route that waits on the database holds no timer and no
// GET /api/health; a read sees the write that returned before it. Real daemon, real HTTP server, real Postgres.
//
// Feature: reads off the event loop
//   Scenario: GET /api/infra-plans waits on a lock: a timer runs and GET /api/health answers meanwhile; the plans come after
//   Scenario: GET /api/infra-plans/:id waits on a lock the same way
//   Scenario: a read sees the write that returned before it: a job's update, a plan's approval
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { PlanView } from '../../src/domain/infra-plans.ts';
import { ownerSchemaUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
const clients: pg.Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.end().catch(() => {});
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const ASSET = { kind: 'aws-role', name: '123456789012/deploy' } as const;
/** `terraform show -json` of a plan that adds one tagged bucket. */
const JSON_PLAN = JSON.stringify({
  format_version: '1.2', planned_values: {}, resource_changes: [{
    address: 'aws_s3_bucket.logs', mode: 'managed', type: 'aws_s3_bucket', provider_name: 'registry.terraform.io/hashicorp/aws',
    change: { actions: ['create'], before: null, after: { bucket: 'logs', tags_all: { 'map-migrated': 'migXWT2TUR4TJ' } }, after_unknown: {} },
  }],
});

async function start(): Promise<{ a: TestApp; plan: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = t = await startTestApp({ dbPath: db.dbPath });
  const kept = a.user().githubProxy.infraPlans.record({ id: 'recorder' } as Job, {
    tool: 'terraform', asset: ASSET, target: 'utility-identity', repo: 'octo/infra', ref: 'main', commit: 'a'.repeat(40),
    text: 'Plan: 1 to add, 0 to change, 0 to destroy.', json: JSON_PLAN,
  });
  if ('no' in kept) throw new Error(kept.no);
  return { a, plan: kept.plan.id };
}

/** A connection of the test's own, async, that holds the admin's `table` until `release`. */
async function holdTable(a: TestApp, table: string): Promise<{ waiting(): Promise<boolean>; release(): Promise<void> }> {
  const url = new URL(ownerSchemaUrlFor(a.dbPath));
  const schema = url.searchParams.get('schema')!;
  url.searchParams.delete('schema');
  const c = new pg.Client({ connectionString: url.toString() });
  clients.push(c);
  await c.connect();
  const name = `"${schema}".${table}`;
  await c.query('BEGIN');
  await c.query(`LOCK TABLE ${name} IN ACCESS EXCLUSIVE MODE`);
  return {
    waiting: async () => Number((await c.query(`SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND relation = '${name}'::regclass`)).rows[0].n) > 0,
    release: async () => { await c.query('ROLLBACK'); },
  };
}

/** Until `ok` is true; each check is an await, so it runs only while the event loop is free. */
async function until(ok: () => Promise<boolean>): Promise<void> {
  while (!(await ok())) await new Promise((r) => setTimeout(r, 10));
}

/** The read `path`, made while `table` is held: a timer and GET /api/health answer before it. */
async function readWhileHeld(a: TestApp, table: string, path: string) {
  const held = await holdTable(a, table);
  let answered = false;
  const read = a.api('GET', path).then((r) => { answered = true; return r; });
  await until(held.waiting);
  const timer = await new Promise<string>((r) => setTimeout(() => r('ran'), 5));
  expect(timer).toBe('ran');
  const health = await a.api('GET', '/api/health');
  expect(health.status).toBe(200);
  expect(health.body.ok).toBe(true);
  expect(answered).toBe(false);
  await held.release();
  return read;
}

describe('reads off the event loop (issue #2392)', () => {
  it('GET /api/infra-plans waits on a lock: a timer runs and GET /api/health answers meanwhile; the plans come after', async () => {
    const { a, plan } = await start();
    const r = await readWhileHeld(a, 'infra_plans', '/api/infra-plans');
    expect(r.status).toBe(200);
    expect((r.body as { plans: PlanView[] }).plans.map((p) => p.id)).toEqual([plan]);
  });

  it('GET /api/infra-plans/:id waits on a lock the same way', async () => {
    const { a, plan } = await start();
    const r = await readWhileHeld(a, 'infra_plans', `/api/infra-plans/${plan}`);
    expect(r.status).toBe(200);
    expect((r.body as { plan: PlanView & { text: string } }).plan).toMatchObject({ id: plan, text: 'Plan: 1 to add, 0 to change, 0 to destroy.' });
  });

  it('a read sees the write that returned before it: a job\'s update, a plan\'s approval', async () => {
    const { a, plan } = await start();
    const job = a.user().store.jobs.create({ executor: 'test', payload: {} }, 50);
    expect((await a.api('GET', '/api/jobs')).body.jobs.map((j: Job) => j.id)).toContain(job.id);
    a.user().store.jobs.update(job.id, { priority: 7 });
    expect((await a.api('GET', '/api/jobs')).body.jobs.find((j: Job) => j.id === job.id).priority).toBe(7);

    const approved = a.user().githubProxy.infraPlans.approve(plan, 'Ada', 'admin');
    expect('no' in approved).toBe(false);
    expect((await a.api('GET', `/api/infra-plans/${plan}`)).body.plan.approval).toMatchObject({ plan, by: 'Ada' });
    expect((await a.api('GET', '/api/infra-plans')).body.plans[0].approval).toMatchObject({ plan, by: 'Ada' });
  });
});
