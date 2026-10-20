// Issue #715, part 2, through the real composition root and the real HTTP server, as test/integration/read-only-check.test.ts
// runs the read-only check: a terraform workspace is minted no credential of its own. Its probes run with the AWS read
// session of the template's one aws-role read need — the role its provider and its state backend are read with —, which
// Access allowed and the deny policy keeps read-only. The fake terraform answers only with that session, as the real
// one's AWS provider does.
//
// Feature: a terraform workspace in the read-only check
//   Scenario: a terraform workspace's probes run with the AWS read session of the template's aws-role read need
//   Scenario: a terraform workspace with no one aws-role read need beside it fails the check: its probes are not run, saying
//     so, and the aws-role needs' probes still run (issue #873)
//   Scenario: a workspace need with no state backend fails the check: the state push past the wrapper is not run (part 6)
//   Scenario: a person sets the workspace's state backend; the state push to the check's own key is refused by the account
//   Scenario: a state backend the hopper cannot use is refused when the template is saved
import { afterEach, describe, expect, it } from 'vitest';
import type { TemplateView, VaultView } from '../../src/domain/types.ts';
import { ACCOUNT, asked, boot, runningJob, skill, stopAll, vault } from '../support/read-only-check.ts';

const save = (t: TemplateView, profiles: unknown[]) => ({ action: 'save-template', name: t.name, image: t.image, secrets: t.secrets, profiles, tools: t.tools });

afterEach(stopAll);

