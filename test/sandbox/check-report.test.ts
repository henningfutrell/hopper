// Issue #715: the read-only check's result is a job artifact. Each check that ends (passed or failed) becomes a report: an
// HTML page that shows each probe, what it expected and what it did. The check pass gives it to `CheckTemplates.report`,
// which keeps it as an artifact of the job that asked for the template, and the check names that artifact. A report that
// cannot be kept never changes the check: the check is kept, with no artifact, and the log says why.
//
// Feature: the read-only check's report
//   Scenario: the report shows each probe, escapes what a probe wrote, and draws a summary
//   Scenario: the check pass keeps each ended check's report and names its artifact on the check
//   Scenario: a report that cannot be kept leaves the check as it is
import { afterEach, describe, expect, it } from 'vitest';
import { visualWarning } from '../../src/domain/artifacts.ts';
import type { ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import type { Template } from '../../src/domain/vault.ts';
import { createCheckPass, type CheckTemplates } from '../../src/sandbox/check.ts';
import { checkReport } from '../../src/sandbox/check-report.ts';
import { HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createFakeCloudTools, type FakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const fakes: FakeCloudTools[] = [];
afterEach(() => { for (const f of fakes.splice(0)) f.cleanup(); });

const T0 = Date.parse('2030-01-01T00:00:00Z');
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const template: Template = {
  name: 'asked-0123456789ab', image: IMAGE, secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }],
  readOnly: true, askedBy: 'job-1', savedBy: 'job job-1', savedAt: new Date(T0 - 1000).toISOString(),
  approval: { image: IMAGE, secrets: [], by: 'the read policy', at: new Date(T0).toISOString() },
};

describe('the read-only check\'s report (issue #715)', () => {
  it('the report shows each probe, escapes what a probe wrote, and draws a summary', () => {
    const check: ReadOnlyCheck = {
      version: template.savedAt, state: 'failed', at: new Date(T0).toISOString(), problem: 'the check box ended with 1',
      probes: [
        { id: 'kube.get', asset: 'lab', expect: 'allowed', outcome: 'allowed', passed: true, exit: 0, output: 'NAME STATUS' },
        { id: 'kube.create-namespace', asset: 'lab', expect: 'denied', outcome: 'allowed', passed: false, exit: 0, output: 'namespace/<script>alert(1)</script> created' },
      ],
    };
    const r = checkReport(template, check);
    expect(r.name).toBe('read-only-check-asked-0123456789ab.html');
    expect(r.title).toBe('Read-only check: asked-0123456789ab');
    expect(r.summary).toBe('failed: 1 of 2 probes failed (kube.create-namespace on lab (allowed)); the check box ended with 1');
    expect(r.note).toBe('failed, 2030-01-01T00:00:00.000Z');
    const html = r.content.toString('utf8');
    for (const words of ['kube.get', 'kube.create-namespace', 'allowed', 'denied', 'the check box ended with 1', template.savedAt]) expect(html).toContain(words);
    expect(html).toContain('namespace/&lt;script&gt;alert(1)&lt;/script&gt; created');
    expect(html).not.toContain('<script>');
    expect(visualWarning('html', r.content)).toBeUndefined();

    const passed = checkReport(template, { ...check, state: 'passed', probes: [check.probes[0]!], problem: undefined as never });
    expect(passed.summary).toBe('passed: 1 probe, every write refused, every read worked');
  });

  function setup(report: CheckTemplates['report']) {
    const cloud = createFakeCloudTools('read-only');
    fakes.push(cloud);
    const runtime = createFakeContainerRuntime();
    runtime.runScript = cloud.runScript;
    let t = template;
    const recorded: ReadOnlyCheck[] = [];
    const warned: string[] = [];
    const pass = createCheckPass({
      runtime, instanceId: 'i', network: 'n', probes: HOPPER_PROBES, clock: { now: () => new Date(T0) }, logger: { info: () => {}, warn: (l) => { warned.push(l); } },
      credentials: { credential: async () => ({ minted: { kind: 'kube', token: 't', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://k' } }) },
    }, {
      templates: () => [{ userId: 'u', template: t }],
      record: async (_u, _n, check) => { recorded.push(check); t = { ...t, check }; },
      credential: async () => ({ refused: 'unused' }),
      report,
    });
    return { pass, recorded, warned };
  }

  it('the check pass keeps each ended check\'s report and names its artifact on the check', async () => {
    const reports: { userId: string; template: string; state: string }[] = [];
    const s = setup(async (userId, t, check) => { reports.push({ userId, template: t.name, state: check.state }); return 'artifact-1'; });
    await s.pass();
    expect(reports).toEqual([{ userId: 'u', template: template.name, state: 'passed' }]);
    expect(s.recorded.map((c) => [c.state, c.artifact])).toEqual([['running', undefined], ['passed', 'artifact-1']]);
  });

  it('a report that cannot be kept leaves the check as it is', async () => {
    const s = setup(async () => { throw new Error('the user\'s artifacts are full'); });
    await s.pass();
    expect(s.recorded.map((c) => [c.state, c.artifact])).toEqual([['running', undefined], ['passed', undefined]]);
    expect(s.warned).toEqual([`hopper: the read-only check of template ${template.name} passed, but its report was not kept: the user's artifacts are full`]);

    const none = setup(async () => undefined);
    await none.pass();
    expect(none.recorded.at(-1)).toMatchObject({ state: 'passed' });
    expect(none.recorded.at(-1)!.artifact).toBeUndefined();
  });
});
