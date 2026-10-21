// Issue #716, item 4, through the real composition root and the real HTTP server: a template a job asks for with read
// needs only takes a read-only check before its first box. The job runs the real `hopper-skill`. The container runtime is a
// double at its port (test/support/fake-container-runtime.ts) whose one-shot containers run the check's real script under
// `sh`, with fake aws, kubectl, helm and terraform (test/support/fake-cloud-tools.ts) that answer as under a read-only or a
// writable credential. OpenFGA is a double at the AuthorizationServer seam.
// Issue #797: the check box gets the read credentials its needs mint — an AWS read session, a Kubernetes token — from the
// real minting adapters against an STS and a Kubernetes API faked on loopback, after Access allowed the template each one.
// The fake tools answer only with those minted credentials, as the real ones do.
//
// Feature: the read-only check before a requested template's first box
//   Scenario: every write refused, every read works: the check passes and the template is ready
//     Given the read policy holds cluster/lab and aws-role/123456789012/*
//     And the vault holds a minting credential for cluster lab and one for aws-account 123456789012
//     When a job asks for read on cluster lab and aws-role 123456789012/readonly, with --wait
//     Then the template is approved by the read policy, and the job waits for its read-only check
//     And a step in a box of it is refused, saying the check has not run
//     When the check pass runs
//     Then a check box ran the template's image with its tools, under the sandbox flags, with the check label, and is gone
//     And Access allowed the template each read before the vault minted it for the check box
//     And the box ran its probes with the minted AWS session and Kubernetes token, never with a minting credential
//     And the check passed: the template holds it, `template.checked` says so, and the job's wait ends with the template ready
//     And a step may run in a box of it
//   Scenario: a write that goes through fails the check: the template takes no box until a person runs it again and it passes
//   Scenario: a save makes the check stale: it runs again on the template as it is now
//   Scenario: a template with a write need, and one a person saved, take no read-only check
//   Scenario: a check box that ends badly, or does not start, fails the check with the reason
//   Scenario: a check box no run holds (a hopper stopped mid-check) is removed, and its check runs again
//   Scenario: a need the vault cannot mint a credential for fails the check: its probes are not run, saying why, and the
//     other needs' probes still run (issue #873)
//   Scenario: a read Access does not allow fails the check: its probes are not run, saying so, and it mints nothing
//   Scenario: with the vault in a container of its own (issue #586), the check box gets its read credentials the same way
//   Scenario (issue #715): a terraform workspace's probes run with the AWS read session of the template's aws-role read need
//   Scenario (issue #715): a terraform workspace with no one aws-role read need beside it fails the check: its probes are
//     not run, saying so, and the aws-role needs' probes still run (issue #873)
//   Scenario (issues #916, #1736): helm list refused on secrets on a view role passes the check with no mark; a person can
//     still mark it expect-denied, a write that goes through still fails the check, and a write probe takes no mark
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessView } from '../../src/domain/types.ts';
import { CHECK_LABEL } from '../../src/sandbox/check.ts';
import { BOX_LABEL } from '../../src/sandbox/owned.ts';
import { TOOLS_IMAGE } from '../../src/sandbox/tools.ts';
import { MINTED_AWS, MINTED_KUBE_TOKEN } from '../support/fake-mint-apis.ts';
import { ACCOUNT, asked, AWS_MINTING_SECRET, boot, KUBE_MINTING_TOKEN, NEEDS, stepBox, runningJob, skill, stopAll, vault, waiting } from '../support/read-only-check.ts';

afterEach(stopAll);

