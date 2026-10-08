// Issue #18: routing rules through the real daemon. Applied at intake, when a source item becomes
// a job: the first matching rule sets the job's machine pin, executor and/or priority, and the job
// records it (`spec.routedBy`). A rule change applies to new jobs, and to a waiting job on the next sync
// of its source (issue #375; respec.test.ts). Edited from the UI with
// POST /ui/api/routing (whole list, validated, the `routing` section only, 409 stale).
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, RoutingReport } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, TEST_PLUGINS, writePlugins, type TestApp } from '../support/app.ts';
import { readConfig } from '../support/files.ts';
import { mergesPullRequest } from '../support/scripted-executor.ts';
import { waitFor } from '../support/wait.ts';
import { connectGitHub } from '../support/github-account.ts';

const REPO = 'owner/hopper-sandbox';
let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function boot(plugins: Record<string, unknown>, gh?: FakeGitHub, file?: object): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  if (file !== undefined) writePlugins(db.dbPath, file);
  t = await startTestApp({ dbPath: db.dbPath, ...(file === undefined ? { plugins } : {}), ...(gh ? { seams: { github: gh } } : {}) });
  if (gh) connectGitHub(t, [REPO]);
  return t;
}

const github = [{
  name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' },
}];
const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (a: TestApp, key: string): Promise<Job> =>
  waitFor(async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === key), { what: `a job for ${key}` });

describe('routing rules at intake', () => {
  it('a GitHub issue matching a rule (repo glob + label) gets its priority and machine; the job records the rule', async () => {
    const gh = createFakeGitHub();
    const a = await boot({
      jobSources: github,
      routing: [
        { name: 'elsewhere', match: { repo: 'someone/*' }, set: { priority: 5 } },
        { name: 'urgent sandbox', match: { repo: 'owner/*', label: 'URGENT' }, set: { priority: 90, machine: 'local' } },
      ],
    }, gh);
    a.scripted.ships(mergesPullRequest(gh));
    a.setUsage(100); // keep it waiting: the source's re-sort must not undo the rule's priority
    const urgent = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper', 'urgent'] });
    const plain = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    const ju = await jobFor(a, urgent.url);
    expect(ju.priority).toBe(90);
    expect(ju.spec).toMatchObject({ machineId: 'local', priority: 90, routedBy: { rule: 'urgent sandbox', set: { priority: 90, machine: 'local' } } });
    const jp = await jobFor(a, plain.url);
    expect(jp.spec.routedBy).toBeUndefined();
    expect(jp.priority).toBe(50);
    await a.sync();
    expect((await a.job(ju.id)).priority).toBe(90);
    expect((await a.events('types=job.reprioritized')).filter((e) => e.jobId === ju.id)).toEqual([]);
    a.setUsage(0);
    await a.waitForStatus(ju.id, 'finished');
  });

  // Issue #324: a rule routes a repository to a machine and a work tree there. Issue #361: no source
  // names a path; a job no rule routes carries none, and runs in its machine's work tree.
  it('a rule sets the work tree with its machine; a job no rule routes carries no path', async () => {
    const gh = createFakeGitHub();
    const a = await boot({ jobSources: github, routing: [{ name: 'app tree', match: { label: 'app' }, set: { machine: 'local', workTree: '~/code/app' } }] }, gh);
    a.scripted.ships(mergesPullRequest(gh));
    a.setUsage(100);
    const routed = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper', 'app'] });
    const plain = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    const jr = await jobFor(a, routed.url);
    expect(jr.spec).toMatchObject({ machineId: 'local', payload: { cwd: '~/code/app' }, routedBy: { rule: 'app tree', set: { machine: 'local', workTree: '~/code/app' } } });
    const jp = await jobFor(a, plain.url);
    expect(jp.spec.payload).not.toHaveProperty('cwd');
    expect(jp.spec.payload).not.toHaveProperty('defaultCwd');
    a.setUsage(0);
  });

  it('a rule sets the executor: the item\'s own executor is replaced', async () => {
    const a = await boot({ routing: [{ name: 'scripted for manual', match: { source: 'manual', title: 'paint' }, set: { executor: 'scripted' } }] });
    const job = await a.pull({ op: 'echo', message: 'hi' }, { executor: 'test', title: 'Paint the shed' });
    expect(job.spec).toMatchObject({ executor: 'scripted', routedBy: { rule: 'scripted for manual', set: { executor: 'scripted' } } });
    expect((await a.waitForStatus(job.id, 'finished')).result).toMatchObject({ echo: 'hi' });
  });

  it('a rule naming a machine that is not configured is skipped with a warning; intake never fails', async () => {
    const a = await boot({ routing: [{ name: 'to the laptop', match: {}, set: { machine: 'laptop' } }] });
    const job = await a.pull({ op: 'echo' });
    expect(job.spec.routedBy).toBeUndefined();
    expect(job.spec.machineId).toBeUndefined();
    await a.waitForStatus(job.id, 'finished');
    const report = (await a.api<RoutingReport>('GET', '/api/routing')).body;
    expect(report.skipped).toEqual([{ rule: 'to the laptop', reason: 'machine laptop is not configured' }]);
  });
});

