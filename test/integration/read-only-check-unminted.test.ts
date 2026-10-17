// Issue #1779, through the real composition root and the real HTTP server (test/support/read-only-check.ts): a read-only
// check that failed as the vault minted nothing for a read need ends the waiting job's wait with why, and runs again when
// a minting credential for that need's cluster is set, with no person to ask for it.
//
// Feature: a check that failed on a mint
//   Scenario: the job's wait ends with why, and a minting credential set for the cluster runs the check again
//     Given the read policy holds every cluster, and the vault mints for cluster lab only
//     When a job asks for read on cluster lab and cluster other, with --wait, and the check pass runs
//     Then the check fails, and keeps that the vault minted nothing for cluster other
//     And the job's wait ends with a refusal that says so and to ask for a need the vault mints for
//     When a person sets a minting credential for a cluster the template does not read
//     Then the failed check stays
//     When a person sets a minting credential for cluster other
//     Then the check goes, `template.check_requested` names the credential, and the next check pass passes
import { afterEach, describe, expect, it } from 'vitest';
import { asked, boot, KUBE_MINTING_TOKEN, runningJob, stopAll, vault, waiting } from '../support/read-only-check.ts';

afterEach(stopAll);

describe('a read-only check that failed on a mint (issue #1779)', () => {
  it('ends the job\'s wait with why, and runs again when the minting credential for the cluster is set', async () => {
    const { a, token, kube } = await boot(['cluster/*']);
    const creds = await runningJob(a);
    const done = waiting(a, creds, ['sandbox-template', '--why', 'Read the clusters for the report', '--needs', 'read/cluster/lab read/cluster/other']);
    await done.opened;
    await a.app.sandboxes.check();

    const t = await asked(a, token);
    expect(t.check).toMatchObject({ state: 'failed', unminted: [{ asset: { kind: 'cluster', name: 'other' } }] });
    expect(t.check!.unminted![0]!.reason).toContain('no minting credential mints for cluster other');
    const end = await done.end;
    expect(end.code).not.toBe(0);
    const said = end.stdout + end.stderr;
    expect(said).toContain(`template ${t.name} cannot pass its read-only check: the vault minted no credential for read on cluster other`);
    expect(said).toContain('Ask for a read need the vault mints for in its place');

    const kubeValue = JSON.stringify({ server: kube.url, token: KUBE_MINTING_TOKEN });
    expect((await vault(a, token, { action: 'set', name: 'KUBE_ELSE', mints: { kind: 'cluster', name: 'else' }, value: kubeValue })).status).toBe(200);
    expect((await asked(a, token)).check).toMatchObject({ state: 'failed' });

    expect((await vault(a, token, { action: 'set', name: 'KUBE_OTHER', mints: { kind: 'cluster', name: 'other' }, value: kubeValue })).status).toBe(200);
    expect((await asked(a, token)).check).toBeUndefined();
    const requested = (await a.events()).filter((e) => e.type === 'template.check_requested');
    expect(requested.map((e) => e.data)).toEqual([{ template: t.name, by: 'minting credential KUBE_OTHER' }]);

    await a.app.sandboxes.check();
    expect((await asked(a, token)).check).toMatchObject({ state: 'passed' });
    expect((await asked(a, token)).check!.unminted).toBeUndefined();
  });
});
