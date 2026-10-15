// Issue #1285: a cluster install — the hopper as a Kubernetes workload, a Helm release — has its own update mode. Its update
// is `helm upgrade` of the release to a new image tag; its stack drift compares the image it runs with the update channel,
// never a compose file; and nothing it shows or runs is a Podman or compose command. A compose install keeps its update.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { ClusterInstall, UpdateStatus } from '../../src/domain/types.ts';
import { checkCluster, clusterInstall, clusterUpdateTag, HELM_CHART, helmUpgradeCommand } from '../../src/update/cluster.ts';
import { createStackDrift, driftLine } from '../../src/update/drift.ts';
import { CLUSTER_UPDATE_SKILL, UPDATE_SKILL, updateSkill } from '../../src/update/update-skill.ts';
import { clusterFix } from '../../ui/src/model/drift.ts';
import { headline, helmUpgradeCommand as uiHelmUpgradeCommand, imageUpdate } from '../../ui/src/model/update.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const CLUSTER: ClusterInstall = { release: 'hopper', namespace: 'hopper', chart: HELM_CHART };
const IN_CLUSTER = { KUBERNETES_SERVICE_HOST: '10.0.0.1' };
const COMMIT = 'c'.repeat(40);
/** A compose or podman command: what a cluster install never shows or runs. */
const COMPOSE_WORDS = /podman|docker|compose/i;