describe('a terraform workspace in the read-only check (issue #715)', () => {
  it('a terraform workspace\'s probes run with the AWS read session of the template\'s aws-role read need', async () => {
    const { a, token, runtime, cloud, sts } = await boot(['terraform-workspace/*', `aws-role/${ACCOUNT}/*`]);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', `read/terraform-workspace/shop-prod read/aws-role/${ACCOUNT}/readonly`]);
    await a.app.sandboxes.check();
    const unset = await asked(a, token);
    // Issue #715, part 6: with no state backend on the workspace need, the state push past the wrapper is unproven, not passed.
    expect(unset.check).toMatchObject({ state: 'failed' });
    expect(unset.check!.probes.filter((p) => !p.passed).map((p) => [p.id, p.outcome])).toEqual([['terraform.state-push-direct', 'not-run']]);
    expect(unset.check!.probes.find((p) => p.id === 'terraform.state-push-direct')!.output).toMatch(/^not run: no backend configured/);
    expect(cloud.calls().filter((c) => c.startsWith('terraform state'))).toEqual([]);

    // A person sets the workspace's state backend: a new version of the template, checked again.
    const backend = { bucket: 'shop-state', region: 'eu-west-1', keyPrefix: 'env/prod' };
    const profiles = unset.profiles.map((p) => (p.asset.kind === 'terraform-workspace' ? { ...p, backend } : p));
    expect((await vault(a, token, save(unset, profiles))).status).toBe(200);
    const saved = await asked(a, token);
    expect(saved.profiles.find((p) => p.asset.kind === 'terraform-workspace')).toEqual({ operation: 'read', asset: { kind: 'terraform-workspace', name: 'shop-prod' }, backend });
    // The read policy's approval stands: a backend changes no profile, so nothing waits for a person.
    expect(saved.pending).toEqual({ secrets: [], image: false, egress: [], bastionTargets: [], profiles: [] });
    await a.app.sandboxes.check();
    const t = await asked(a, token);
    expect(t.check, JSON.stringify(t.check)).toMatchObject({ state: 'passed' });
    // Past the wrapper, the state push to the check's own key reached the account with the session, and was refused.
    expect(t.check!.probes.find((p) => p.id === 'terraform.state-push-direct')).toMatchObject({ outcome: 'denied', passed: true });
    expect(cloud.calls()).toContain('terraform init -input=false -no-color -reconfigure -backend-config=bucket=shop-state -backend-config=key=env/prod/hopper-read-only-check/terraform.tfstate -backend-config=region=eu-west-1');
    // One read session per check, minted for the role, after Access allowed it; the workspace takes that one.
    expect(sts.seen).toHaveLength(2);
    expect(decodeURIComponent(sts.seen[0]!.body)).toContain(`RoleArn=arn:aws:iam::${ACCOUNT}:role/readonly`);
    expect((await a.events()).filter((e) => e.type === 'vault.check_minted').map((e) => (e.data as { asset: unknown }).asset)).toEqual([1, 2].map(() => ({ kind: 'aws-role', name: `${ACCOUNT}/readonly` })));
    const probes = t.check!.probes.filter((p) => p.asset === 'shop-prod');
    expect(probes.map((p) => [p.id, p.outcome])).toEqual(expect.arrayContaining([
      ['terraform.plan', 'allowed'], ['terraform.apply', 'denied'], ['terraform.apply-direct', 'denied'], ['terraform.destroy-direct', 'denied'], ['terraform.state-rm', 'denied'], ['terraform.destroy', 'denied'],
    ]));
    // apply past the wrapper reached the real binary with the session, and the account refused it.
    expect(probes.find((p) => p.id === 'terraform.apply-direct')!.output).toContain('AccessDenied');
    expect(cloud.calls().filter((c) => c.startsWith('terraform apply'))).toHaveLength(2);
    expect(runtime.ran.size).toBe(2);
  });

  it('a state backend the hopper cannot use is refused when the template is saved', async () => {
    const { a, token } = await boot(['terraform-workspace/*', `aws-role/${ACCOUNT}/*`]);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', `read/terraform-workspace/shop-prod read/aws-role/${ACCOUNT}/readonly`]);
    const t = await asked(a, token);
    const withBackend = (kind: string, backend: unknown) => t.profiles.map((p) => (p.asset.kind === kind ? { ...p, backend } : p));
    const refused = async (profiles: unknown[]) => { const r = await vault(a, token, save(t, profiles)); expect(r.status).toBe(400); return r.body.error; };
    expect(await refused(withBackend('terraform-workspace', { bucket: 'Shop_State', region: 'eu-west-1' }))).toContain('bucket');
    expect(await refused(withBackend('terraform-workspace', { bucket: 'shop-state', region: 'Europe' }))).toContain('region');
    expect(await refused(withBackend('terraform-workspace', { bucket: 'shop-state', region: 'eu-west-1', keyPrefix: '/env/$(id)' }))).toContain('key prefix');
    expect(await refused(withBackend('aws-role', { bucket: 'shop-state', region: 'eu-west-1' }))).toContain('only a terraform-workspace need has a state backend');
    expect((await asked(a, token)).savedAt).toBe(t.savedAt);
  });

  it('a terraform workspace with no one aws-role read need beside it fails the check: its probes are not run, saying so, and the aws-role needs\' probes still run (issue #873)', async () => {
    const { a, token, runtime, sts } = await boot(['terraform-workspace/*', `aws-role/${ACCOUNT}/*`]);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/terraform-workspace/shop-prod']);
    await a.app.sandboxes.check();
    const alone = await asked(a, token);
    expect(alone.check).toMatchObject({ state: 'failed' });
    expect(alone.check!.problem).toBeUndefined();
    const notRun = (t: TemplateView, why: string): void => {
      const workspace = t.check!.probes.filter((p) => p.asset === 'shop-prod');
      expect(workspace.length).toBeGreaterThan(0);
      for (const p of workspace) expect(p).toMatchObject({ outcome: 'not-run', passed: false, output: `not run: the check box gets no credential for read on terraform-workspace shop-prod: ${why}` });
    };
    notRun(alone, 'a terraform workspace is read with the AWS read session of the template\'s aws-role read need, and the template has none: ask for read on the aws-role its provider and state are read with');
    // No probe of it can run: no check box.
    expect(runtime.ran.size).toBe(0);

    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', `read/terraform-workspace/shop-prod read/aws-role/${ACCOUNT}/one read/aws-role/${ACCOUNT}/two`]);
    await a.app.sandboxes.check();
    const two = (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body.templates.find((x) => x.name !== alone.name && x.name.startsWith('asked-'))!;
    expect(two.check).toMatchObject({ state: 'failed' });
    notRun(two, `a terraform workspace is read with the AWS read session of the template's aws-role read need, and the template has 2 (${ACCOUNT}/one, ${ACCOUNT}/two): ask for one`);
    // The probes of the two aws-roles ran in a check box, each with its own read session.
    const roles = two.check!.probes.filter((p) => p.asset !== 'shop-prod');
    expect(new Set(roles.map((p) => p.asset))).toEqual(new Set([`${ACCOUNT}/one`, `${ACCOUNT}/two`]));
    expect(roles.every((p) => p.passed), JSON.stringify(roles)).toBe(true);
    expect(runtime.ran.size).toBe(1);
    expect(sts.seen).toHaveLength(2);
  });
});
