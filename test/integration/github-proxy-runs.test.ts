// Issue #2318: a job lists a repository's workflow runs, of a branch and an event, and reads a run's jobs, through the
// hopper. The daemon, store and HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts); the job
// runs the real `hopper-gh` script (sh and curl) against the hopper.
//
// Feature: a job reads GitHub Actions runs through the hopper
//   Scenario: a job lists a branch's push runs, then reads one run's jobs
//     Given octo/tools with runs on dev and main, of push and pull_request
//     When the job runs `run list --branch dev --event push`, then `run view <run id>`
//     Then it is answered the matching runs, newest first, and the run's jobs with their ids, status and conclusion
//     And the same list asked again is answered from the repo-query cache
//     And a run GitHub does not have is a failure, exit 1
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { holder, hopperGh, type Run } from '../support/job-holder.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const json = (r: Run): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-proxy-runs-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const h = holder(root);
  cleanups.push(() => { for (const j of h.held.values()) j.end(); });
  const app = await startTestApp({
    dbPath: db.dbPath,
    seams: { executors: [h.executor] },
    plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools']);
  return { app, github, root, held: h.held };
}

async function running(t: Awaited<ReturnType<typeof start>>) {
  const job = await t.app.pull({}, { executor: 'holder', repo: 'octo/tools' });
  const env = await waitFor(async () => t.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  return { job, env };
}

describe('GitHub Actions runs through the hopper (issue #2318)', () => {
  it('lists a branch\'s workflow runs, and a run\'s jobs, for the job (issue #2318)', async () => {
    const t = await start();
    const job = (id: number, name: string, conclusion: string | null) => ({ id, name, status: conclusion ? 'completed' : 'in_progress', conclusion, html_url: `${t.github.url}/octo/tools/actions/runs/41/job/${id}` });
    t.github.workflowRuns = [
      { repo: 'octo/tools', id: 41, name: 'Release', event: 'push', head_branch: 'dev', head_sha: 'sha-41', status: 'completed', conclusion: 'success', run_number: 12, created_at: '2026-10-20T10:00:00Z', jobs: [job(410, 'release', 'success'), job(411, 'notify', null)] },
      { repo: 'octo/tools', id: 42, name: 'CI', event: 'pull_request', head_branch: 'dev', head_sha: 'sha-42', status: 'completed', conclusion: 'failure', run_number: 13, created_at: '2026-10-20T11:00:00Z', jobs: [] },
      { repo: 'octo/tools', id: 43, name: 'Release', event: 'push', head_branch: 'main', head_sha: 'sha-43', status: 'queued', conclusion: null, run_number: 14, created_at: '2026-10-20T12:00:00Z', jobs: [] },
    ];
    const { env } = await running(t);
    const ask = async (args: string[]) => {
      const r = await hopperGh(t.root, env, [...args, '--repo', 'octo/tools']);
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      return json(r);
    };

    expect(await ask(['run', 'list', '--branch', 'dev', '--event', 'push'])).toMatchObject({ ok: true, op: 'run.list', source: 'github', url: `${t.github.url}/octo/tools/actions`, total: 1, runs: [
      { id: 41, name: 'Release', event: 'push', branch: 'dev', headSha: 'sha-41', status: 'completed', conclusion: 'success', runNumber: 12, createdAt: '2026-10-20T10:00:00Z' },
    ] });
    expect(t.github.requests.find((x) => x.path === '/api/v3/repos/octo/tools/actions/runs')?.query).toMatchObject({ branch: 'dev', event: 'push' });
    expect((await ask(['run', 'list'])).runs).toHaveLength(3);
    expect(await ask(['run', 'view', '41'])).toMatchObject({ ok: true, op: 'run.view', number: 41, url: `${t.github.url}/octo/tools/actions/runs/41`, name: 'Release', conclusion: 'success', jobs: [
      { id: 410, name: 'release', status: 'completed', conclusion: 'success' }, { id: 411, name: 'notify', status: 'in_progress', conclusion: null },
    ] });
    expect(await ask(['run', 'list', '--branch', 'dev', '--event', 'push'])).toMatchObject({ source: 'cache' });

    const missing = await hopperGh(t.root, env, ['run', 'view', '99', '--repo', 'octo/tools']);
    expect(missing.code).toBe(1);
  });
});
