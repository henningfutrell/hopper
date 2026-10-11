// The read-only check's script and its reading (issue #716, item 4), run by a real `sh` with fake aws, kubectl, helm and
// terraform (test/support/fake-cloud-tools.ts) that answer as the real tools do under a read-only or a writable credential.
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckCredential, OperationProfile, Probe } from '../../src/domain/types.ts';
import { checkEnv, checkScript, readResults } from '../../src/sandbox/check-script.ts';
import { HOPPER_PROBES, PROBES, probeCatalog } from '../../src/sandbox/probes.ts';
import { createFakeCloudTools, type FakeCloudTools } from '../support/fake-cloud-tools.ts';

const tools: FakeCloudTools[] = [];
afterEach(() => { for (const t of tools.splice(0)) t.cleanup(); });

const read = (kind: OperationProfile['asset']['kind'], name: string): OperationProfile => ({ operation: 'read', asset: { kind, name } });
/** A terraform workspace need with its state backend (issue #715): the bucket its state is in, under `env/prod`. */
const WORKSPACE: OperationProfile = { ...read('terraform-workspace', 'shop-prod'), backend: { bucket: 'shop-state', region: 'eu-west-1', keyPrefix: 'env/prod' } };
const PROBE_KEY = 'env/prod/hopper-read-only-check/terraform.tfstate';
const EVERY_KIND = [read('aws-account', '123456789012'), read('aws-role', '123456789012/hopper-read'), read('cluster', 'lab'), read('namespace', 'lab/shop'), read('argocd-app', 'shop'), WORKSPACE];

async function run(mode: 'read-only' | 'writable', needs: OperationProfile[]) {
  const fake = createFakeCloudTools(mode);
  tools.push(fake);
  const runs = HOPPER_PROBES.runsFor(needs);
  const script = checkScript(runs);
  const r = await fake.runScript({ name: 'c', image: 'i', network: 'n', volume: 'v', env: {}, labels: {}, limits: { cpus: 1, memoryMb: 1 }, user: 'agent', script });
  return { runs, results: readResults(runs, r.output), fake, exit: r.exit };
}

