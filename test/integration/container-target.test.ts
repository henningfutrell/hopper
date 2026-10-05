// Issue #58 through the real composition root: a container target reached over docker exec, not
// ssh, with no agent in it. An issue a routing rule sends there runs its body as a command in the
// container; the job finishes with what it printed. The container is real (alpine, no network);
// its probe is the real one (`docker container inspect`). Docker is reached the way the daemon must
// reach it (issue #59): through an allowlisting socket proxy only this user can open.
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { startDockerProxy, type DockerProxy } from '../support/docker-proxy.ts';
import { waitFor } from '../support/wait.ts';

const CONTAINER = `jh-it-target-${process.pid}`;
const REPO = 'owner/hopper-sandbox';
let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
let proxy: DockerProxy;

beforeAll(async () => {
  execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '--network', 'none', '--hostname', 'target-box', 'alpine:latest', 'sleep', '600']);
  proxy = await startDockerProxy([CONTAINER, 'jh-no-such-container']);
}, 60000);
afterAll(() => {
  proxy.stop();
  execFileSync('docker', ['rm', '-f', CONTAINER]);
});
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function boot(container: string): Promise<{ a: TestApp; gh: ReturnType<typeof createFakeGitHub> }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const gh = createFakeGitHub();
  t = await startTestApp({
    dbPath: db.dbPath,
    plugins: {
      executors: [{ name: 'test', plugin: 'test' }, { name: 'command', plugin: 'command' }],
      // This machine does not run commands: a command job waits for its target.
      machines: [
        { name: 'local', plugin: 'local', options: { lanes: 2, executors: ['test'] } },
        { name: 'box', plugin: 'docker', options: { docker: container, lanes: 1 } },
      ],
      jobSources: [{ name: 'github', plugin: 'github-gh', options: { enabled: true, pollSeconds: 3600, repos: [REPO], authors: ['owner'], executor: 'test', defaultCwd: '/tmp' } }],
      routing: [{ name: 'commands to the box', match: { label: 'on-box' }, set: { machine: 'box', executor: 'command' } }],
    },
    seams: { github: gh },
    secrets: { HOPPER_DOCKER_HOST: proxy.host },
  });
  return { a: t, gh };
}

const jobFor = async (a: TestApp, key: string): Promise<Job> =>
  waitFor(async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === key), { what: `a job for ${key}` });

describe('a container target reached over docker exec', () => {
  it('without HOPPER_DOCKER_HOST the box stays offline: the daemon never falls back to the root docker socket', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    t = await startTestApp({
      dbPath: db.dbPath,
      plugins: {
        executors: [{ name: 'test', plugin: 'test' }, { name: 'command', plugin: 'command' }],
        machines: [
          { name: 'local', plugin: 'local', options: { lanes: 1, executors: ['test'] } },
          { name: 'box', plugin: 'docker', options: { docker: CONTAINER, lanes: 1 } },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 1500));
    const box = (await t.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'box');
    expect(box.online).toBe(false);
  });

  it('/api/machines lists it online, with its container and the command executor', async () => {
    const { a } = await boot(CONTAINER);
    const box = await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string; online: boolean }) => m.id === 'box' && m.online));
    expect(box).toMatchObject({ id: 'box', docker: CONTAINER, executors: ['command'], maxLanes: 1 });
    expect(box.ssh).toBeUndefined();
    const local = (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'local');
    expect(local.executors).toEqual(['test']);
  });

  it('an issue routed to the box runs its body there as a command; the job finishes with the output', async () => {
    const { a, gh } = await boot(CONTAINER);
    const issue = gh.createIssue({ repo: REPO, title: 'Where am I', body: 'Run:\n\n```sh\nhostname\n```\n', labels: ['hopper', 'on-box'] });
    await a.sync();
    const job = await jobFor(a, issue.url);
    expect(job.spec).toMatchObject({ executor: 'command', machineId: 'box' });
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ machine: 'box', exitCode: 0, stdout: 'target-box\n', stderr: '' });
  });

  it('while the container is not there, the box is offline and its command job waits', async () => {
    const { a, gh } = await boot('jh-no-such-container');
    const issue = gh.createIssue({ repo: REPO, title: 'Nowhere', body: 'hostname', labels: ['hopper', 'on-box'] });
    await a.sync();
    const job = await jobFor(a, issue.url);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await a.job(job.id)).status).toBe('held');
    const box = (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'box');
    expect(box.online).toBe(false);
  });
});
