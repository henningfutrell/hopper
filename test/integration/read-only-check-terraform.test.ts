// Issue #715, part 2, through the real composition root and the real HTTP server, as test/integration/read-only-check.test.ts
// runs the read-only check: a terraform workspace is minted no credential of its own. Its probes run with the AWS read
// session of the template's one aws-role read need — the role its provider and its state backend are read with —, which
// Access allowed and the deny policy keeps read-only. The fake terraform answers only with that session, as the real
// one's AWS provider does.
//
// Feature: a terraform workspace in the read-only check
//   Scenario: a terraform workspace's probes run with the AWS read session of the template's aws-role read need
//   Scenario: a terraform workspace with no one aws-role read need beside it fails the check, saying so, and runs no check box
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultView } from '../../src/domain/types.ts';
import { ACCOUNT, asked, boot, runningJob, skill, stopAll } from '../support/read-only-check.ts';

afterEach(stopAll);

describe('a terraform workspace in the read-only check (issue #715)', () => {
  it('a terraform workspace\'s probes run with the AWS read session of the template\'s aws-role read need', async () => {
    const { a, token, runtime, cloud, sts } = await boot(['terraform-workspace/*', `aws-role/${ACCOUNT}/*`]);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--needs', `read/terraform-workspace/shop-prod read/aws-role/${ACCOUNT}/readonly`]);
    await a.app.sandboxes.check();
    const t = await asked(a, token);
    expect(t.check, JSON.stringify(t.check)).toMatchObject({ state: 'passed' });
    // One read session, minted for the role, after Access allowed it; the workspace takes that one.
    expect(sts.seen).toHaveLength(1);
    expect(decodeURIComponent(sts.seen[0]!.body)).toContain(`RoleArn=arn:aws:iam::${ACCOUNT}:role/readonly`);
    expect((await a.events()).filter((e) => e.type === 'vault.check_minted').map((e) => (e.data as { asset: unknown }).asset)).toEqual([{ kind: 'aws-role', name: `${ACCOUNT}/readonly` }]);
    const probes = t.check!.probes.filter((p) => p.asset === 'shop-prod');
    expect(probes.map((p) => [p.id, p.outcome])).toEqual(expect.arrayContaining([
      ['terraform.plan', 'allowed'], ['terraform.apply', 'denied'], ['terraform.apply-direct', 'denied'], ['terraform.destroy-direct', 'denied'], ['terraform.state-rm', 'denied'], ['terraform.destroy', 'denied'],
    ]));
    // apply past the wrapper reached the real binary with the session, and the account refused it.
    expect(probes.find((p) => p.id === 'terraform.apply-direct')!.output).toContain('AccessDenied');
    expect(cloud.calls().filter((c) => c.startsWith('terraform apply'))).toHaveLength(1);
    expect(runtime.ran.size).toBe(1);
  });

  it('a terraform workspace with no one aws-role read need beside it fails the check, saying so, and runs no check box', async () => {
    const { a, token, runtime, sts } = await boot(['terraform-workspace/*', `aws-role/${ACCOUNT}/*`]);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--needs', 'read/terraform-workspace/shop-prod']);
    await a.app.sandboxes.check();
    const alone = await asked(a, token);
    expect(alone.check).toMatchObject({ state: 'failed', probes: [] });
    expect(alone.check!.problem).toBe('the check box gets no credential for read on terraform-workspace shop-prod: '
      + 'a terraform workspace is read with the AWS read session of the template\'s aws-role read need, and the template has none: ask for read on the aws-role its provider and state are read with');

    await skill(a, creds, ['sandbox-template', '--needs', `read/terraform-workspace/shop-prod read/aws-role/${ACCOUNT}/one read/aws-role/${ACCOUNT}/two`]);
    await a.app.sandboxes.check();
    const two = (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body.templates.find((x) => x.name !== alone.name && x.name.startsWith('asked-'))!;
    expect(two.check).toMatchObject({ state: 'failed', probes: [] });
    expect(two.check!.problem).toBe('the check box gets no credential for read on terraform-workspace shop-prod: '
      + `a terraform workspace is read with the AWS read session of the template's aws-role read need, and the template has 2 (${ACCOUNT}/one, ${ACCOUNT}/two): ask for one`);
    expect(runtime.ran.size).toBe(0);
    expect(sts.seen).toHaveLength(2);
  });
});
