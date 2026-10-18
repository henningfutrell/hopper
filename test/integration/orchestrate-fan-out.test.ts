// Issue #1909: fan-out and completion end to end, on a machine with only the hopper's files. A job of octo/tools#1 loads
// the orchestrate skill, files its sub-task as a required child with a fan-out key, and waits on it. A person approves the
// child's request card; the child's own job runs and its merge closes the child; the hopper wakes the parent, which files
// the sub-task again with the same key, learns the issue it filed, files nothing twice, and finishes. The daemon, store
// and HTTP edge are real. GitHub is two fakes: one on loopback for what a job asks the hopper (test/support/fake-forges.ts),
// and the in-memory one the job source reads; the test shows the source the child as GitHub would, with the same number.
//
//   Given a job of octo/tools#1 from the job source, on a machine with no workflow repository
//   When  it loads orchestrate, files sub-task t1 (--required --key fanout-t1) and waits on issue octo/tools#2
//   Then  the child is a request card, not a job; approved, its job runs and ends; the merge closes the child
//   And   the parent's wait ends; it files t1 again: the same issue, replayed; GitHub holds one child; it finishes
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor, ExecutionContext, ExecutionOutcome, MachineShell } from '../../src/domain/ports.ts';
import { ADMIN_ID, type DiscoveryFacts, type Job } from '../../src/domain/types.ts';
import { builtInSkills } from '../../src/skill-library/index.ts';
import { createFakeGitHub as createSourceGitHub } from '../../src/sources/index.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { hopperGh, type Run } from '../support/job-holder.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'octo/tools';
const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const NOTHING: DiscoveryFacts = { path: ['/usr/bin'], bins: [{ dir: '/usr/bin', name: 'sh' }], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] } };
const SUB_TASK = ['issue', 'create', '--repo', REPO, '--title', 't1: the schema change', '--body', 'Change the schema. Done when its test passes.', '--required', '--key', 'fanout-t1'];

