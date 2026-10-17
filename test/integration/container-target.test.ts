// Issue #58 through the real composition root, on the sandbox module since issue #865 part C: a container target with
// no agent in it. An issue a routing rule sends there runs its body as a command in a one-shot sandbox box of the
// target's image — no network, burned after the command —; the job finishes with what it wrote. The container runtime
// is a double at its port (ContainerRuntime).
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { waitFor } from '../support/wait.ts';
import { connectGitHub } from '../support/github-account.ts';

const REPO = 'owner/hopper-sandbox';
const IMAGE = 'example/commands:1';
let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function boot(runtime: FakeContainerRuntime): Promise<{ a: TestApp; gh: ReturnType<typeof createFakeGitHub> }> {
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
        { name: 'box', plugin: 'container', options: { image: IMAGE, lanes: 1 } },
      ],
      jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'test' } }],
      routing: [{ name: 'commands to the box', match: { label: 'on-box' }, set: { machine: 'box', executor: 'command' } }],
    },
    seams: { github: gh, containerRuntime: runtime },
  });
  connectGitHub(t, [REPO]);
  return { a: t, gh };
}

const jobFor = async (a: TestApp, key: string): Promise<Job> =>
  waitFor(async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === key), { what: `a job for ${key}` });

describe('a container target on the sandbox module', () => {
  it('/api/machines lists it online, with its image and the command executor', async () => {
    const { a } = await boot(createFakeContainerRuntime());
    const box = await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string; online: boolean }) => m.id === 'box' && m.online));
    expect(box).toMatchObject({ id: 'box', containerImage: IMAGE, executors: ['command'], maxLanes: 1 });
    expect(box.ssh).toBeUndefined();
    const local = (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'local');
    expect(local.executors).toEqual(['test']);
  });

  it('an issue routed to the box runs its body in a one-shot box with no network; the job finishes with the output, and the box is burned', async () => {
    const runtime = createFakeContainerRuntime();
    // The box's command waits until the job's pull request merged: a run that ends first fails the job as not complete.
    let merged!: () => void;
    const prMerged = new Promise<void>((resolve) => { merged = resolve; });
    runtime.runScript = async (spec) => {
      await prMerged;
      return { exit: 0, output: `ran ${spec.env.HOPPER_STEP_COMMAND?.trim()} for ${spec.env.HOPPER_JOB_ID}\r\n` };
    };
    const { a, gh } = await boot(runtime);
    const issue = gh.createIssue({ repo: REPO, title: 'Where am I', body: 'Run:\n\n```sh\nhostname\n```\n', labels: ['hopper', 'on-box'] });
    await a.sync();
    const job = await jobFor(a, issue.url);
    expect(job.spec).toMatchObject({ executor: 'command', machineId: 'box' });
    // The job's pull request merges while it runs: only a job that shipped is finished (issue #171).
    gh.closeByPullRequest(REPO, issue.number, { createdAt: job.createdAt, mergedAt: new Date().toISOString() });
    merged();
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ machine: 'box', exitCode: 0, stdout: `ran hostname for ${job.id}\n`, stderr: '' });
    const [spec] = [...runtime.ran.values()];
    expect(spec).toMatchObject({ image: IMAGE, network: 'none' });
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
  });

  it('while the container runtime cannot start a box, the box is offline and its command job waits', async () => {
    const runtime = createFakeContainerRuntime();
    runtime.down = 'podman does not answer';
    const { a, gh } = await boot(runtime);
    const issue = gh.createIssue({ repo: REPO, title: 'Nowhere', body: 'hostname', labels: ['hopper', 'on-box'] });
    await a.sync();
    const job = await jobFor(a, issue.url);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await a.job(job.id)).status).toBe('held');
    const box = (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'box');
    expect(box.online).toBe(false);
    expect(runtime.ran.size).toBe(0);
  });
});
