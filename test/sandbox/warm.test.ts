// Issue #1737: the first need step of a template paid the build of its tools image (10 to 60 s), and a download that
// failed in that build failed the step. The warm pass builds the tools image of each approved template with tools ahead
// of its first step, where its steps run, so a step finds the image there. A template a read-only check is due for is
// left to the check, which builds the same image. A build that fails is logged, and the pass tries again later.
//
// Feature: the tools image built ahead of the first step
//   Scenario: an approved template with tools gets its tools image built once, and a need box after it builds none
//   Scenario: a template not approved, with no tools, or with a check due, is not warmed
//   Scenario: a build that fails is logged and tried again after WARM_RETRY_MS, not at each pass
//   Scenario: a warmed image is looked at again after WARM_EVERY_MS, so a removed one is built again
import { describe, expect, it } from 'vitest';
import type { Template } from '../../src/domain/vault.ts';
import { boxImage } from '../../src/sandbox/box-image.ts';
import { createWarmPass, WARM_EVERY_MS, WARM_RETRY_MS } from '../../src/sandbox/warm.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

const template = (over: Partial<Template> = {}): Template => ({
  name: 'deploy', image: IMAGE, tools: ['kubectl', 'helm'], secrets: [], savedBy: 'a person', savedAt: new Date(T0 - 1000).toISOString(),
  approval: { image: IMAGE, tools: ['kubectl', 'helm'], secrets: [], by: 'a person', at: new Date(T0).toISOString() }, ...over,
});

function setup(templates: Template[]) {
  let now = T0;
  const runtime = createFakeContainerRuntime();
  const warnings: string[] = [];
  const pass = createWarmPass({
    place: async () => ({ machine: 'local', runtime, network: 'n' }),
    templates: () => templates.map((t) => ({ userId: 'u', template: t })),
    clock: { now: () => new Date(now) }, logger: { info: () => {}, warn: (l) => warnings.push(l) },
  });
  return { pass, runtime, warnings, at: (ms: number) => { now = T0 + ms; } };
}

describe('the tools image built ahead of the first step (issue #1737)', () => {
  it('an approved template with tools gets its tools image built once, and a need box after it builds none', async () => {
    const t = template();
    const s = setup([t]);
    await s.pass();
    expect(s.runtime.builds).toBe(1);
    await s.pass();
    expect(s.runtime.builds).toBe(1);
    await boxImage(s.runtime, t.image, t.tools, t.readOnly);
    expect(s.runtime.builds).toBe(1);
  });

  it('a template not approved, with no tools, or with a check due, is not warmed', async () => {
    const { approval: _a, ...unapproved } = template();
    const s = setup([
      unapproved,
      template({ name: 'plain', tools: undefined, approval: { image: IMAGE, secrets: [], by: 'a person', at: new Date(T0).toISOString() } }),
      template({ name: 'asked', readOnly: true, profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }] }),
    ]);
    await s.pass();
    expect(s.runtime.builds).toBe(0);
  });

  it('a build that fails is logged and tried again after WARM_RETRY_MS, not at each pass', async () => {
    const s = setup([template()]);
    s.runtime.buildFails = 'curl: (6) Could not resolve host: get.helm.sh';
    await s.pass();
    expect(s.warnings).toEqual([expect.stringContaining('Could not resolve host')]);
    expect(s.warnings[0]).toContain('deploy');
    s.runtime.buildFails = undefined;
    s.at(WARM_RETRY_MS - 1);
    await s.pass();
    expect(s.runtime.builds).toBe(0);
    s.at(WARM_RETRY_MS);
    await s.pass();
    expect(s.runtime.builds).toBe(1);
  });

  it('a warmed image is looked at again after WARM_EVERY_MS, so a removed one is built again', async () => {
    const s = setup([template()]);
    await s.pass();
    s.runtime.images.clear();
    s.at(WARM_EVERY_MS - 1);
    await s.pass();
    expect(s.runtime.builds).toBe(1);
    s.at(WARM_EVERY_MS);
    await s.pass();
    expect(s.runtime.builds).toBe(2);
  });
});
