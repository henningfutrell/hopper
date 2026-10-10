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

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
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
    expect(runs).toEqual(['npm ci', 'npm run typecheck', 'npm run lint', 'npm run build:ui']);
    const shard = workflow.jobs.shard!;
    const shards = shard.strategy!.matrix.shard;
    expect(shards).toEqual(shards.map((_, i) => i + 1));
    const test = shard.steps.find((s) => s.run?.startsWith('npm test'));
    expect(test?.run).toBe(`npm test -- --shard=\${{ matrix.shard }}/${shards.length}`);
    expect(test?.env).toEqual({ HOPPER_TEST_HOST_SERVICES: '0' });
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