describe('the read-only check before a requested template\'s first box (issue #716)', () => {
  it('every write refused, every read works: the check passes and the template is ready', async () => {
    const { a, token, runtime, cloud, kube, sts } = await boot(['cluster/lab', `aws-role/${ACCOUNT}/*`]);
    const creds = await runningJob(a);
    const done = waiting(a, creds, NEEDS);
    await done.opened;
    const t = await asked(a, token);
    expect(t).toMatchObject({ readOnly: true, approval: { by: 'the read policy' } });
    expect(t.check).toBeUndefined();
    const refused = await stepBox(a, token, t.name);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(`waiting for the read-only check of ${t.name}: it has not run on this version yet`);

    await a.app.sandboxes.check();
    const end = await done.end;
    expect(end.code, end.stdout + end.stderr).toBe(0);
    expect(end.stdout).toContain(`template ${t.name} is ready`);

    // One check box: the template's image with its tools, the sandbox flags' spec, its script, the check label; then gone.
    const [box] = [...runtime.ran.values()];
    expect(runtime.ran.size).toBe(1);
    expect(box!.image.startsWith(`${TOOLS_IMAGE}:`)).toBe(true);
    expect(runtime.images.get(box!.image)).toContain('io.hopper.tools="aws helm kubectl"');
    expect(box!.labels[CHECK_LABEL]).toBeDefined();
    expect(box!.labels[BOX_LABEL]).toBeUndefined();
    expect(box!.user).toBe('agent');
    expect(box!.script).toContain('kubectl create namespace hopper-read-only-check --dry-run=server');
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);

    // The vault minted a read session and a read token for the check box (issue #797), after Access allowed each.
    // The token is bound to a Secret of its own, which the end of the check box deletes (issue #1371).
    const secret = /^hopper-mint-[0-9a-f-]{36}$/;
    expect(kube.seen.map((r) => [r.method, r.url.replace(/hopper-mint-[0-9a-f-]{36}/, 'hopper-mint-<uuid>'), r.authorization])).toEqual([
      ['POST', '/api/v1/namespaces/hopper/secrets', `Bearer ${KUBE_MINTING_TOKEN}`],
      ['POST', '/api/v1/namespaces/hopper/serviceaccounts/hopper-read/token', `Bearer ${KUBE_MINTING_TOKEN}`],
      ['DELETE', '/api/v1/namespaces/hopper/secrets/hopper-mint-<uuid>', `Bearer ${KUBE_MINTING_TOKEN}`],
    ]);
    const made = (JSON.parse(kube.seen[0]!.body) as { metadata: { name: string } }).metadata.name;
    expect(made).toMatch(secret);
    expect(kube.seen[2]!.url).toBe(`/api/v1/namespaces/hopper/secrets/${made}`);
    expect(JSON.parse(kube.seen[1]!.body)).toMatchObject({ spec: { boundObjectRef: { kind: 'Secret', name: made } } });
    expect(sts.seen).toHaveLength(1);
    expect(decodeURIComponent(sts.seen[0]!.body)).toContain(`RoleArn=arn:aws:iam::${ACCOUNT}:role/readonly`);
    expect(decodeURIComponent(sts.seen[0]!.body)).toContain('RoleSessionName=hopper-read-only-check');
    expect(decodeURIComponent(sts.seen[0]!.body)).toContain('arn:aws:iam::aws:policy/ReadOnlyAccess');
    const minted = (await a.events()).filter((e) => e.type === 'vault.check_minted');
    expect(minted.map((e) => e.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'kube', operation: 'read', asset: { kind: 'cluster', name: 'lab' }, template: t.name, check: box!.name, credential: 'KUBE_LAB', decision: expect.any(String), expiresAt: '2030-01-01T00:10:00Z' }),
      expect.objectContaining({ kind: 'aws', operation: 'read', asset: { kind: 'aws-role', name: `${ACCOUNT}/readonly` }, template: t.name, check: box!.name, credential: 'AWS_LAB', decision: expect.any(String) }),
    ]));
    expect(minted).toHaveLength(2);
    const decisions = (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': token })).body.decisions;
    for (const e of minted) {
      expect(decisions.find((d) => d.id === (e.data as { decision: string }).decision)).toMatchObject({ allowed: true, check: { box: box!.name }, template: t.name, operation: 'read' });
    }
    // The box had the minted session and token, its region and its STS; never a minting credential.
    const boxEnv = JSON.stringify(box!.env);
    for (const minted of [MINTED_AWS.AccessKeyId, MINTED_AWS.SecretAccessKey, MINTED_AWS.SessionToken, MINTED_KUBE_TOKEN, kube.url, 'eu-west-1', sts.url]) expect(boxEnv).toContain(minted);
    const kept = JSON.stringify([await a.events(), await asked(a, token), box!.script]);
    for (const secret of [MINTED_AWS.SecretAccessKey, MINTED_AWS.SessionToken, MINTED_KUBE_TOKEN]) expect(kept).not.toContain(secret);
    for (const secret of [KUBE_MINTING_TOKEN, AWS_MINTING_SECRET]) expect(boxEnv + kept).not.toContain(secret);
    expect(cloud.calls().filter((c) => c.startsWith('aws ')).length).toBeGreaterThan(0);

    const checked = await asked(a, token);
    expect(checked.check).toMatchObject({ version: checked.savedAt, state: 'passed' });
    // Six for the cluster (kubectl and helm), six for the role (aws): each with its egress probe (issue #849).
    expect(checked.check!.probes.length).toBe(12);
    expect(checked.check!.probes.filter((p) => p.id.startsWith('egress.')).map((p) => p.id).sort()).toEqual(['egress.aws', 'egress.kube']);
    expect(checked.check!.probes.every((p) => p.passed)).toBe(true);
    const event = (await a.events()).find((e) => e.type === 'template.checked');
    expect(event?.data).toEqual({ template: t.name, state: 'passed', failed: [], artifact: checked.check!.artifact });

    expect((await stepBox(a, token, t.name)).status).toBe(200);
    // A passed check is not run again.
    await a.app.sandboxes.check();
    expect(runtime.ran.size).toBe(1);
  });

  it('a write that goes through fails the check: the template takes no box until a person runs it again and it passes', async () => {
    const { a, token, runtime, cloud } = await boot(['cluster/lab']);
    cloud.setMode('writable');
    const creds = await runningJob(a);
    expect((await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab'])).code).toBe(3);
    await a.app.sandboxes.check();
    const t = await asked(a, token);
    expect(t.check).toMatchObject({ state: 'failed' });
    const failed = ['kube.create-namespace on lab (allowed)', 'kube.delete-pod on lab (error)', 'helm.install on lab (allowed)'];
    expect((await a.events()).find((e) => e.type === 'template.checked')?.data).toEqual({ template: t.name, state: 'failed', failed, artifact: t.check!.artifact });

    const refused = await stepBox(a, token, t.name);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(`it failed (${failed.join('; ')}). A person runs it again in Vault, or with hopper template check ${t.name}`);
    const told = await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab']);
    expect(told.code).toBe(3);
    expect(told.stdout).toContain(`waiting: template ${t.name} is approved; waiting for the read-only check of ${t.name}: it failed`);
    // A failed check is not run again by itself.
    await a.app.sandboxes.check();
    expect(runtime.ran.size).toBe(1);

    // The credential is made read-only; a person asks for the check again.
    cloud.setMode('read-only');
    expect((await vault(a, token, { action: 'check-template', name: t.name })).status).toBe(200);
    expect((await asked(a, token)).check).toBeUndefined();
    await a.app.sandboxes.check();
    expect((await asked(a, token)).check).toMatchObject({ state: 'passed' });
    expect((await stepBox(a, token, t.name)).status).toBe(200);
    expect((await a.events()).find((e) => e.type === 'template.check_requested')?.data).toMatchObject({ template: t.name });
  });

  it('a save makes the check stale: it runs again on the template as it is now', async () => {
    const { a, token, runtime } = await boot(['cluster/lab']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab']);
    await a.app.sandboxes.check();
    const t = await asked(a, token);
    expect(t.check?.state).toBe('passed');

    // A person adds terraform: its image waits for approval, and its check is stale.
    expect((await vault(a, token, { action: 'save-template', name: t.name, image: t.image, secrets: [], tools: ['helm', 'kubectl', 'terraform'] })).status).toBe(200);
    const saved = await asked(a, token);
    expect(saved.readOnly).toBe(true);
    expect((await stepBox(a, token, t.name)).status).toBe(409);
    await a.app.sandboxes.check();
    expect(runtime.ran.size).toBe(1);
    expect((await vault(a, token, { action: 'approve-template', name: t.name })).status).toBe(200);
    expect((await stepBox(a, token, t.name)).body.error).toContain('it has not run on this version yet');
    await a.app.sandboxes.check();
    expect(runtime.ran.size).toBe(2);
    expect((await asked(a, token)).check).toMatchObject({ version: saved.savedAt, state: 'passed' });
    expect((await stepBox(a, token, t.name)).status).toBe(200);
  });

  it('a template with a write need, and one a person saved, take no read-only check', async () => {
    const { a, token, runtime } = await boot(['cluster/*']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab write/cluster/lab', '--plan', 'kubectl scale deploy/web --replicas=2 (undo: scale back)']);
    const t = await asked(a, token);
    expect(t.readOnly).toBeUndefined();
    expect((await vault(a, token, { action: 'approve-template', name: t.name })).status).toBe(200);
    expect((await a.ui('/ui/api/vault', { action: 'approve-profile', name: t.name, operation: 'write', asset: { kind: 'cluster', name: 'lab' } }, { token })).status).toBe(200);
    expect((await stepBox(a, token, t.name)).status).toBe(200);

    expect((await vault(a, token, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }] })).status).toBe(200);
    expect((await vault(a, token, { action: 'approve-template', name: 'kube' })).status).toBe(200);
    expect((await stepBox(a, token, 'kube')).status).toBe(200);
    const no = await vault(a, token, { action: 'check-template', name: 'kube' });
    expect(no.status).toBe(400);
    expect(no.body.error).toBe('kube takes no read-only check: only a template a job asked for with read and observe needs only does');
    await a.app.sandboxes.check();
    expect(runtime.ran.size).toBe(0);
  });

  it('a check box that ends badly, or does not start, fails the check with the reason', async () => {
    const { a, token, runtime, cloud } = await boot(['cluster/lab']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab']);
    const t = await asked(a, token);
    // Every probe line is there, but the script itself ended with 137 (killed): no pass.
    runtime.runScript = async (spec) => { const r = await cloud.runScript(spec); return { ...r, exit: 137 }; };
    await a.app.sandboxes.check();
    expect((await asked(a, token)).check).toMatchObject({ state: 'failed', problem: 'the check box ended with 137' });

    runtime.runScript = cloud.runScript;
    runtime.createFails = 'no space left on device';
    expect((await vault(a, token, { action: 'check-template', name: t.name })).status).toBe(200);
    await a.app.sandboxes.check();
    expect((await asked(a, token)).check).toMatchObject({ state: 'failed', probes: [], problem: 'the check box did not run: no space left on device' });
    expect(runtime.volumes.size).toBe(0);
    expect((await stepBox(a, token, t.name)).status).toBe(409);
  });

  it('a check box no run holds (a hopper stopped mid-check) is removed, and its check runs again', async () => {
    const { a, token, runtime } = await boot(['cluster/lab']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab']);
    const t = await asked(a, token);
    // As a hopper stopped mid-check leaves it: a check box, and the check `running`.
    const instanceId = a.app.instance.settings.instanceId();
    runtime.put({ name: 'hopper-check-left', image: 'i', network: 'n', volume: 'hopper-check-left-home', env: {}, labels: { [CHECK_LABEL]: instanceId }, limits: { cpus: 1, memoryMb: 1 }, user: 'agent', script: 'true' });
    expect(a.user().vault.recordCheck(t.name, { version: t.savedAt, state: 'running', at: t.savedAt, probes: [] })).toBe(true);

    await a.app.sandboxes.check();
    expect(runtime.boxes.has('hopper-check-left')).toBe(false);
    expect(runtime.volumes.has('hopper-check-left-home')).toBe(false);
    expect((await asked(a, token)).check).toMatchObject({ state: 'passed' });
  });
  it('a need the vault cannot mint a credential for fails the check: its probes are not run, saying why, and the other needs\' probes still run (issue #873)', async () => {
    const { a, token, runtime, kube } = await boot(['cluster/*']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab read/cluster/other']);
    await a.app.sandboxes.check();
    const t = await asked(a, token);
    expect(t.check).toMatchObject({ state: 'failed' });
    expect(t.check!.problem).toBeUndefined();
    // Issue #1468: a read the vault mints nothing for (an aws-account) is refused when it is asked for, so never reaches the check.
    // Issue #1766: a cluster with no minting credential is looked for in the AWS accounts; this one's STS is a double, so no EKS is asked.
    const why = /^not run: the check box gets no credential for read on cluster other: no minting credential mints for cluster other, and the vault found it in none of the accounts it mints for \(123456789012: \w+ names an STS endpoint and no EksEndpoint\)$/;
    const other = t.check!.probes.filter((p) => p.asset === 'other');
    expect(other.length).toBeGreaterThan(0);
    for (const p of other) expect(p).toMatchObject({ outcome: 'not-run', passed: false, output: expect.stringMatching(why) });
    // The probes of cluster lab ran in the check box, with the token minted for it.
    const lab = t.check!.probes.filter((p) => p.asset === 'lab');
    expect(lab.length).toBeGreaterThan(0);
    expect(lab.every((p) => p.passed), JSON.stringify(lab)).toBe(true);
    expect(t.check!.transient).toBeUndefined();
    expect(runtime.ran.size).toBe(1);
    expect(kube.seen.length).toBeGreaterThan(0);
    expect((await stepBox(a, token, t.name)).status).toBe(409);
  });

  it('a read Access does not allow fails the check: its probes are not run, saying so, and it mints nothing', async () => {
    const { a, token, runtime, kube } = await boot(['cluster/lab']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab']);
    const t = await asked(a, token);
    const access = (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': token })).body;
    const approval = access.templates.find((x) => x.template === t.name)!.approvals[0]!;
    expect((await a.ui('/ui/api/access', { action: 'revoke', approval: approval.id }, { token })).status).toBe(200);

    await a.app.sandboxes.check();
    const checked = await asked(a, token);
    expect(checked.check).toMatchObject({ state: 'failed' });
    expect(checked.check!.problem).toBeUndefined();
    expect(checked.check!.probes.length).toBeGreaterThan(0);
    for (const p of checked.check!.probes) expect(p).toMatchObject({ outcome: 'not-run', passed: false, output: `not run: the check box gets no credential for read on cluster lab: Access denied it: template ${t.name} is not approved to read on cluster lab` });
    expect(runtime.ran.size).toBe(0);
    expect(kube.seen).toHaveLength(0);
    expect((await a.events()).find((e) => e.type === 'vault.check_mint_refused')?.data).toMatchObject({ template: t.name, mint: { kind: 'kube', operation: 'read', asset: { kind: 'cluster', name: 'lab' } }, decision: expect.any(String) });
  });

  it('with the vault in a container of its own (issue #586), the check box gets its read credentials the same way', async () => {
    const { a, token, runtime, kube, sts } = await boot(['cluster/lab', `aws-role/${ACCOUNT}/*`], { container: true });
    const creds = await runningJob(a);
    await skill(a, creds, NEEDS);
    await a.app.sandboxes.check();
    expect((await asked(a, token)).check).toMatchObject({ state: 'passed' });
    expect(kube.seen.map((r) => r.method)).toEqual(['POST', 'POST', 'DELETE']);
    expect(sts.seen).toHaveLength(1);
    const env = JSON.stringify([...runtime.ran.values()][0]!.env);
    for (const minted of [MINTED_AWS.SessionToken, MINTED_KUBE_TOKEN, kube.url, sts.url]) expect(env).toContain(minted);
    expect(env).not.toContain(KUBE_MINTING_TOKEN);
  });

  it('helm list refused on secrets on a view role passes the check; a mark changes no write (issues #916, #1736)', async () => {
    const { a, token, runtime, cloud } = await boot(['cluster/lab']);
    // A view role: helm list reads the secrets helm keeps its releases in, and is refused.
    renameSync(join(cloud.dir, 'helm'), join(cloud.dir, 'helm.real'));
    writeFileSync(join(cloud.dir, 'helm'), `#!/bin/sh
case "$1" in list) echo 'Error: list: failed to list: secrets is forbidden: User "system:serviceaccount:hopper:view" cannot list resource "secrets"' >&2; exit 1 ;; esac
exec "$(dirname "$0")/helm.real" "$@"
`);
    chmodSync(join(cloud.dir, 'helm'), 0o755);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab']);
    await a.app.sandboxes.check();
    const t = await asked(a, token);
    expect(t.check).toMatchObject({ state: 'passed' });
    expect(t.check!.probes.find((p) => p.id === 'helm.list')).toMatchObject({ expect: 'allowed', outcome: 'denied', passed: true });
    expect((await a.events()).filter((e) => e.type === 'template.checked').at(-1)?.data).toMatchObject({ state: 'passed', failed: [] });

    // A write probe takes no mark, and nor does a probe the hopper does not have.
    const write = await vault(a, token, { action: 'save-template', name: t.name, image: t.image, secrets: [], probeMarks: { 'helm.install': 'skip' } });
    expect(write.status).toBe(400);
    expect(write.body.error).toBe('helm.install is a write probe: a write must be refused always, so it takes no mark');
    expect((await vault(a, token, { action: 'save-template', name: t.name, image: t.image, secrets: [], probeMarks: { 'helm.lst': 'skip' } })).status).toBe(400);

    // A person can still mark helm list expect-denied: the save keeps its approval, and the check runs again and passes.
    expect((await vault(a, token, { action: 'save-template', name: t.name, image: t.image, secrets: [], probeMarks: { 'helm.list': 'expect-denied' } })).status).toBe(200);
    const marked = await asked(a, token);
    expect(marked).toMatchObject({ probeMarks: { 'helm.list': 'expect-denied' }, readOnly: true, approval: { by: 'the read policy' } });
    expect((await a.events()).filter((e) => e.type === 'template.saved').at(-1)?.data).toMatchObject({ probeMarks: { 'helm.list': 'expect-denied' } });
    await a.app.sandboxes.check();
    const passed = (await asked(a, token)).check!;
    expect(passed).toMatchObject({ version: marked.savedAt, state: 'passed' });
    expect(passed.probes.find((p) => p.id === 'helm.list')).toMatchObject({ expect: 'denied', mark: 'expect-denied', outcome: 'denied', passed: true });
    expect((await stepBox(a, token, t.name)).status).toBe(200);

    // A save that leaves the marks out keeps them; the job's request of the same needs changes nothing.
    expect((await vault(a, token, { action: 'save-template', name: t.name, image: t.image, secrets: [] })).status).toBe(200);
    expect((await asked(a, token)).probeMarks).toEqual({ 'helm.list': 'expect-denied' });
    expect((await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab'])).code).toBe(3);
    expect((await asked(a, token)).probeMarks).toEqual({ 'helm.list': 'expect-denied' });

    // With the mark, a write that goes through still fails the check.
    cloud.setMode('writable');
    await a.app.sandboxes.check();
    const writable = (await asked(a, token)).check!;
    expect(writable.state).toBe('failed');
    expect(writable.probes.filter((p) => !p.passed).map((p) => p.id)).toEqual(['kube.create-namespace', 'kube.delete-pod', 'helm.install']);
    expect(runtime.ran.size).toBe(3);
  });
});