const FILE = { version: 1, executors: [{ name: 'test', plugin: 'test' }], jobSources: [], machines: lanes(2) };

describe('GET /api/routing and POST /ui/api/routing', () => {
  it('reads the rules (none when the section is absent), the config version and the targets a rule may name', async () => {
    const a = await boot({}, undefined, FILE);
    const r = (await a.api<RoutingReport>('GET', '/api/routing')).body;
    expect(r).toMatchObject({ rules: [], skipped: [], targets: { machines: ['local'], executors: ['test'] } });
    expect(r.version).toBe((await a.api('GET', '/api/plugins')).body.config.version);
  });

  it('writes the whole list into the routing section only; other sections stay; a waiting job takes it on the next sync', async () => {
    const a = await boot({}, undefined, FILE);
    const token = await a.login();
    a.setUsage(100);
    const before = await a.pull({ op: 'echo' }, { title: 'old job' });
    const version = (await a.api<RoutingReport>('GET', '/api/routing')).body.version;
    const rules = [{ name: 'boost', match: { author: 'owner' }, set: { priority: 80 } }];
    const r = await a.ui<RoutingReport>('/ui/api/routing', { rules, version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.rules).toEqual(rules);
    expect(r.body.version).not.toBe(version);
    expect(readConfig(a.dbPath, 'plugins')).toEqual({ ...FILE, routing: rules });
    const after = await a.pull({ op: 'echo' }, { title: 'new job' });
    expect(after.priority).toBe(80);
    expect((await a.job(before.id)).priority).toBe(80);
    a.setUsage(0);
  });

  it('without a UI session: 403, the plugins config unchanged', async () => {
    const a = await boot({}, undefined, FILE);
    const version = (await a.api<RoutingReport>('GET', '/api/routing')).body.version;
    const r = await a.ui('/ui/api/routing', { rules: [], version });
    expect(r.status).toBe(403);
    expect(readConfig(a.dbPath, 'plugins')).toEqual(FILE);
  });

  it.each([
    ['a lane', [{ name: 'x', match: {}, set: { lane: 'local/lane-1' } }], /lane/],
    ['an unknown machine', [{ name: 'x', match: {}, set: { machine: 'ghost' } }], /machine ghost is not configured/],
    ['an unknown executor', [{ name: 'x', match: {}, set: { executor: 'codex' } }], /executor codex is not configured/],
    ['nothing to set', [{ name: 'x', match: {}, set: {} }], /set at least one/],
  ])('refuses %s: 400, the plugins config unchanged', async (_n, rules, why) => {
    const a = await boot({}, undefined, FILE);
    const token = await a.login();
    const version = (await a.api<RoutingReport>('GET', '/api/routing')).body.version;
    const r = await a.ui<{ error: string }>('/ui/api/routing', { rules, version }, { token });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(why);
    expect(readConfig(a.dbPath, 'plugins')).toEqual(FILE);
  });

  it('a stale version: 409, the plugins config unchanged', async () => {
    const a = await boot({}, undefined, FILE);
    const token = await a.login();
    const version = (await a.api<RoutingReport>('GET', '/api/routing')).body.version;
    const changed = { ...FILE, machines: lanes(3) };
    writePlugins(a.dbPath, changed);
    const r = await a.ui('/ui/api/routing', { rules: [], version }, { token });
    expect(r.status).toBe(409);
    expect(readConfig(a.dbPath, 'plugins')).toEqual(changed);
  });

  it('a routing section set outside the UI applies to the next intake', async () => {
    const a = await boot({}, undefined, FILE);
    writePlugins(a.dbPath, { ...TEST_PLUGINS, machines: lanes(2), routing: [{ name: 'low', match: {}, set: { priority: 3 } }] });
    await waitFor(async () => (await a.api<RoutingReport>('GET', '/api/routing')).body.rules.length === 1, { what: 'the rules to reload' });
    expect((await a.pull({ op: 'echo' })).priority).toBe(3);
  });
});
