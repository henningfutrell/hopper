// Issue #672: the check on every pull request, `pr / test`, so yolo mode has a passing check to merge on
// (issue #652: no checks is not passing). Read-only and with no secrets, so a fork's pull request is safe:
// `pull_request`, never `pull_request_target`. Tests that need a host service the runner does not give
// (their own containers, sshd, LDAP) are left out by HOPPER_TEST_HOST_SERVICES=0 (test/support/host-services.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CONTAINER_TESTS, containerRuntime, HOST_SERVICE_TESTS, testExclude } from '../support/host-services.ts';

const ROOT = join(import.meta.dirname, '..', '..');

type Step = { id?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { needs?: string[]; if?: string; 'timeout-minutes'?: number; strategy?: { 'fail-fast'?: boolean; matrix: { shard: number[] } }; steps: Step[] };
type Workflow = {
  name: string;
  on: Record<string, { branches?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const workflow = parse(readFileSync(join(ROOT, '.github', 'workflows', 'pr.yml'), 'utf8')) as Workflow;

describe('.github/workflows/pr.yml, the pull request check', () => {
  it('runs on pull requests to main, dev, beta and stable, never as pull_request_target', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request']);
    expect(workflow.on.pull_request?.branches).toEqual(['main', 'dev', 'beta', 'stable']);
  });

  it('reads the repository only, and names no secret', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(readFileSync(join(ROOT, '.github', 'workflows', 'pr.yml'), 'utf8')).not.toMatch(/secrets\./);
  });

  it('is the check `pr / test`: it waits on the gates and the tests of its base, and passes only when each passed', () => {
    expect(workflow.name).toBe('pr');
    const test = workflow.jobs.test!;
    expect(test.needs).toEqual(['gates', 'affected', 'shard']);
    // Run even when a needed job failed: a skipped check would count as passing.
    expect(test.if).toBe('always()');
    expect(test.steps.map((s) => s.run)).toEqual(['test "$GATES" = success\nif [ "$BASE" = main ]; then test "$AFFECTED" = success; else test "$SHARDS" = success; fi\n']);
    expect(test.steps[0]!.env).toEqual({
      BASE: '${{ github.base_ref }}', GATES: '${{ needs.gates.result }}', AFFECTED: '${{ needs.affected.result }}', SHARDS: '${{ needs.shard.result }}',
    });
    for (const job of Object.values(workflow.jobs)) expect(job['timeout-minutes']).toBeLessThanOrEqual(10);
  });

  // Issue #1073: a pull request into main, the landing branch, runs only the tests its change affects; every
  // other base (a batch run into dev, a promotion) the full suite in shards.
  it('into main, only the affected tests; into any other base, the full suite', () => {
    const affected = workflow.jobs.affected!;
    expect(affected.if).toBe("github.base_ref == 'main'");
    expect(workflow.jobs.shard!.if).toBe("github.base_ref != 'main'");
    expect(affected.steps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with).toEqual({ 'fetch-depth': 2 });
    // Issue #1104: a change to a module most of the daemon imports affects most of the suite, which on one runner
    // passed the 10-minute limit. The affected tests run in the same shards as the full suite; a shard with none passes.
    expect(affected.strategy).toEqual({ 'fail-fast': false, matrix: { shard: workflow.jobs.shard!.strategy!.matrix.shard } });
    const test = affected.steps.find((s) => s.run?.startsWith('npx vitest'));
    const shards = affected.strategy!.matrix.shard.length;
    expect(test?.run).toBe(`npx vitest run --changed HEAD^1 --shard=\${{ matrix.shard }}/${shards} --passWithNoTests --maxWorkers=100%`);
    expect(test?.env).toEqual({ HOPPER_TEST_HOST_SERVICES: '0' });
    // What's new is checked where a change lands: on main.
    expect(workflow.jobs.gates!.steps.find((s) => s.run?.startsWith('node scripts/whats-new.ts'))?.if).toBe("github.base_ref == 'main'");
  });

  it('runs every gate with the npm cache, and the tests in shards without host services', () => {
    for (const name of ['gates', 'affected', 'shard']) {
      const node = workflow.jobs[name]!.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
      expect(node?.with, name).toMatchObject({ 'node-version': 24, cache: 'npm' });
    }
    const runs = workflow.jobs.gates!.steps.map((s) => s.run).filter(Boolean);
    expect(runs).toEqual(['npm ci', 'node scripts/whats-new.ts check HEAD^1', 'npm run typecheck', 'npm run lint', 'npm run build:ui']);
    // What's new is checked against the base (issue #824): the checkout is the merge, so HEAD^1 must be fetched.
    expect(workflow.jobs.gates!.steps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with).toEqual({ 'fetch-depth': 2 });
    const shard = workflow.jobs.shard!;
    const shards = shard.strategy!.matrix.shard;
    expect(shards).toEqual(shards.map((_, i) => i + 1));
    const test = shard.steps.find((s) => s.run?.startsWith('npm test'));
    // One worker per core (issue #949), not vitest's default of one less.
    expect(test?.run).toBe(`npm test -- --shard=\${{ matrix.shard }}/${shards.length} --maxWorkers=100%`);
    expect(test?.env).toEqual({ HOPPER_TEST_HOST_SERVICES: '0' });
  });

  // Issue #949: node_modules comes from the cache of its package-lock.json; `npm ci` runs only when there is none.
  it('takes node_modules from the cache of package-lock.json, and installs only on a miss', () => {
    for (const name of ['gates', 'affected', 'shard']) {
      const steps = workflow.jobs[name]!.steps;
      const cache = steps.find((s) => s.uses?.startsWith('actions/cache@'));
      expect(cache, name).toMatchObject({ id: 'deps', with: { path: 'node_modules' } });
      expect(String(cache!.with!.key), name).toContain("hashFiles('package-lock.json')");
      const install = steps.find((s) => s.run === 'npm ci');
      expect(install?.if, name).toBe("steps.deps.outputs.cache-hit != 'true'");
      expect(steps.indexOf(cache!), name).toBeLessThan(steps.indexOf(install!));
    }
  });
});

describe('the tests that need host services', () => {
  it('names only test files that exist', () => {
    for (const file of [...HOST_SERVICE_TESTS, ...CONTAINER_TESTS]) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });

  it('are left out only when HOPPER_TEST_HOST_SERVICES is 0', () => {
    expect(testExclude({})).not.toContain(HOST_SERVICE_TESTS[0]);
    expect(testExclude({ HOPPER_TEST_HOST_SERVICES: '1' })).not.toContain(HOST_SERVICE_TESTS[0]);
    expect(testExclude({ HOPPER_TEST_HOST_SERVICES: '0' })).toEqual(expect.arrayContaining([...HOST_SERVICE_TESTS]));
  });

  // Issue #1038: a machine with no docker or podman socket skips the tests that start containers, and says why.
  it('with no container runtime, leave out every test that starts a container, and say why', () => {
    const said: string[] = [];
    const excluded = testExclude({}, { runtime: false, say: (line) => said.push(line) });
    expect(excluded).toEqual(expect.arrayContaining([...HOST_SERVICE_TESTS, ...CONTAINER_TESTS]));
    expect(said.join('\n')).toMatch(/no docker or podman socket/);
    expect(said.join('\n')).toContain(CONTAINER_TESTS[0]);
    expect(testExclude({}, { runtime: true, say: (line) => said.push(line) })).not.toContain(CONTAINER_TESTS[0]);
  });
});

describe('the container runtime the tests reach (issue #1038)', () => {
  const at = (...usable: string[]) => ({ uid: 1000, home: '/h', exists: (p: string) => usable.includes(p), usable: (p: string) => usable.includes(p) });

  it('trusts DOCKER_HOST and a testcontainers config when one is set, and changes nothing', () => {
    const env: Record<string, string | undefined> = { DOCKER_HOST: 'tcp://127.0.0.1:2375' };
    expect(containerRuntime(env, at())).toBe(true);
    expect(env.DOCKER_HOST).toBe('tcp://127.0.0.1:2375');
    expect(containerRuntime({}, { ...at(), exists: (p) => p === '/h/.testcontainers.properties' })).toBe(true);
  });

  it('leaves the docker socket testcontainers finds itself when it is usable', () => {
    const env: Record<string, string | undefined> = { XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(containerRuntime(env, at('/var/run/docker.sock', '/run/user/1000/podman/podman.sock'))).toBe(true);
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  it('names podman\'s rootless socket as DOCKER_HOST when no docker socket is usable', () => {
    const env: Record<string, string | undefined> = { XDG_RUNTIME_DIR: '/run/user/1000' };
    const machine = { ...at('/run/user/1000/podman/podman.sock'), exists: (p: string) => p === '/var/run/docker.sock' || p === '/run/user/1000/podman/podman.sock' };
    expect(containerRuntime(env, machine)).toBe(true);
    expect(env.DOCKER_HOST).toBe('unix:///run/user/1000/podman/podman.sock');
  });

  it('is none with no usable socket', () => {
    const env: Record<string, string | undefined> = { XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(containerRuntime(env, { ...at(), exists: (p) => p === '/var/run/docker.sock' })).toBe(false);
    expect(env.DOCKER_HOST).toBeUndefined();
  });
});