async function cli(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env, stdin: () => '', out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

describe('a cluster install (issue #1285)', () => {
  it('is found by KUBERNETES_SERVICE_HOST: the release and the pod\'s own namespace', () => {
    expect(clusterInstall({}, () => 'hopper')).toBeUndefined();
    expect(clusterInstall(IN_CLUSTER, () => 'tools')).toEqual({ release: 'hopper', namespace: 'tools', chart: HELM_CHART });
    expect(clusterInstall({ ...IN_CLUSTER, HOPPER_HELM_RELEASE: 'ops-hopper' }, () => undefined)).toEqual({ release: 'ops-hopper', chart: HELM_CHART });
    // A name a shell or Helm would read otherwise is not taken.
    expect(clusterInstall({ ...IN_CLUSTER, HOPPER_HELM_RELEASE: 'x; rm -rf /' }, () => 'a b')).toEqual({ release: 'hopper', chart: HELM_CHART });
  });

  it('is updated by helm upgrade of its release to the image tag; the UI gives the same command', () => {
    expect(helmUpgradeCommand(CLUSTER, 'sha-ccccccc'))
      .toBe(`helm upgrade hopper ${HELM_CHART} --namespace hopper --reuse-values --set image.tag=sha-ccccccc`);
    expect(helmUpgradeCommand({ release: 'hopper', chart: HELM_CHART }, 'beta')).toBe(`helm upgrade hopper ${HELM_CHART} --reuse-values --set image.tag=beta`);
    expect(uiHelmUpgradeCommand(CLUSTER, 'sha-ccccccc')).toBe(helmUpgradeCommand(CLUSTER, 'sha-ccccccc'));
    expect(clusterUpdateTag(COMMIT)).toBe('sha-ccccccc');
  });

  describe('drift: the image it runs against the update channel', () => {
    it('reports a mismatch when the running image is another channel\'s', () => {
      expect(checkCluster({ branch: 'beta', channelTag: 'stable' })).toEqual({
        state: 'checked',
        gaps: [{ kind: 'image', name: 'hopper', what: 'the hopper runs the beta image; the update channel is stable', off: expect.any(String) }],
      });
    });

    it('reports none when the running image is the channel\'s', () => {
      expect(checkCluster({ branch: 'stable', channelTag: 'stable' })).toEqual({ state: 'checked', gaps: [] });
      expect(checkCluster({ branch: 'canary', channelTag: 'canary' })).toEqual({ state: 'checked', gaps: [] });
    });

    it('is unchecked, with the reason, when the build does not know its branch', () => {
      expect(checkCluster({ branch: undefined, channelTag: 'stable' })).toEqual({ state: 'unchecked', reason: expect.stringMatching(/branch/), gaps: [] });
    });

    it('never compares with a compose file, and the fix is helm upgrade to the channel\'s image', async () => {
      const appDir = mkdtempSync(join(tmpdir(), 'jh-cluster-'));
      try {
        writeFileSync(join(appDir, 'compose.yaml'), 'services:\n  openfga: {}\n');
        writeFileSync(join(appDir, 'install.json'), JSON.stringify({ kind: 'image', repo: 'https://github.com/o/r.git', branch: 'beta', commit: COMMIT, installedAt: '2026-10-04T00:00:00Z' }));
        const probe = { resolves: async (): Promise<boolean> => { throw new Error('a cluster install probes no compose service'); }, vaultCommit: async () => null };
        const check = (channel: string) => createStackDrift({ appDir, env: IN_CLUSTER, probe, cluster: CLUSTER, channel: () => channel })();
        const drifted = await check('stable');
        expect(drifted).toMatchObject({ state: 'checked', cluster: CLUSTER, image: 'ghcr.io/henningfutrell/hopper:stable' });
        expect(drifted.gaps.map((g) => g.kind)).toEqual(['image']);
        const line = driftLine(drifted)!;
        expect(line).toContain(helmUpgradeCommand(CLUSTER, 'stable'));
        expect(line).not.toMatch(COMPOSE_WORDS);
        expect(clusterFix(drifted)).toBe(helmUpgradeCommand(CLUSTER, 'stable'));
        expect(await check('beta')).toMatchObject({ state: 'checked', gaps: [] });
      } finally {
        rmSync(appDir, { recursive: true, force: true });
      }
    });
  });

  it('the update notice gives helm upgrade to the target\'s image, and no Podman or compose command', () => {
    const s: UpdateStatus = {
      state: 'available', channel: 'stable', autoUpdate: false, whatsNew: [], installedWhatsNew: [], restartBlockers: 0, cluster: CLUSTER,
      installed: { kind: 'image', repo: 'https://github.com/o/r.git', branch: 'stable', commit: 'a'.repeat(40), installedAt: '2026-10-04T00:00:00Z' },
      target: { commit: COMMIT, ref: 'stable' },
    };
    const u = imageUpdate(s)!;
    expect(u.commands).toEqual([]);
    expect(u.helm).toBe(helmUpgradeCommand(CLUSTER, 'sha-ccccccc'));
    expect(headline(s)).toBe('Update available: upgrade the Helm release to the stable image');
    expect(`${headline(s)} ${u.blockers}`).not.toMatch(COMPOSE_WORDS);
  });

  it('the agent skill is helm upgrade, with no Podman or compose step; a compose install keeps its own', () => {
    expect(updateSkill(CLUSTER)).toBe(CLUSTER_UPDATE_SKILL);
    expect(updateSkill(undefined)).toBe(UPDATE_SKILL);
    expect(CLUSTER_UPDATE_SKILL).toContain('helm upgrade');
    expect(CLUSTER_UPDATE_SKILL).not.toMatch(COMPOSE_WORDS);
  });

  it('hopper update in a pod: the cluster skill, and no compose step to print or run', async () => {
    const skill = await cli(['update', 'skill'], IN_CLUSTER);
    expect(skill.code).toBe(0);
    expect(skill.out).toBe(CLUSTER_UPDATE_SKILL);
    for (const what of ['script', 'compose', 'carry']) {
      const r = await cli(['update', what, '--image', 'ghcr.io/henningfutrell/hopper:beta'], IN_CLUSTER);
      expect(r.code, what).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toMatch(/cluster install/);
      expect(r.err).toContain('helm upgrade');
    }
    // A compose install keeps today's commands.
    expect((await cli(['update', 'skill'])).out).toBe(UPDATE_SKILL);
    expect((await cli(['update', 'script'])).out).toBe(readFileSync(join(ROOT, 'scripts', 'update.sh'), 'utf8'));
  });
});
