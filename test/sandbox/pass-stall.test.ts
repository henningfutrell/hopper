// Issue #1965: one guard held the sweep, the read-only check pass and the warm pass together. A tools image build of the
// warm pass can take up to 30 min (BUILD_MS), and while one was in flight every 10 s tick joined it: a check that
// `hopper template check` queued did not run, and nothing in the log said why. Now each pass has its own guard, and a
// tick that finds a pass still in flight PASS_STALL_MS after it started logs that once.
//
// Feature: the sandbox module's passes do not wait for each other
//   Scenario: a check queued while a tools image build hangs runs at the next tick
//   Scenario: a pass in flight for PASS_STALL_MS is logged once, at a tick
import { describe, expect, it } from 'vitest';
import type { SandboxRepository } from '../../src/domain/store.ts';
import type { Template } from '../../src/domain/vault.ts';
import type { CheckTemplates } from '../../src/sandbox/check.ts';
import { probeCatalog } from '../../src/sandbox/probes.ts';
import { createSandboxes, PASS_STALL_MS } from '../../src/sandbox/service.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';

const T0 = Date.parse('2026-10-18T20:20:00Z');
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const approval = { image: IMAGE, secrets: [], by: 'a person', at: new Date(T0 - 60_000).toISOString() };
/** Approved, with tools, no check due: the warm pass builds its tools image. */
const tooled: Template = { name: 'deploy', image: IMAGE, tools: ['kubectl'], secrets: [], savedBy: 'a person', savedAt: new Date(T0 - 120_000).toISOString(), approval: { ...approval, tools: ['kubectl'] } };
/** Read-only, approved, with no check: due for its read-only check. */
const asked: Template = {
  name: 'asked-3f433ea5329c', image: IMAGE, secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }],
  readOnly: true, savedBy: 'job 1', savedAt: new Date(T0 - 120_000).toISOString(), approval,
};

function setup() {
  let now = T0;
  const runtime = createFakeContainerRuntime();
  // The build of the tools image with kubectl never ends, as a build that hangs on a download.
  const build = runtime.build!.bind(runtime);
  runtime.build = (tag, containerfile) => (containerfile.includes('kubectl') ? new Promise<void>(() => {}) : build(tag, containerfile));
  const templates: Template[] = [tooled];
  const recorded: { name: string; state: string }[] = [];
  const warnings: string[] = [];
  const checks: CheckTemplates = {
    templates: () => templates.map((template) => ({ userId: 'u', template })),
    record: async (_u, name, check) => { recorded.push({ name, state: check.state }); },
    credential: async () => ({ minted: { kind: 'kube', token: 't', expirationTimestamp: '2030-01-01T00:00:00Z' }, reach: { kind: 'kube', server: 'https://k' } }),
    report: async () => undefined,
  };
  const sandboxes = createSandboxes({
    runtime, repo: { list: () => [], remove: () => false } as Pick<SandboxRepository, 'list' | 'remove'>, runs: memorySandboxRuns(),
    instanceId: 'i-1965', network: 'host', clock: { now: () => new Date(now) }, logger: { info() {}, warn: (l) => warnings.push(l) }, checks,
    probes: probeCatalog([{ id: 'own.read', title: 'kubectl is there', kinds: ['cluster'], tool: 'kubectl', expect: 'allowed', script: 'true' }]),
  });
  return { sandboxes, templates, recorded, warnings, at: (ms: number) => { now = T0 + ms; } };
}

/** Lets the passes go on until they wait on something that does not end. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('the sandbox module\'s passes do not wait for each other (issue #1965)', () => {
  it('a check queued while a tools image build hangs runs at the next tick', async () => {
    const s = setup();
    void s.sandboxes.check();
    await settle();
    s.templates.push(asked);
    s.at(10_000);
    void s.sandboxes.check();
    await settle();
    // It ran and ended: what its probes found is not this test's.
    expect(s.recorded.map((r) => r.name)).toEqual(['asked-3f433ea5329c', 'asked-3f433ea5329c']);
    expect(s.recorded.map((r) => r.state)).toEqual(['running', expect.stringMatching(/^(passed|failed)$/)]);
  });

  it('a pass in flight for PASS_STALL_MS is logged once, at a tick', async () => {
    const s = setup();
    void s.sandboxes.check();
    await settle();
    s.at(PASS_STALL_MS - 1);
    void s.sandboxes.check();
    expect(s.warnings).toEqual([]);
    s.at(PASS_STALL_MS);
    void s.sandboxes.check();
    s.at(PASS_STALL_MS + 10_000);
    void s.sandboxes.check();
    expect(s.warnings).toEqual([expect.stringMatching(/the warm pass has run for 5 min and has not ended/)]);
  });
});
