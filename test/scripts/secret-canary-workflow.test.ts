// Issue #1957: the nightly run of the secret canary scan's e2e mode (test/crash/secret-canary-real-runtime.test.ts).
// Nightly, by hand, and on a pull request that changes the sandbox module, the vault or the canary tests, the runner's
// own rootless Podman serves its API on a socket, HOPPER_TEST_PODMAN_SOCKET names it, and every `secret-canary*` test
// file runs, so the e2e test does not skip. Read-only and with no secrets: `pull_request`, never `pull_request_target`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { API } from '../../src/sandbox/podman.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FILE = join(ROOT, '.github', 'workflows', 'secret-canary.yml');

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string> };
type Job = { 'runs-on': string; 'timeout-minutes'?: number; steps: Step[] };
type Workflow = {
  name: string;
  on: { schedule?: { cron: string }[]; workflow_dispatch?: null; pull_request?: { branches: string[]; paths: string[] } };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const text = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
const workflow = (text ? parse(text) : { on: {}, jobs: {} }) as Workflow;
const scan = (): string => workflow.jobs.canary?.steps.find((s) => s.run?.includes('npx vitest run'))?.run ?? '';

/** The `secret-canary*` test files under `dir`, as paths from the repository root. */
const canaryFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).filter((f) => f.startsWith('secret-canary') && f.endsWith('.test.ts')).map((f) => `${dir}/${f}`);

describe('.github/workflows/secret-canary.yml, the nightly secret canary scan', () => {
  it('runs nightly, by hand, and on a pull request that changes the sandbox module, the vault or the canary tests', () => {
    expect(workflow.name).toBe('secret-canary');
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on.pull_request?.branches).toEqual(['main', 'dev', 'beta', 'stable']);
    expect(workflow.on.pull_request?.paths).toEqual(expect.arrayContaining([
      'src/sandbox/**', 'src/vault/**', 'test/crash/secret-canary-*.test.ts', 'test/crash/need-world.ts',
      'test/integration/secret-canary*.test.ts', 'test/support/secret-canary.ts', 'test/support/runtime-places.ts',
      '.github/workflows/secret-canary.yml',
    ]));
  });

  it('reads the repository only, and names no secret', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(/secrets\./);
    expect(workflow.jobs.canary?.['timeout-minutes']).toBeLessThanOrEqual(45);
  });

  it('starts the runner\'s rootless Podman on a socket, waits for its API, and names it to the tests', () => {
    const run = scan();
    expect(run).toMatch(/podman system service --time=0 "unix:\/\/\$sock" &/);
    expect(run).toContain(`${API}/_ping`);
    expect(run).toContain('HOPPER_TEST_PODMAN_SOCKET="unix://$sock" npx vitest run');
  });

  it('runs every secret canary test file, the e2e mode with them', () => {
    const run = scan();
    expect(run).toContain('test/crash/secret-canary-*.test.ts');
    expect(run).toContain('test/integration/secret-canary*.test.ts');
    const files = [...canaryFiles('test/crash'), ...canaryFiles('test/integration')];
    expect(files).toContain('test/crash/secret-canary-real-runtime.test.ts');
    for (const f of files) expect(f, f).toMatch(/^test\/(crash\/secret-canary-|integration\/secret-canary)[^/]*\.test\.ts$/);
  });
});
