// Issue #672: the check on every pull request, `pr / test`, so yolo mode has a passing check to merge on
// (issue #652: no checks is not passing). Read-only and with no secrets, so a fork's pull request is safe:
// `pull_request`, never `pull_request_target`. Tests that need a host service the runner does not give
// (their own containers, sshd, LDAP) are left out by HOPPER_TEST_HOST_SERVICES=0 (test/support/host-services.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { HOST_SERVICE_TESTS, testExclude } from '../support/host-services.ts';

const ROOT = join(import.meta.dirname, '..', '..');

type Step = { id?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { needs?: string[]; if?: string; 'timeout-minutes'?: number; strategy?: { matrix: { shard: number[] } }; steps: Step[] };
type Workflow = {
  name: string;
  on: Record<string, { branches?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const workflow = parse(readFileSync(join(ROOT, '.github', 'workflows', 'pr.yml'), 'utf8')) as Workflow;

describe('.github/workflows/pr.yml, the pull request check', () => {
  it('runs on pull requests to dev, beta and stable, never as pull_request_target', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request']);
    expect(workflow.on.pull_request?.branches).toEqual(['dev', 'beta', 'stable']);
  });

  it('reads the repository only, and names no secret', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(readFileSync(join(ROOT, '.github', 'workflows', 'pr.yml'), 'utf8')).not.toMatch(/secrets\./);
  });

  it('is the check `pr / test`: it waits on every gate and shard, and passes only when each passed', () => {
    expect(workflow.name).toBe('pr');
    const test = workflow.jobs.test!;
    expect(test.needs).toEqual(['gates', 'shard']);
    // Run even when a needed job failed: a skipped check would count as passing.
    expect(test.if).toBe('always()');
    expect(test.steps.map((s) => s.run)).toEqual(['test "$GATES" = success && test "$SHARDS" = success']);
    expect(test.steps[0]!.env).toEqual({ GATES: '${{ needs.gates.result }}', SHARDS: '${{ needs.shard.result }}' });
    for (const job of Object.values(workflow.jobs)) expect(job['timeout-minutes']).toBeLessThanOrEqual(10);
  });

  it('runs every gate with the npm cache, and the tests in shards without host services', () => {
    for (const name of ['gates', 'shard']) {
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
    // Two workers per core (issue #949): most of a test's time is a wait, not the CPU. vitest caps a percentage at the core count.
    expect(test?.run).toBe(`npm test -- --shard=\${{ matrix.shard }}/${shards.length} --maxWorkers=$(( $(nproc) * 2 ))`);
    expect(test?.env).toEqual({ HOPPER_TEST_HOST_SERVICES: '0' });
  });

  // Issue #949: node_modules comes from the cache of its package-lock.json; `npm ci` runs only when there is none.
  it('takes node_modules from the cache of package-lock.json, and installs only on a miss', () => {
    for (const name of ['gates', 'shard']) {
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
    for (const file of HOST_SERVICE_TESTS) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });

  it('are left out only when HOPPER_TEST_HOST_SERVICES is 0', () => {
    expect(testExclude({})).not.toContain(HOST_SERVICE_TESTS[0]);
    expect(testExclude({ HOPPER_TEST_HOST_SERVICES: '1' })).not.toContain(HOST_SERVICE_TESTS[0]);
    expect(testExclude({ HOPPER_TEST_HOST_SERVICES: '0' })).toEqual(expect.arrayContaining([...HOST_SERVICE_TESTS]));
  });
});
