// Issue #716, item 4: the read-only check's box against real rootless Podman. It runs only where
// HOPPER_TEST_PODMAN_SOCKET names a rootless Podman API socket, and the box image is local (HOPPER_TEST_PODMAN_IMAGE;
// default the published box image); the tools image is built from the tools' own releases, so it needs the network.
// Elsewhere it is skipped. test/integration/read-only-check.test.ts runs the same check through the daemon, with doubles.
//
// Feature: a check box runs in real Podman
//   Scenario: a check box runs its probes under the sandbox flags, its output is read, and nothing of it is left
//     Given a catalog whose write is refused and whose read works, in the tools' own words
//     When the check runs in a box of the image with kubectl added
//     Then it passed, every probe with its exit code and output
//     And no container and no volume of it are left
//   Scenario: with a credential for a cluster it cannot reach, the hopper's own probes fail closed, and use the kubeconfig given
//     Given a template of read on cluster lab with kubectl and helm, and a token minted for a cluster no server answers at
//     When the check runs
//     Then it failed: every probe is an error (no write was refused, no read worked), none is counted a refusal
//     And kubectl asked the server the kubeconfig names (issue #797), not its default
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Probe, Template } from '../../src/domain/types.ts';
import { runCheck, type CheckContext } from '../../src/sandbox/check.ts';
import { createPodmanRuntime } from '../../src/sandbox/podman.ts';
import { HOPPER_PROBES, probeCatalog } from '../../src/sandbox/probes.ts';

const SOCKET = process.env.HOPPER_TEST_PODMAN_SOCKET;
const IMAGE = process.env.HOPPER_TEST_PODMAN_IMAGE ?? 'ghcr.io/henningfutrell/hopper:box-claude';
const podman = (...args: string[]): string => execFileSync('podman', ['--url', `unix://${SOCKET}`, ...args], { encoding: 'utf8' }).trim();

const template = (tools: Template['tools']): Template => ({
  name: 'asked-0123456789ab', image: IMAGE, secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }], ...(tools ? { tools } : {}),
  readOnly: true, savedBy: 'job 1', savedAt: '2026-10-10T20:00:00.000Z',
});

/** A minted token for a cluster whose API server nothing listens at (issue #797): the box gets its kubeconfig. */
const NOWHERE = 'https://127.0.0.1:9';
const credentials: CheckContext['credentials'] = {
  credential: async () => ({ minted: { kind: 'kube', token: 'minted-in-test', expirationTimestamp: '2030-01-01T00:00:00Z' }, reach: { kind: 'kube', server: NOWHERE } }),
};

const context = (probes: CheckContext['probes']): CheckContext => ({
  runtime: createPodmanRuntime(SOCKET!), credentials, instanceId: 'test-716', network: 'host', probes,
  clock: { now: () => new Date() }, logger: { info: () => {}, warn: () => {} },
});

const left = (name: string): void => {
  expect(podman('ps', '-a', '--format', '{{.Names}}').split('\n')).not.toContain(name);
  expect(podman('volume', 'ls', '--format', '{{.Name}}').split('\n')).not.toContain(`${name}-home`);
};

describe.skipIf(!SOCKET)('the read-only check, real rootless Podman (issue #716)', () => {
  it('a check box runs its probes under the sandbox flags, its output is read, and nothing of it is left', async () => {
    const probes: Probe[] = [
      { id: 'own.read', title: 'kubectl is there', kinds: ['cluster'], tool: 'kubectl', expect: 'allowed', script: 'kubectl version --client' },
      { id: 'own.write', title: 'a refused write', kinds: ['cluster'], tool: 'kubectl', expect: 'denied', script: 'touch /etc/x 2>/dev/null || { echo "Error from server (Forbidden): namespaces is forbidden" >&2; exit 1; }' },
      // A long output: more than one frame of the log stream.
      { id: 'own.long', title: 'a long output', kinds: ['cluster'], tool: 'kubectl', expect: 'allowed', script: 'seq 1 2000; id -u' },
    ];
    const name = `hopper-check-t${Date.now().toString(36)}`;
    const check = await runCheck(context(probeCatalog(probes)), 'admin', template(['kubectl']), name);
    expect(check.problem).toBeUndefined();
    expect(check.state).toBe('passed');
    expect(check.probes.map((p) => [p.id, p.outcome, p.exit])).toEqual([['own.read', 'allowed', 0], ['own.write', 'denied', 1], ['own.long', 'allowed', 0]]);
    expect(check.probes[0]!.output).toContain('Client Version: v1.37.1');
    // Not root: the box image's own user.
    expect(check.probes[2]!.output.endsWith('1000')).toBe(true);
    left(name);
  }, 600_000);

  it('with a credential for a cluster it cannot reach, the hopper\'s own probes fail closed, and use the kubeconfig given', async () => {
    const name = `hopper-check-t${Date.now().toString(36)}`;
    const check = await runCheck(context(HOPPER_PROBES), 'admin', template(['helm', 'kubectl']), name);
    expect(check.state).toBe('failed');
    expect(check.probes.map((p) => p.id)).toEqual(['kube.get', 'kube.create-namespace', 'kube.delete-pod', 'helm.list', 'helm.install']);
    for (const p of check.probes) {
      expect(p.outcome, `${p.id}: ${p.output}`).toBe('error');
      expect(p.exit).toBeGreaterThan(0);
      if (p.id !== 'helm.install') expect(p.output, p.id).toContain('127.0.0.1:9');
    }
    left(name);
  }, 600_000);
});
