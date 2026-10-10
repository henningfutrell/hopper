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
type Workflow = {
  name: string;
  on: Record<string, { branches?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, { 'timeout-minutes'?: number; steps: Step[] }>;
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

  it('is the check `pr / test`, with a time limit', () => {
    expect(workflow.name).toBe('pr');
    expect(Object.keys(workflow.jobs)).toEqual(['test']);
    expect(workflow.jobs.test!['timeout-minutes']).toBeLessThanOrEqual(15);
  });

  it('installs with the npm cache, then runs every gate, the tests without host services', () => {
    const steps = workflow.jobs.test!.steps;
    const node = steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(node?.with).toMatchObject({ 'node-version': 24, cache: 'npm' });
    const runs = steps.map((s) => s.run).filter(Boolean);
    for (const gate of ['npm ci', 'npm run typecheck', 'npm run lint', 'npm run build:ui']) expect(runs).toContain(gate);
    const test = steps.find((s) => s.run?.startsWith('npm test'));
    expect(test?.env).toMatchObject({ HOPPER_TEST_HOST_SERVICES: '0' });
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
