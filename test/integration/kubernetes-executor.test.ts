// Issue #1283 through the real composition root and the real HTTP server: a job on the `kubernetes` executor runs in a
// pod of its own (design.md "Job pods on Kubernetes"). The Kubernetes API is a fake at its seam; the pod it "starts" runs
// the real hopper client, which joins with the pod's join line and dials in — the hopper never connects to it. No
// podman, docker or ssh anywhere.
//
// Feature: a pod per job
//   Scenario: a queued job produces a pod, runs there, finishes, and the pod is removed after
//   Scenario: cancelling a running job deletes its pod
//   Scenario: a pod that never joins fails its job, and is deleted
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { createFakeKubernetes, podEnv, type FakeKubernetes } from '../support/fake-kubernetes.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);

const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const SERVICE_URL = 'http://hopper.hopper.svc:4790';

let t: TestApp | undefined;
const clients = new Map<string, Client>();
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  for (const c of clients.values()) await c.stop();
  clients.clear();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

/**
 * The cluster: a pod, once created, runs the real client with the join line in its spec. The line names the hopper's
 * Service; inside this test the hopper is at its loopback URL, as the Service would route a pod to it.
 */
function cluster(o: { joins?: boolean } = {}): FakeKubernetes {
  const url = { now: '' };
  const k8s: FakeKubernetes & { url?: typeof url } = createFakeKubernetes({
    async onCreate(pod) {
      if (o.joins === false) return;
      const line = podEnv(pod, 'HOPPER_JOIN')!;
      const name = podEnv(pod, 'HOPPER_CLIENT_NAME')!;
      expect(line.startsWith(`${SERVICE_URL}#`)).toBe(true);
      const dir = mkdtempSync(join(tmpdir(), 'hopper-pod-'));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      await joinHopper({ line: line.replace(SERVICE_URL, url.now), name, dir });
      clients.set(name, startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper-client', installDir: testInstallDir(), backoffMs: [50] }));
    },
    async onRemove(name) { await clients.get(name)?.stop(); clients.delete(name); },
  });
  k8s.url = url;
  return k8s;
}

async function boot(k8s: FakeKubernetes, herdr: FakeHerdrClient, startTimeoutSec = 60) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath,
    plugins: {
      executors: [{ name: 'kubernetes', plugin: 'kubernetes', options: { hopperUrl: SERVICE_URL, pollMs: 50, startTimeoutSec } }],
      machines: [{ name: 'cluster', plugin: 'kubernetes-cluster', options: { lanes: 2 } }],
    },
    seams: { herdr, kubernetes: () => k8s, levels: [] },
  });
  (k8s as FakeKubernetes & { url: { now: string } }).url.now = t.url;
  return { a: t, token: await t.login() };
}

const item = { executor: 'kubernetes', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
const machineIds = async (a: TestApp): Promise<string[]> => ((await a.api('GET', '/api/machines')).body.machines as { id: string }[]).map((m) => m.id);

describe('a pod per job on the kubernetes executor', () => {
  it('a queued job produces a pod, runs there, finishes, and its pod is removed after', { timeout: 60_000 }, async () => {
    const k8s = cluster();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    const { a } = await boot(k8s, herdr);
    const job = await a.pull({}, item);
    const done = await a.waitForStatus(job.id, 'finished', 30_000);
    const pod = `hopper-job-${job.id}`;
    expect(done.laneId).toBe('cluster/lane-1');
    expect(k8s.created.map((p) => (p.metadata as { name: string }).name)).toEqual([pod]);
    // The job ran in its pod's herdr: its pane state names the pod's machine.
    expect(JSON.stringify(done.executorState)).toContain(pod);
    // Hopper never opens a connection into the pod: it has no port to open, and nothing in it serves ssh.
    expect(JSON.stringify(k8s.created[0])).not.toMatch(/containerPort|sshd/);
    await waitFor(() => k8s.removed.includes(pod), { what: 'its pod deleted' });
    await waitFor(async () => !(await machineIds(a)).includes(pod), { what: 'its machine removed' });
  });

  it('cancelling a running job deletes its pod', { timeout: 60_000 }, async () => {
    const k8s = cluster();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, DONE] });
    const { a, token } = await boot(k8s, herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running', 30_000);
    await waitFor(() => herdr.prompts.length > 0, { timeoutMs: 30_000, what: 'the prompt sent in the pod' });
    // The pod's machine is its one job's: it runs no executor, so the decider gives it no other job.
    const machines = (await a.api('GET', '/api/machines')).body.machines as { id: string; executors: string[]; client?: unknown }[];
    expect(machines.find((m) => m.id === `hopper-job-${job.id}`)).toMatchObject({ executors: [], client: expect.any(Object) });
    expect((await a.ui(`/ui/api/jobs/${job.id}/cancel`, {}, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'cancelled', 15_000);
    await waitFor(() => k8s.removed.includes(`hopper-job-${job.id}`), { what: 'its pod deleted' });
    expect(k8s.pods.size).toBe(0);
  });

  it('a pod that never joins fails its job at the start limit, and is deleted', { timeout: 60_000 }, async () => {
    const k8s = cluster({ joins: false });
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    const { a } = await boot(k8s, herdr, 10);
    const job = await a.pull({}, item);
    const failed = await a.waitForStatus(job.id, 'failed', 30_000);
    expect(failed.error).toMatch(/did not join the hopper within 10 s/);
    expect(k8s.pods.size).toBe(0);
    expect(herdr.prompts).toEqual([]);
  });
});