function hopperSkill(root: string, env: Record<string, string>, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile('sh', [join(root, env.HOPPER_SKILL!), ...args], {
      env: { PATH: process.env.PATH, HOPPER_URL: env.HOPPER_URL, HOPPER_TOKEN_FILE: join(root, env.HOPPER_TOKEN_FILE!) } as NodeJS.ProcessEnv,
    }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

/**
 * An executor that plays the orchestrate skill on a machine whose disk is `root`: the parent (issue #1) loads the skill,
 * files t1 and waits on it; woken, it files t1 again and finishes. Any other job (the child) ends finished at once.
 */
function orchestrating(root: string) {
  const runs: { jobId: string; step: string; out: Run }[] = [];
  const shell: MachineShell = {
    async reap() { return { kept: [] }; },
    async survey() { return { scopes: [], processes: [], scratch: [] }; },
    async keepCredential(_jobId, dir, file, content) {
      const path = join(root, dir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
    },
    async discover() { return NOTHING; },
    async reach() { return undefined; },
  };
  const env = async (ctx: ExecutionContext) => ({ ...(await ctx.credentials?.(`/work/.worktrees/@scratch/${ctx.job.id}`)) });
  const step = async (job: Job, name: string, run: Promise<Run>): Promise<Run> => { const out = await run; runs.push({ jobId: job.id, step: name, out }); return out; };
  const executor: Executor = {
    name: 'orchestrating', idempotent: false, validate: () => null, machineShell: () => shell,
    async run(ctx): Promise<ExecutionOutcome> {
      if (ctx.job.source?.number !== 1) return { kind: 'finished', result: 'the child is done' };
      const e = await env(ctx);
      await step(ctx.job, 'load', hopperSkill(root, e, ['orchestrate']));
      const filed = await step(ctx.job, 'file', hopperGh(root, e, SUB_TASK));
      const on = (JSON.parse(filed.stdout) as { waitOn?: string }).waitOn;
      return { kind: 'wait', wait: { for: 'sub-task t1', on: on ?? 'nothing', until: 'its issue closes' } };
    },
    async resume(ctx): Promise<ExecutionOutcome> {
      const e = await env(ctx);
      await step(ctx.job, 'resume', hopperGh(root, e, SUB_TASK));
      return { kind: 'finished', result: 'every sub-task is done' };
    },
  };
  return { executor, runs };
}

describe('fan-out and completion end to end (issue #1909)', () => {
  it('a sub-task is filed once, approved, done by its own job, and its close wakes the parent, which finishes', async () => {
    const forge = await createFakeGitHub({ clientId: 'gh-client-id' });
    cleanups.push(() => forge.close());
    forge.tokens.set('test-account-token', 'owner');
    const gh = createSourceGitHub();
    const root = mkdtempSync(join(tmpdir(), 'hopper-fan-out-machine-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const o = orchestrating(root);
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const app = await startTestApp({
      dbPath: db.dbPath,
      seams: { github: gh, executors: [o.executor] },
      plugins: {
        executors: [{ name: 'test', plugin: 'test' }],
        jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'orchestrating' } }],
      },
      env: { HOPPER_GITHUB_URL: forge.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
    });
    apps.push(app);
    connectGitHub(app, [REPO]);
    const token = await app.login();
    const store = app.user(ADMIN_ID).store;

    // The parent: the user's own issue, so a job at once.
    const parentIssue = gh.createIssue({ repo: REPO, title: 'Ship it in parts', body: 'Ship it in parts.', labels: ['hopper'], assignees: ['owner'], author: 'owner' });
    forge.issues.push({ repo: REPO, number: parentIssue.number, title: parentIssue.title, body: parentIssue.body, author: 'owner', labels: ['hopper'] });
    await app.sync();
    const parent = await waitFor(async () => store.jobs.list().find((j) => j.source?.key === parentIssue.url && j.status === 'waiting_on'), { what: 'the parent to wait on its sub-task' });
    expect(o.runs.map((r) => [r.step, r.out.code])).toEqual([['load', 0], ['file', 0]]);
    const { version } = builtInSkills().find((s) => s.name === 'orchestrate')!;
    expect(o.runs[0]!.out.stdout.startsWith(`skill orchestrate, version ${version}\n`)).toBe(true);
    expect(JSON.parse(o.runs[1]!.out.stdout)).toMatchObject({ number: 2, parent: `${REPO}#1`, required: true, routed: true, waitOn: `issue ${REPO}#2` });
    expect(parent.wait?.on).toMatchObject({ kind: 'item' });

    // The child, as GitHub shows it to the job source: the hopper's label and the user as assignee, the text the job wrote.
    const filed = forge.issues.find((i) => i.repo === REPO && i.number === 2)!;
    const child = gh.createIssue({ repo: REPO, title: filed.title, body: filed.body, author: 'owner', labels: filed.labels, assignees: ['owner'], parent: 1 });
    expect(child.number).toBe(2);
    await app.sync();
    const card = await waitFor(async () => {
      const intake = (await app.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake as { key: string; action?: string; request?: { hash: string } }[];
      return intake.find((x) => x.key === child.url && x.action === 'approve');
    }, { what: 'the child\'s request card' });
    expect(store.jobs.list().filter((j) => j.source?.key === child.url)).toEqual([]);

    // A person approves it; its own job runs and ends.
    const approved = await app.ui('/ui/api/sources/github/intake', { kind: 'approve', keys: [child.url], hash: card.request!.hash }, { token });
    expect(approved).toMatchObject({ status: 200, body: { done: [child.url] } });
    const childJob = await waitFor(async () => store.jobs.list().find((j) => j.source?.key === child.url), { what: 'the child\'s job' });
    await app.waitForStatus(childJob.id, 'finished');

    // The merge of the child's pull request closes it; the next sync wakes the parent, and it finishes.
    const now = new Date().toISOString();
    gh.closeByPullRequest(REPO, child.number, { createdAt: now, mergedAt: now });
    await app.sync();
    await app.waitForStatus(parent.id, 'finished');
    expect(o.runs.filter((r) => r.jobId === parent.id).map((r) => r.step)).toEqual(['load', 'file', 'resume']);
    expect(JSON.parse(o.runs.at(-1)!.out.stdout)).toMatchObject({ number: 2, replayed: true });
    expect(forge.issues.filter((i) => i.repo === REPO).map((i) => i.number)).toEqual([1, 2]);
    expect(store.events.recent(1000, ['job.child_issue_filed'])).toHaveLength(1);
  });
});