describe('the read-only check script (issue #716)', () => {
  it('under a read-only credential every write is refused and every read works: every probe passes', async () => {
    const { runs, results, exit } = await run('read-only', EVERY_KIND);
    expect(exit).toBe(0);
    expect(results.length).toBe(runs.length);
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results.find((r) => r.id === 'aws.iam-create-user')).toMatchObject({ outcome: 'denied', expect: 'denied', exit: 254 });
    expect(results.find((r) => r.id === 'aws.iam-create-user')!.output).toContain('AccessDenied');
    expect(results.find((r) => r.id === 'kube.get')).toMatchObject({ outcome: 'allowed', exit: 0 });
    // Each kind gets its own probes, each asset once.
    expect(new Set(results.map((r) => r.asset))).toEqual(new Set(EVERY_KIND.map((n) => n.asset.name)));
  });

  it('under a writable credential every write fails the check, and a write that went through is undone', async () => {
    const { results, fake } = await run('writable', EVERY_KIND);
    const writes = results.filter((r) => r.expect === 'denied');
    expect(writes.length).toBeGreaterThan(0);
    // Every write that reaches the account goes through. Only the terraform wrapper (issue #715) still refuses its own,
    // and the provider mirror still has no provider it does not hold: neither asks the account.
    const ownRefusal = (r: { id: string; output: string }): boolean => r.output.includes('refused by the read-only wrapper') || (r.id === 'terraform.provider-download' && r.output.includes('not found in any of the search locations'));
    expect(writes.filter((r) => r.passed).every((r) => r.id.startsWith('terraform.') && !r.id.endsWith('-direct') && ownRefusal(r))).toBe(true);
    expect(results.find((r) => r.id === 'terraform.apply-direct')).toMatchObject({ outcome: 'allowed', passed: false });
    expect(results.find((r) => r.id === 'terraform.destroy-direct')).toMatchObject({ outcome: 'allowed', passed: false });
    // The state push to the probe key went through: it fails, and the cleanup deletes that key, and only that key (issue #715).
    expect(results.find((r) => r.id === 'terraform.state-push-direct')).toMatchObject({ outcome: 'allowed', passed: false });
    expect(fake.calls().filter((c) => c.startsWith('aws s3api'))).toEqual([`aws s3api delete-object --bucket shop-state --key ${PROBE_KEY}`]);
    // A dry run that would work, and a delete of nothing, fail in their own words: an error, not a refusal.
    expect(results.find((r) => r.id === 'aws.ec2-create-tags')).toMatchObject({ outcome: 'error', passed: false });
    expect(results.find((r) => r.id === 'kube.delete-pod')).toMatchObject({ outcome: 'error', passed: false });
    expect(results.find((r) => r.id === 'aws.iam-create-user')).toMatchObject({ outcome: 'allowed', passed: false });
    expect(fake.calls()).toEqual(expect.arrayContaining(['aws iam delete-user --user-name hopper-read-only-check', 'aws ssm delete-parameter --name /hopper/read-only-check']));
    // Past the wrapper, apply went through and is undone, and destroy of the parameter held in state went through.
    expect(fake.calls().filter((c) => c.startsWith('terraform destroy') && !c.includes('-refresh=false')).length).toBe(1);
    expect(fake.calls().filter((c) => c.startsWith('terraform destroy') && c.includes('-refresh=false')).length).toBe(1);
  });

  it('terraform is probed on PATH and as the real binary, past any wrapper', async () => {
    const { results, fake } = await run('read-only', [WORKSPACE]);
    expect(results.map((r) => r.id)).toEqual([
      'terraform.plan', 'terraform.apply', 'terraform.apply-direct', 'terraform.destroy-direct', 'terraform.state-push-direct', 'terraform.destroy', 'terraform.import', 'terraform.state-rm',
      'terraform.state-mv', 'terraform.state-push', 'terraform.taint', 'terraform.force-unlock', 'terraform.workspace-new', 'terraform.workspace-delete',
      'terraform.provider-download',
    ]);
    expect(results.every((r) => r.passed)).toBe(true);
    // The wrapper refused apply on PATH; only the real binary, called past it, reached the account and was refused there.
    expect(fake.calls().filter((c) => c.startsWith('terraform apply')).length).toBe(1);
    expect(results.find((r) => r.id === 'terraform.apply')!.output).toContain('refused by the read-only wrapper');
    expect(results.find((r) => r.id === 'terraform.apply-direct')!.output).toContain('AccessDenied');
    // destroy past the wrapper, of a parameter its state holds, with no refresh: the account refused the delete (issue #715).
    expect(results.find((r) => r.id === 'terraform.destroy-direct')!.output).toContain('ssm:DeleteParameter');
    // The wrapper's refusals never ran the real binary: the one destroy is the one past it.
    expect(fake.calls().filter((c) => /^terraform (destroy|import|state|taint|force-unlock|workspace)/.test(c))).toEqual([
      'terraform destroy -auto-approve -input=false -lock=false -refresh=false -no-color',
      'terraform state push -lock=false probe.tfstate',
    ]);
    // The state push past the wrapper (issue #715): the workspace's bucket, at the check's own key, refused by the account.
    expect(results.find((r) => r.id === 'terraform.state-push-direct')).toMatchObject({ outcome: 'denied', passed: true });
    expect(results.find((r) => r.id === 'terraform.state-push-direct')!.output).toMatch(/PutObject[\s\S]*AccessDenied/);
    expect(fake.calls()).toContain(`terraform init -input=false -no-color -reconfigure -backend-config=bucket=shop-state -backend-config=key=${PROBE_KEY} -backend-config=region=eu-west-1`);
    // Never the workspace's own state: each backend key the check names is the probe key.
    const keys = fake.calls().flatMap((c) => [...c.matchAll(/-backend-config=key=(\S+)/g)].map((m) => m[1]));
    expect(keys).toEqual([PROBE_KEY]);
    expect(results.find((r) => r.id === 'terraform.state-rm')).toMatchObject({ outcome: 'denied', expect: 'denied' });
    // A provider the image's mirror does not hold is not downloaded: init finds it nowhere (issue #715).
    expect(results.find((r) => r.id === 'terraform.provider-download')).toMatchObject({ outcome: 'denied', passed: true });
    expect(results.find((r) => r.id === 'terraform.provider-download')!.output).toContain('hashicorp/null was not found in any of the search locations');
  });

  it('a workspace need with no state backend: the state push past the wrapper is not run, and it does not pass (issue #715)', async () => {
    const { results, fake } = await run('read-only', [read('terraform-workspace', 'shop-prod')]);
    expect(results.find((r) => r.id === 'terraform.state-push-direct')).toEqual({
      id: 'terraform.state-push-direct', asset: 'shop-prod', expect: 'denied', outcome: 'not-run', passed: false,
      output: 'not run: no backend configured. A person sets the state backend of terraform-workspace shop-prod (its bucket, region and key prefix) in Settings → Vault',
    });
    // The other probes run as before; nothing asked the account to push a state.
    expect(results.filter((r) => r.id !== 'terraform.state-push-direct').every((r) => r.passed)).toBe(true);
    expect(fake.calls().filter((c) => c.startsWith('terraform state') || c.includes('-backend-config'))).toEqual([]);
  });

  it('a workspace need with no key prefix: the probe key is at the bucket\'s top, under hopper-read-only-check/ (issue #715)', async () => {
    const { results, fake } = await run('read-only', [{ ...read('terraform-workspace', 'shop-prod'), backend: { bucket: 'shop-state', region: 'eu-west-1' } }]);
    expect(results.find((r) => r.id === 'terraform.state-push-direct')).toMatchObject({ outcome: 'denied', passed: true });
    expect(fake.calls().flatMap((c) => [...c.matchAll(/-backend-config=key=(\S+)/g)].map((m) => m[1]))).toEqual(['hopper-read-only-check/terraform.tfstate']);
  });

  it('with no wrapper on PATH, the wrapper\'s probes fail: that layer is missing (issue #715)', async () => {
    const fake = createFakeCloudTools('read-only', undefined, { wrapper: false });
    tools.push(fake);
    const runs = HOPPER_PROBES.runsFor([WORKSPACE]);
    const r = await fake.runScript({ name: 'c', image: 'i', network: 'n', volume: 'v', env: {}, labels: {}, limits: { cpus: 1, memoryMb: 1 }, user: 'agent', script: checkScript(runs) });
    const results = readResults(runs, r.output);
    expect(results.find((x) => x.id === 'terraform.destroy')).toMatchObject({ outcome: 'allowed', passed: false });
    expect(results.find((x) => x.id === 'terraform.state-rm')).toMatchObject({ outcome: 'allowed', passed: false });
    // With no mirror config, init downloads any provider from the registry.
    expect(results.find((x) => x.id === 'terraform.provider-download')).toMatchObject({ outcome: 'allowed', passed: false });
    // The account still refuses apply: the IAM layer holds alone.
    expect(results.find((x) => x.id === 'terraform.apply')).toMatchObject({ outcome: 'denied', passed: true });
    expect(results.find((x) => x.id === 'terraform.apply-direct')).toMatchObject({ outcome: 'denied', passed: true });
    expect(results.find((x) => x.id === 'terraform.destroy-direct')).toMatchObject({ outcome: 'denied', passed: true });
    expect(results.find((x) => x.id === 'terraform.state-push-direct')).toMatchObject({ outcome: 'denied', passed: true });
  });

  it('a probe with no line did not run; a failure that is not a refusal is an error', () => {
    const runs = probeCatalog(PROBES).runsFor([read('cluster', 'lab')]);
    const b64 = (s: string): string => Buffer.from(s).toString('base64');
    const results = readResults(runs, `noise\r\nHOPPER-PROBE 0 0 ${b64('NAME')}\r\nHOPPER-PROBE 1 1 ${b64('Unable to connect to the server: dial tcp: lookup lab')}\r\n`);
    expect(results[0]).toMatchObject({ id: 'kube.get', outcome: 'allowed', passed: true });
    expect(results[1]).toMatchObject({ id: 'kube.create-namespace', outcome: 'error', passed: false, exit: 1 });
    expect(results[2]).toMatchObject({ outcome: 'error', passed: false, output: 'it did not run' });
    expect(results[2]!.exit).toBeUndefined();
  });

  it('a catalog of its own replaces the hopper\'s: an asset name is quoted, and a snippet cannot end its here-document', async () => {
    const probe: Probe = { id: 'own.echo', title: 'say the asset', kinds: ['cluster'], tool: 'kubectl', expect: 'allowed', script: 'echo "asset=$ASSET"\n: HOPPER_PROBE_0' };
    const runs = probeCatalog([probe]).runsFor([read('cluster', "it's"), read('cluster', "it's")]);
    expect(runs.length).toBe(1);
    const fake = createFakeCloudTools();
    tools.push(fake);
    const r = await fake.runScript({ name: 'c', image: 'i', network: 'n', volume: 'v', env: {}, labels: {}, limits: { cpus: 1, memoryMb: 1 }, user: 'agent', script: checkScript(runs) });
    expect(readResults(runs, r.output)).toMatchObject([{ id: 'own.echo', asset: "it's", outcome: 'allowed', passed: true, output: "asset=it's" }]);
  });

  it('each probe runs with the credential minted for its own asset, and no other (issue #797)', async () => {
    const fake = createFakeCloudTools('read-only');
    tools.push(fake);
    const show: Probe = {
      id: 'show', title: 'show the credential', kinds: ['aws-role', 'cluster'], tool: 'aws', expect: 'allowed',
      script: 'printf "%s|%s|%s|%s|%s|" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN" "$AWS_REGION" "$AWS_ENDPOINT_URL_STS"; [ -n "$KUBECONFIG" ] && cat "$KUBECONFIG"; printf "|%s" "$(env | grep -c "^HOPPER_CHECK_[0-9]")"',
    };
    const runs = probeCatalog([show]).runsFor([read('aws-role', '1/a'), read('aws-role', '1/b'), read('cluster', 'lab'), read('aws-role', '1/none')]);
    const credentials: CheckCredential[] = [
      { asset: { kind: 'aws-role', name: '1/a' }, env: { AWS_ACCESS_KEY_ID: 'key-a1', AWS_SECRET_ACCESS_KEY: "sec'a1", AWS_SESSION_TOKEN: 'tok-a1', AWS_REGION: 'eu-west-1', AWS_ENDPOINT_URL_STS: 'http://sts' } },
      { asset: { kind: 'aws-role', name: '1/b' }, env: { AWS_ACCESS_KEY_ID: 'key-b2', AWS_SECRET_ACCESS_KEY: 'sec-b2', AWS_SESSION_TOKEN: 'tok-b2' } },
      { asset: { kind: 'cluster', name: 'lab' }, env: {}, kubeconfig: '{"users":[{"user":{"token":"kube-token"}}]}' },
    ];
    const script = checkScript(runs, credentials);
    const env = checkEnv(credentials);
    // The credentials are in the box's environment, never in its script.
    for (const secret of ['key-a1', "sec'a1", 'tok-a1', 'key-b2', 'tok-b2', 'kube-token']) expect(script).not.toContain(secret);
    expect(Object.values(env)).toEqual(expect.arrayContaining(['key-a1', "sec'a1", credentials[2]!.kubeconfig]));
    const r = await fake.runScript({ name: 'c', image: 'i', network: 'n', volume: 'v', env, labels: {}, limits: { cpus: 1, memoryMb: 1 }, user: 'agent', script });
    expect(r.exit).toBe(0);
    expect(readResults(runs, r.output).map((x) => [x.asset, x.output])).toEqual([
      ['1/a', "key-a1|sec'a1|tok-a1|eu-west-1|http://sts||0"],
      ['1/b', 'key-b2|sec-b2|tok-b2||||0'],
      ['lab', '|||||{"users":[{"user":{"token":"kube-token"}}]}|0'],
      ['1/none', '||||||0'],
    ]);
  });
});
