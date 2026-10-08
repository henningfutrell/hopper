// Phase 5 slice 3 through the real composition root: executors are plugin instances from
// the plugins config's `executors`; one that cannot run holds the jobs naming it — never
// fails or re-routes them — and they run once a restart brings it up. /api/plugins shows the
// executor role, detection per plugin and per instance, a pending change, and the
// command-bearing marks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
  cleanup = undefined;
});

function newDb(): string {
  const db = tempDbPath();
  cleanup = db.cleanup;
  return db.dbPath;
}

async function boot(dbPath: string): Promise<TestApp> {
  const a = await startTestApp({ dbPath });
  apps.push(a);
  return a;
}

/** A custom executor plugin that finishes every job at once, echoing its prompt and the machine it ran on. */
function installEchoExecutor(dbPath: string): void {
  const dir = join(dirname(dbPath), 'plugins', 'echo-executor');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'index.js'), [
    "export default { id: 'echo-executor', role: 'executor', describe: 'finishes at once',",
    "  async detect() { return { status: 'available' }; },",
    "  create() { return { name: 'echo-executor', idempotent: true, validate() { return null; },",
    "    async run(ctx) { return { kind: 'finished', result: { echoed: ctx.job.spec.payload.prompt, machine: ctx.machine?.id } }; } }; } };",
  ].join('\n'), { mode: 0o600 });
}

async function stillHeld(a: TestApp, id: string): Promise<Job> {
  const held = await a.waitForStatus(id, 'held');
  await new Promise((r) => setTimeout(r, 300)); // several ticks: it stays held
  const after = await a.job(id);
  expect(after.status).toBe('held');
  expect(after.holdReason).toBe(held.holdReason);
  expect((await a.events(`types=job.failed&limit=1000`)).filter((e) => e.jobId === id)).toEqual([]);
  return after;
}

describe('an executor that cannot run holds its jobs', () => {
  it('unknown plugin and herdr not installed: jobs held with the reason, never failed; a runnable job runs', async () => {
    const dbPath = newDb();
    writePlugins(dbPath, {
      version: 1,
      executors: [
        { name: 'test', plugin: 'test' },
        { name: 'broken', plugin: 'no-such-executor' },
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { bin: '/nonexistent/herdr' } },
      ],
    });
    const a = await boot(dbPath);

    const broken = await a.pull({}, { executor: 'broken' });
    expect(broken.status).not.toBe('failed');
    expect((await stillHeld(a, broken.id)).holdReason).toBe('executor broken unavailable: unknown executor plugin no-such-executor');

    const herdr = await a.pull({}, { executor: 'herdr-claude' });
    expect((await stillHeld(a, herdr.id)).holdReason).toBe('executor herdr-claude unavailable: herdr not found: /nonexistent/herdr');
    const held = (await a.events('types=job.held&limit=1000')).find((e) => e.jobId === herdr.id)!;
    expect(held.data).toMatchObject({ reason: 'executor herdr-claude unavailable: herdr not found: /nonexistent/herdr' });

    const ok = await a.pull({ op: 'echo', message: 'hi' });
    await a.waitForStatus(ok.id, 'finished');
    expect((await a.api('GET', '/api/health')).body.executors).toEqual(['test', 'scripted']);
  });

  it('a job not naming a configured executor still fails at intake (unknown executor)', async () => {
    const a = await boot(newDb());
    const job = await a.pull({}, { executor: 'never-configured' });
    expect(job).toMatchObject({ status: 'failed', error: expect.stringMatching(/unknown executor never-configured/) });
  });

  it('held across a restart, then run by the same instance name once its plugin is installed', async () => {
    const dbPath = newDb();
    writePlugins(dbPath, { version: 1, executors: [{ name: 'test', plugin: 'test' }, { name: 'later', plugin: 'echo-executor' }] });
    const first = await boot(dbPath);
    const job = await first.pull({}, { executor: 'later', prompt: 'ping' });
    expect((await stillHeld(first, job.id)).holdReason).toBe('executor later unavailable: unknown executor plugin echo-executor');
    await first.stop();
    apps.splice(apps.indexOf(first), 1);

    installEchoExecutor(dbPath);
    const second = await boot(dbPath);
    const done = await second.waitForStatus(job.id, 'finished');
    expect(done.spec.executor).toBe('later');
    expect(done.result).toEqual({ echoed: 'ping', machine: 'local' }); // the executor is told its lane's machine
  });
});

describe('GET /api/plugins: the executor role', () => {
  it('the instances the plugins config names, detection per plugin and per instance', async () => {
    const a = await boot(newDb());
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.roles).toEqual(['router', 'queue-sorter', 'escalation-level', 'executor', 'job-source', 'machine-source', 'usage-source', 'notifier']);
    expect(body.executors).toEqual({
      instances: [{ instance: { name: 'test', plugin: 'test', options: {} }, detection: { status: 'available' }, active: 'test' }],
    });
    const byId = new Map(body.plugins.map((p: { id: string }) => [p.id, p]));
    expect(byId.get('herdr-claude')).toMatchObject({ role: 'executor', builtin: true, detection: { status: expect.any(String) } });
    expect(byId.get('test')).toMatchObject({ role: 'executor', builtin: true, detection: { status: 'available' } });
  });

  it('command-bearing options are marked in the options schema', async () => {
    const a = await boot(newDb());
    const byId = new Map((await a.api('GET', '/api/plugins')).body.plugins.map((p: { id: string }) => [p.id, p]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON
    const marked = (id: string) => Object.entries((byId.get(id) as any).options.properties as Record<string, { commandBearing?: boolean }>)
      .filter(([, s]) => s.commandBearing === true).map(([k]) => k).sort();
    expect(marked('herdr-claude')).toEqual(['args', 'bin', 'claudeBin', 'yolo']);
    expect(marked('test')).toEqual([]);
    expect(marked('claude-cli')).toEqual(['bin', 'sshBin']);
    expect(marked('anthropic-api')).toEqual(['apiKeyEnv', 'baseUrl']);
    expect(marked('gate-router')).toEqual(['jevPath', 'python']);
    expect(marked('github-account')).toEqual([]);
    expect(marked('github-app')).toEqual(['apiUrl', 'appId', 'privateKeyEnv', 'slug']);
    expect(marked('local')).toEqual(['workTree']);
  });

  it('an executor added to the plugins config runs without a restart (issue #142)', async () => {
    const dbPath = newDb();
    writePlugins(dbPath, { version: 1, executors: [{ name: 'test', plugin: 'test' }] });
    const a = await boot(dbPath);
    writePlugins(dbPath, { version: 1, executors: [{ name: 'test', plugin: 'test' }, { name: 't2', plugin: 'test' }] });
    await waitFor(async () => ((await a.api('GET', '/api/health')).body.executors as string[]).includes('t2'), { what: 't2 running' });
    const report = (await a.api('GET', '/api/plugins')).body;
    expect(report.executors.pending).toBeUndefined();
    expect(report.executors.instances.map((i: { instance: { name: string } }) => i.instance.name)).toEqual(['test', 't2']);
  });
});
