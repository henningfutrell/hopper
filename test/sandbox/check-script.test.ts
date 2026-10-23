// The read-only check's script and its reading (issue #716, item 4), run by a real `sh` with fake aws, kubectl, helm and
// terraform (test/support/fake-cloud-tools.ts) that answer as the real tools do under a read-only or a writable credential.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckCredential, OperationProfile, Probe } from '../../src/domain/types.ts';
import { markRuns, type ProbeMarks } from '../../src/domain/read-only-check.ts';
import { checkEnv, checkScript, judge, readResults } from '../../src/sandbox/check-script.ts';
import { HELM_LIST_NOTE, HOPPER_PROBES, PROBES, probeCatalog } from '../../src/sandbox/probes.ts';
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
    // the provider mirror still has no provider it does not hold, and the egress (issue #849) still reaches no host off
    // the allowlist: none of them asks the account.
    const ownRefusal = (r: { id: string; output: string }): boolean => r.output.includes('refused by the read-only wrapper') || (r.id === 'terraform.provider-download' && r.output.includes('not found in any of the search locations'));
    expect(writes.filter((r) => r.passed && !r.id.startsWith('egress.')).every((r) => r.id.startsWith('terraform.') && !r.id.endsWith('-direct') && ownRefusal(r))).toBe(true);
    expect(writes.filter((r) => r.id.startsWith('egress.')).map((r) => [r.id, r.outcome])).toEqual([['egress.aws', 'denied'], ['egress.kube', 'denied']]);
    expect(results.find((r) => r.id === 'terraform.apply-direct')).toMatchObject({ outcome: 'allowed', passed: false });
    expect(results.find((r) => r.id === 'terraform.destroy-direct')).toMatchObject({ outcome: 'allowed', passed: false });
    // The state push to the probe key went through: it fails, and the cleanup deletes that key, and only that key (issue #715).
    expect(results.find((r) => r.id === 'terraform.state-push-direct')).toMatchObject({ outcome: 'allowed', passed: false });
    expect(fake.calls().filter((c) => c.startsWith('aws s3api'))).toEqual([`aws s3api delete-object --bucket shop-state --key ${PROBE_KEY} --region eu-west-1`]);
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
      'terraform.provider-download', 'egress.aws',
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
    expect(results.find((r) => r.id === 'terraform.provider-download')!.output).toContain('hashicorp/dns was not found in any of the search locations');
  });

  it('a workspace need with no state backend: the state push past the wrapper is not run, and it does not pass (issue #715)', async () => {
    const { results, fake } = await run('read-only', [read('terraform-workspace', 'shop-prod')]);
    expect(results.find((r) => r.id === 'terraform.state-push-direct')).toEqual({
      id: 'terraform.state-push-direct', asset: 'shop-prod', expect: 'denied', outcome: 'not-run', passed: false,
      output: 'not run: no backend configured. A person sets the state backend of terraform-workspace shop-prod (its bucket, region and key prefix) in Vault',
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

  it('a provider download the egress filtered is a refusal; a registry out of reach for another reason is an error (issue #2107)', () => {
    const runs = probeCatalog(PROBES).runsFor([read('terraform-workspace', 'shop-prod')]).filter((r) => r.probe.id === 'terraform.provider-download');
    const b64 = (s: string): string => Buffer.from(s).toString('base64');
    const init = (cause: string): string => `Error: Failed to query available provider packages\n\nCould not retrieve the list of available versions for provider hashicorp/dns: could not connect to registry.terraform.io: failed to request discovery document: Get "https://registry.terraform.io/.well-known/terraform.json": ${cause}`;
    expect(readResults(runs, `HOPPER-PROBE 0 1 ${b64(init('Filtered'))}\n`)[0]).toMatchObject({ outcome: 'denied', passed: true });
    expect(readResults(runs, `HOPPER-PROBE 0 1 ${b64(init('dial tcp: lookup registry.terraform.io: no such host'))}\n`)[0]).toMatchObject({ outcome: 'error', passed: false });
  });

  it('a provider download refused is a refusal when terraform wraps its error at 78 columns (issue #2564)', () => {
    const runs = probeCatalog(PROBES).runsFor([read('terraform-workspace', 'shop-prod')]).filter((r) => r.probe.id === 'terraform.provider-download');
    const b64 = (s: string): string => Buffer.from(s).toString('base64');
    // As terraform prints it off a terminal: the mirror does not hold the provider, and no registry is in reach.
    const mirror = 'Error: Failed to query available provider packages\n\nCould not retrieve the list of available versions for provider\nhashicorp/dns: provider registry.terraform.io/hashicorp/dns was not found in\nany of the search locations\n\n- /opt/hopper-tools/providers\n';
    expect(readResults(runs, `HOPPER-PROBE 0 1 ${b64(mirror)}\n`)[0]).toMatchObject({ outcome: 'denied', passed: true });
    const filtered = 'Error: Failed to query available provider packages\n\nCould not retrieve the list of available versions for provider\nhashicorp/dns: could not connect to registry.terraform.io: failed to request\ndiscovery document: Get "https://registry.terraform.io/.well-known/terraform.json":\nFiltered\n';
    expect(readResults(runs, `HOPPER-PROBE 0 1 ${b64(filtered)}\n`)[0]).toMatchObject({ outcome: 'denied', passed: true });
    // A Filtered in another paragraph is not the registry's answer.
    const elsewhere = 'Error: could not connect to registry.terraform.io: no such host\n\nFiltered\n';
    expect(readResults(runs, `HOPPER-PROBE 0 1 ${b64(elsewhere)}\n`)[0]).toMatchObject({ outcome: 'error', passed: false });
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

// Issue #869: a write probe never passes falsely, and a read probe that a right credential can fail says why.
describe('the read-only check on a cluster view role (issue #869)', () => {
  const CLUSTER = [read('cluster', 'lab')];
  /** Runs the hopper's probes for `needs`, with `tool` replaced by a script of its own. */
  async function runWith(tool: string, body: string, needs: OperationProfile[] = CLUSTER) {
    const fake = createFakeCloudTools('read-only');
    tools.push(fake);
    writeFileSync(join(fake.dir, tool), `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(join(fake.dir, 'calls.log'))}\n${body}\n`);
    const runs = HOPPER_PROBES.runsFor(needs);
    const r = await fake.runScript({ name: 'c', image: 'i', network: 'n', volume: 'v', env: {}, labels: {}, limits: { cpus: 1, memoryMb: 1 }, user: 'agent', script: checkScript(runs) });
    return { results: readResults(runs, r.output), fake };
  }

  it('helm install\'s own server dry run ends 0 on a view role; the probe asks the API to create the chart\'s objects, and the refusal passes it', async () => {
    const { results, fake } = await run('read-only', CLUSTER);
    expect(results.find((r) => r.id === 'helm.install')).toMatchObject({ outcome: 'denied', passed: true });
    expect(results.find((r) => r.id === 'helm.install')!.output).toContain('is forbidden');
    expect(fake.calls()).toEqual(expect.arrayContaining([
      'helm template hopper-read-only-check ./chart -n default',
      'kubectl create -n default --dry-run=server -f chart.yaml',
    ]));
    expect(fake.calls().filter((c) => c.startsWith('helm install'))).toEqual([]);
  });

  it('one object of the chart created and one refused: the write went through, and the probe fails', async () => {
    const { results } = await runWith('kubectl', `case "$1" in
  get) echo NAME ;;
  create) echo 'deployment.apps/hopper-read-only-check-chart created (server dry run)'; echo 'Error from server (Forbidden): services is forbidden' >&2; exit 1 ;;
  *) echo 'Error from server (Forbidden): is forbidden' >&2; exit 1 ;;
esac`);
    expect(results.find((r) => r.id === 'helm.install')).toMatchObject({ outcome: 'allowed', passed: false, exit: 0 });
  });

  it('the EC2 write is a dry run: an UnauthorizedOperation passes it, and nothing is written', async () => {
    const { results, fake } = await run('read-only', [read('aws-role', '123456789012/hopper-read')]);
    expect(results.find((r) => r.id === 'aws.ec2-create-tags')).toMatchObject({ outcome: 'denied', passed: true });
    expect(results.find((r) => r.id === 'aws.ec2-create-tags')!.output).toContain('UnauthorizedOperation');
    expect(fake.calls().filter((c) => c.startsWith('aws ec2'))).toEqual(['aws ec2 create-vpc --dry-run --cidr-block 10.255.0.0/16']);
  });

  // Issues #882, #1903: EC2 looks up each resource a write names before its dry run asks the authorization, so a VPC or
  // instance the account does not hold answers NotFound or InvalidID, never a refusal. The probe names no resource.
  it('the EC2 write names no resource: an account that holds none still gives its refusal', async () => {
    const { results, fake } = await runWith('aws', `case "$*" in
  *--resources*|*--instance-ids*) echo "An error occurred (InvalidID) when calling the CreateTags operation: The ID 'i-00000000000000000' is not valid" >&2; exit 254 ;;
  *"create-vpc --dry-run"*) echo 'An error occurred (UnauthorizedOperation) when calling the CreateVpc operation: You are not authorized to perform this operation.' >&2; exit 254 ;;
  *) exit 1 ;;
esac`, [read('aws-account', '123456789012')]);
    expect(results.find((r) => r.id === 'aws.ec2-create-tags')).toMatchObject({ outcome: 'denied', passed: true });
    expect(fake.calls().filter((c) => c.startsWith('aws ec2'))).toEqual(['aws ec2 create-vpc --dry-run --cidr-block 10.255.0.0/16']);
  });

  // Issue #1904: an EC2 refusal of a role ends with its encoded authorization failure message, a blob longer than the end
  // of the output the box sends. The words of the refusal come before it, so the box also sends the start.
  it('an EC2 refusal with a long encoded authorization failure message is a refusal: it passes (issue #1904)', async () => {
    const blob = 'Ab3_-x9'.repeat(400);
    const { results } = await runWith('aws', `case "$*" in
  *"create-vpc --dry-run"*) echo 'An error occurred (UnauthorizedOperation) when calling the CreateVpc operation: You are not authorized to perform this operation. User: arn:aws:sts::123456789012:assumed-role/hopper-read/hopper-read-only-check is not authorized to perform: ec2:CreateVpc on resource: arn:aws:ec2:eu-west-1:123456789012:vpc/* because no identity-based policy allows the ec2:CreateVpc action. Encoded authorization failure message: ${blob}' >&2; exit 254 ;;
  *) exit 1 ;;
esac`, [read('aws-role', '123456789012/hopper-read')]);
    expect(results.find((r) => r.id === 'aws.ec2-create-tags')).toMatchObject({ outcome: 'denied', passed: true, exit: 254 });
  });

  it('an output that is only an encoded authorization failure message is a refusal (issue #1904)', () => {
    const run = HOPPER_PROBES.runsFor([read('aws-role', '123456789012/hopper-read')]).find((r) => r.probe.id === 'aws.ec2-create-tags')!;
    expect(judge(run, 254, `Encoded authorization failure message: ${'Ab3_-x9'.repeat(100)}`)).toEqual({ outcome: 'denied', passed: true });
  });

  it('a long output with no refusal in it is still an error (issue #1904)', async () => {
    const { results } = await runWith('aws', `case "$*" in
  *"create-vpc --dry-run"*) echo "An error occurred (InvalidParameterValue) when calling the CreateVpc operation: $(printf 'x%.0s' $(seq 1 3000))" >&2; exit 254 ;;
  *) exit 1 ;;
esac`, [read('aws-role', '123456789012/hopper-read')]);
    expect(results.find((r) => r.id === 'aws.ec2-create-tags')).toMatchObject({ outcome: 'error', passed: false, exit: 254 });
  });

  // Issue #1736: a view role that is right refuses helm list on secrets. That refusal passes the probe, with no mark.
  const helm = (list: string): string => `case "$1" in
  list) ${list} ;;
  create) mkdir -p "$2" ;;
  template) echo 'kind: Deployment' ;;
esac`;
  it('helm list refused on secrets, as a view role refuses it: it passes, and its result says why (issue #1736)', async () => {
    const { results } = await runWith('helm', helm(`echo 'Error: list: failed to list: secrets is forbidden: User "system:serviceaccount:hopper:view" cannot list resource "secrets" in API group "" at the cluster scope' >&2; exit 1`));
    const list = results.find((r) => r.id === 'helm.list')!;
    expect(list).toMatchObject({ expect: 'allowed', outcome: 'denied', passed: true, note: HELM_LIST_NOTE });
    expect(HELM_LIST_NOTE).toContain('A view role cannot read secrets');
    expect(results.filter((r) => r.id.startsWith('helm.list') || r.id.startsWith('kube.')).filter((r) => !r.passed)).toEqual([]);
    // A probe that worked carries no note.
    const { results: ok } = await run('read-only', CLUSTER);
    expect(ok.find((r) => r.id === 'helm.list')).toMatchObject({ outcome: 'allowed', passed: true });
    expect(ok.find((r) => r.id === 'helm.list')!.note).toBeUndefined();
  });

  it('helm list refused on anything but secrets, or failing some other way: it fails (issue #1736)', async () => {
    const { results: other } = await runWith('helm', helm(`echo 'Error: list: failed to list: configmaps is forbidden: User "view" cannot list resource "configmaps"' >&2; exit 1`));
    expect(other.find((r) => r.id === 'helm.list')).toMatchObject({ outcome: 'denied', passed: false, note: HELM_LIST_NOTE });
    const { results: down } = await runWith('helm', helm(`echo 'Error: Kubernetes cluster unreachable: dial tcp: lookup lab' >&2; exit 1`));
    expect(down.find((r) => r.id === 'helm.list')).toMatchObject({ outcome: 'error', passed: false });
  });
});

describe('probe marks on a read probe (issue #916)', () => {
  const CLUSTER = [read('cluster', 'lab')];
  const FORBIDDEN = 'Error: list: failed to list: secrets is forbidden: User "system:serviceaccount:hopper:view" cannot list resource "secrets"';
  /** Runs the hopper's probes for a cluster with these marks; `list`: how helm list answers, else the fake's own. */
  async function runMarked(marks: ProbeMarks, mode: 'read-only' | 'writable' = 'read-only', list?: string) {
    const fake = createFakeCloudTools(mode);
    tools.push(fake);
    if (list !== undefined) {
      writeFileSync(join(fake.dir, 'helm'), `#!/bin/sh\necho "helm $*" >> ${JSON.stringify(join(fake.dir, 'calls.log'))}\ncase "$1" in
  list) ${list} ;;
  create) mkdir -p "$2" ;;
  template) printf '%s\\n' '---' 'apiVersion: apps/v1' 'kind: Deployment' 'metadata:' '  name: hopper-read-only-check-chart' ;;
esac\n`);
    }
    const runs = markRuns(HOPPER_PROBES.runsFor(CLUSTER), marks);
    const r = await fake.runScript({ name: 'c', image: 'i', network: 'n', volume: 'v', env: {}, labels: {}, limits: { cpus: 1, memoryMb: 1 }, user: 'agent', script: checkScript(runs) });
    return { results: readResults(runs, r.output), fake };
  }
  const forbidden = `echo '${FORBIDDEN}' >&2; exit 1`;

  it('helm list marked expect-denied and refused on a view role: it passes, and the whole set passes', async () => {
    const { results } = await runMarked({ 'helm.list': 'expect-denied' }, 'read-only', forbidden);
    expect(results.find((r) => r.id === 'helm.list')).toMatchObject({ expect: 'denied', mark: 'expect-denied', outcome: 'denied', passed: true });
    expect(results.find((r) => r.id === 'helm.list')!.note).toBeUndefined();
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });

  it('helm list marked expect-denied that works: the read was not refused, and it fails', async () => {
    const { results } = await runMarked({ 'helm.list': 'expect-denied' });
    expect(results.find((r) => r.id === 'helm.list')).toMatchObject({ expect: 'denied', outcome: 'allowed', passed: false, exit: 0 });
  });

  it('helm list marked expect-denied that fails for another reason: an error, and it fails', async () => {
    const { results } = await runMarked({ 'helm.list': 'expect-denied' }, 'read-only', "echo 'Error: Kubernetes cluster unreachable: dial tcp: lookup lab' >&2; exit 1");
    expect(results.find((r) => r.id === 'helm.list')).toMatchObject({ expect: 'denied', outcome: 'error', passed: false });
  });

  it('helm list marked skip is not run, and passes as skipped', async () => {
    const { results, fake } = await runMarked({ 'helm.list': 'skip' }, 'read-only', forbidden);
    expect(results.find((r) => r.id === 'helm.list')).toMatchObject({ mark: 'skip', outcome: 'skipped', passed: true, output: 'not run: the template marks it skip' });
    expect(results.find((r) => r.id === 'helm.list')!.exit).toBeUndefined();
    expect(fake.calls().filter((c) => c.startsWith('helm list'))).toEqual([]);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });

  it('with helm list marked, a write that goes through still fails the check', async () => {
    const { results } = await runMarked({ 'helm.list': 'expect-denied', 'helm.install': 'skip' }, 'writable', forbidden);
    expect(results.find((r) => r.id === 'helm.list')).toMatchObject({ passed: true });
    expect(results.find((r) => r.id === 'kube.create-namespace')).toMatchObject({ outcome: 'allowed', passed: false });
    // A mark on a write probe changes nothing: it runs, and the write that went through fails it.
    expect(results.find((r) => r.id === 'helm.install')).toMatchObject({ outcome: 'allowed', passed: false });
    expect(results.find((r) => r.id === 'helm.install')!.mark).toBeUndefined();
  });
});
