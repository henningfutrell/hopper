// Model routing (issue #2848): an admin turns it on; at intake a simple job gets the cheap model and a complex one the
// strong model, with the job's budget from that choice; a failed cheap job's next job escalates once to the strong
// model, and says so. The budget is enforced as the token budget's (issue #2302): a job whose spend reaches its model's
// budget at a checkpoint is paused, not killed. Real daemon, the test executor and the fake herdr.
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCapture, Job } from '../../src/domain/types.ts';
import { DEFAULT_MODEL_ROUTING, type ModelRoutingSettings } from '../../src/domain/model-routing.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const LONG = Array.from({ length: 12 }, (_, i) => `- [ ] step ${i}: change the module and its tests`).join('\n');

async function boot(herdr: FakeHerdrClient = createFakeHerdrClient({ session: 'jh-test', turns: [] })): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: [{ name: 'local', plugin: 'local', options: { lanes: 1, workTree: '~/shed' } }] }, seams: { herdr } });
  apps.push(a);
  return a;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const set = (a: TestApp, token: string, body: Partial<ModelRoutingSettings>) => a.ui<ModelRoutingSettings>('/ui/api/model-routing', body, { token });
const ON = { on: true, executors: ['scripted', 'herdr-claude'], strong: { model: 'opus', jobTokens: 0, jobCostUsd: 0 } };

describe('model routing', () => {
  it('is off by default, with the default rules; an admin changes it, and the change is an event', async () => {
    const a = await boot();
    const token = await a.login();
    expect((await a.api('GET', '/api/model-routing')).body).toEqual(DEFAULT_MODEL_ROUTING);
    const r = await set(a, token, ON);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...DEFAULT_MODEL_ROUTING, ...ON });
    expect((await a.api('GET', '/api/model-routing')).body).toEqual({ ...DEFAULT_MODEL_ROUTING, ...ON });
    expect((await a.events('types=model_routing.settings_changed'))[0]!.data).toMatchObject({ from: { on: false }, to: { on: true, executors: ['scripted', 'herdr-claude'] } });
    expect((await set(a, token, { rules: [{ name: 'a', match: {}, choice: 'cheap' }, { name: 'a', match: {}, choice: 'cheap' }] })).status).toBe(400);
    expect((await set(a, token, { cheap: { model: 'x y', jobTokens: 0, jobCostUsd: 0 } })).status).toBe(400);
    expect((await set(a, token, {})).status).toBe(400);
  });

  it('routes nothing while it is off', async () => {
    const a = await boot();
    const job = await a.pull({ op: 'echo' }, { title: 'Fix a typo', repo: 'owner/a' });
    expect(job.spec.modelRoute).toBeUndefined();
    expect(job.spec.payload.model).toBeUndefined();
  });

  it('routes a simple job to the cheap model and a complex one to the strong model, by the default rules', async () => {
    const a = await boot();
    await set(a, await a.login(), ON);
    const simple = await a.pull({ op: 'echo' }, { title: 'Fix a typo', body: 'One word is wrong.', repo: 'owner/a' });
    expect(simple.spec.payload.model).toBe('sonnet');
    expect(simple.spec.modelRoute).toMatchObject({ choice: 'cheap', model: 'sonnet', rule: 'small-work', size: 'small', budget: { jobCostUsd: 5 } });
    const complex = await a.pull({ op: 'echo' }, { title: 'Split the store', body: LONG, repo: 'owner/a' });
    expect(complex.spec.payload.model).toBe('opus');
    expect(complex.spec.modelRoute).toMatchObject({ choice: 'strong', model: 'opus', rule: 'default', size: 'large' });
    const queued = (await a.events('types=job.queued')).find((e) => e.jobId === simple.id)!;
    expect(queued.data).toMatchObject({ spec: { modelRoute: { choice: 'cheap' } } });
  });

  it('escalates a failed cheap job\'s next job to the strong model once, and records it', async () => {
    const a = await boot();
    const token = await a.login();
    await set(a, token, ON);
    const cheap = await a.pull({ op: 'fail', ms: 0, message: 'tests fail' }, { title: 'Fix a typo', repo: 'owner/a' });
    expect(cheap.spec.modelRoute?.choice).toBe('cheap');
    await a.waitForStatus(cheap.id, 'failed', 10_000);
    expect((await a.ui(`/ui/api/jobs/${cheap.id}/rerun`, {}, { token })).status).toBe(202);
    const next = await waitFor(async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.rerunOf === cheap.id), { what: 'the next job', timeoutMs: 10_000 });
    expect(next.spec.payload.model).toBe('opus');
    expect(next.spec.modelRoute).toMatchObject({ choice: 'strong', rule: 'escalated', escalated: { from: 'cheap', jobId: cheap.id } });
    const escalated = (await a.events('types=job.model_escalated')).filter((e) => e.jobId === next.id);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.data).toMatchObject({ from: 'cheap', to: 'strong', model: 'opus', after: cheap.id });
  });
});

// The budget from the model choice, enforced end to end by the token budget's pause (issue #2302 part 3): a checkpoint
// keeps the job's use, and over its model's budget the job is parked, its agent session kept.
describe('the budget of a model choice', () => {
  const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
  const assistant = (id: string, usage: object): string =>
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-21T08:00:00.000Z', requestId: `r-${id}`, message: { id, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'x' }], usage } });
  // 1,610 tokens.
  const capture: CheckpointCapture = { taken: { branch: 'hopper/shed', base: 'b'.repeat(40), head: 'c'.repeat(40), commits: [], patch: gzipSync(''),
    session: gzipSync(`${assistant('m1', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 })}\n`) } };

  it('pauses a cheap job that reaches its model\'s budget; the token budget alone would not', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [`${homedir()}/shed`], checkpoint: capture });
    const a = await boot(herdr);
    await set(a, await a.login(), { ...ON, cheap: { model: 'sonnet', jobTokens: 1000, jobCostUsd: 0 } });
    const job = await a.pull({}, { executor: 'herdr-claude', prompt: 'Paint the shed', title: 'Paint the shed', env: {} });
    expect(job.spec.modelRoute).toMatchObject({ choice: 'cheap', budget: { jobTokens: 1000 } });
    await a.waitForStatus(job.id, 'running', 10_000);
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    await a.user().engine.checkpoints.take(job.id);
    const parked = await a.waitForStatus(job.id, 'parked', 10_000);
    expect(parked.budgetPaused).toMatchObject({ tokens: 1610, why: 'Paused: the job used 1,610 tokens, its token budget is 1,000 tokens.' });
    expect(parked.agentSession).toBeDefined();
  });
});
