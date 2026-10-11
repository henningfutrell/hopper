// The read-only check's script and its reading (issue #716, item 4), run by a real `sh` with fake aws, kubectl, helm and
// terraform (test/support/fake-cloud-tools.ts) that answer as the real tools do under a read-only or a writable credential.
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile, Probe } from '../../src/domain/types.ts';
import { checkEnv, checkScript, readResults } from '../../src/sandbox/check-script.ts';
import { HOPPER_PROBES, PROBES, probeCatalog } from '../../src/sandbox/probes.ts';
import { createFakeCloudTools, type FakeCloudTools } from '../support/fake-cloud-tools.ts';

const tools: FakeCloudTools[] = [];
afterEach(() => { for (const t of tools.splice(0)) t.cleanup(); });

const read = (kind: OperationProfile['asset']['kind'], name: string): OperationProfile => ({ operation: 'read', asset: { kind, name } });
const EVERY_KIND = [read('aws-account', '123456789012'), read('aws-role', '123456789012/hopper-read'), read('cluster', 'lab'), read('namespace', 'lab/shop'), read('argocd-app', 'shop'), read('terraform-workspace', 'shop-prod')];

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
    expect(writes.filter((r) => r.passed)).toEqual([]);
    // A dry run that would work, and a delete of nothing, fail in their own words: an error, not a refusal.
    expect(results.find((r) => r.id === 'aws.ec2-create-tags')).toMatchObject({ outcome: 'error', passed: false });
    expect(results.find((r) => r.id === 'kube.delete-pod')).toMatchObject({ outcome: 'error', passed: false });
    expect(results.find((r) => r.id === 'aws.iam-create-user')).toMatchObject({ outcome: 'allowed', passed: false });
    expect(fake.calls()).toEqual(expect.arrayContaining(['aws iam delete-user --user-name hopper-read-only-check', 'aws ssm delete-parameter --name /hopper/read-only-check']));
    expect(fake.calls().filter((c) => c.startsWith('terraform destroy')).length).toBe(2);
  });

  it('terraform is probed on PATH and as the real binary, past any wrapper', async () => {
    const { results, fake } = await run('read-only', [read('terraform-workspace', 'shop-prod')]);
    expect(results.map((r) => r.id)).toEqual(['terraform.plan', 'terraform.apply', 'terraform.apply-direct']);
    expect(results.every((r) => r.passed)).toBe(true);
    expect(fake.calls().filter((c) => c.startsWith('terraform apply')).length).toBe(2);
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
      script: 'printf "%s|%s|%s|%s|%s|" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN" "$AWS_REGION" "$AWS_ENDPOINT_URL_STS"; [ -n "$KUBECONFIG" ] && cat "$KUBECONFIG"; printf "|%s" "$(env | grep -c HOPPER_CHECK_)"',
    };
    const runs = probeCatalog([show]).runsFor([read('aws-role', '1/a'), read('aws-role', '1/b'), read('cluster', 'lab'), read('aws-role', '1/none')]);
    const credentials = [
      { asset: { kind: 'aws-role' as const, name: '1/a' }, env: { AWS_ACCESS_KEY_ID: 'ka', AWS_SECRET_ACCESS_KEY: "s'a", AWS_SESSION_TOKEN: 'ta', AWS_REGION: 'eu-west-1', AWS_ENDPOINT_URL_STS: 'http://sts' } },
      { asset: { kind: 'aws-role' as const, name: '1/b' }, env: { AWS_ACCESS_KEY_ID: 'kb', AWS_SECRET_ACCESS_KEY: 'sb', AWS_SESSION_TOKEN: 'tb' } },
      { asset: { kind: 'cluster' as const, name: 'lab' }, env: {}, kubeconfig: '{"users":[{"user":{"token":"kube-token"}}]}' },
    ];
    const script = checkScript(runs, credentials);
    const env = checkEnv(credentials);
    // The credentials are in the box's environment, never in its script.
    for (const secret of ['ka', "s'a", 'ta', 'kb', 'tb', 'kube-token']) expect(script).not.toContain(secret);
    expect(Object.values(env)).toEqual(expect.arrayContaining(['ka', "s'a", 'kube-token']));
    const r = await fake.runScript({ name: 'c', image: 'i', network: 'n', volume: 'v', env, labels: {}, limits: { cpus: 1, memoryMb: 1 }, user: 'agent', script });
    expect(r.exit).toBe(0);
    expect(readResults(runs, r.output).map((x) => [x.asset, x.output])).toEqual([
      ['1/a', "ka|s'a|ta|eu-west-1|http://sts||0"],
      ['1/b', 'kb|sb|tb|||0'],
      ['lab', '|||||{"users":[{"user":{"token":"kube-token"}}]}|0'],
      ['1/none', '||||||0'],
    ]);
  });
});
