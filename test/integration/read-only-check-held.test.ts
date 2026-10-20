// Issue #2236, through the real composition root and the real HTTP server: a read template the read policy approved got
// no read-only check for hours, as one check that did not end held the check pass. The container runtime is a double
// whose check box of the first template never ends until the test lets it (test/support/read-only-check.ts has the rest).
//
// Feature: an approved read template gets its check while another check does not end
//   Scenario: the read policy approves a template while another template's check hangs: its check runs at the next pass,
//     and the job's wait ends with the template ready
import { afterEach, describe, expect, it } from 'vitest';
import type { TemplateView, VaultView } from '../../src/domain/types.ts';
import type { TestApp } from '../support/app.ts';
import { ACCOUNT, boot, runningJob, skill, stepBox, stopAll, waiting } from '../support/read-only-check.ts';

afterEach(stopAll);

const templateFor = async (a: TestApp, token: string, kind: string): Promise<TemplateView | undefined> =>
  (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body.templates.find((t) => t.profiles.some((p) => p.asset.kind === kind));

describe('an approved read template gets its check while another check does not end (issue #2236)', () => {
  it('the read policy approves a template while another template\'s check hangs: its check runs at the next pass, and the job\'s wait ends', async () => {
    const { a, token, runtime, cloud } = await boot(['cluster/lab', `aws-role/${ACCOUNT}/*`]);
    // The check box of the cluster's template does not end until the test lets it.
    let letGo = (): void => {};
    const hung = new Promise<void>((resolve) => { letGo = resolve; });
    runtime.runScript = (spec) => (spec.script?.includes('kubectl') ? hung.then(() => cloud.runScript(spec)) : cloud.runScript(spec));

    try {
      const creds = await runningJob(a);
      expect((await skill(a, creds, ['sandbox-template', '--why', 'Read the lab', '--needs', 'read/cluster/lab'])).code).toBe(3);
      const first = a.app.sandboxes.check();
      const lab = await templateFor(a, token, 'cluster');
      await expect.poll(async () => (await templateFor(a, token, 'cluster'))?.check?.state).toBe('running');

      // Approved by the read policy while that check runs.
      const done = waiting(a, creds, ['sandbox-template', '--why', 'Read the role', '--needs', `read/aws-role/${ACCOUNT}/readonly`]);
      await done.opened;
      const role = await templateFor(a, token, 'aws-role');
      expect(role).toMatchObject({ readOnly: true, approval: { by: 'the read policy' } });

      // A check pass ends when every check that runs has: the job's wait ends before it.
      void a.app.sandboxes.check();
      const end = await done.end;
      expect(end.code, end.stdout + end.stderr).toBe(0);
      expect(end.stdout).toContain(`template ${role!.name} is ready`);
      expect((await templateFor(a, token, 'aws-role'))?.check).toMatchObject({ state: 'passed' });
      expect((await stepBox(a, token, role!.name)).status).toBe(200);
      // The first check still runs: it held only its own template.
      expect((await templateFor(a, token, 'cluster'))?.check?.state).toBe('running');
      expect((await stepBox(a, token, lab!.name)).body.error).toMatch(/: it runs now, since /);

      letGo();
      await first;
      expect((await templateFor(a, token, 'cluster'))?.check).toMatchObject({ state: 'passed' });
    } finally {
      // A hung check would hold the app's stop.
      letGo();
    }
  }, 30_000);
});
