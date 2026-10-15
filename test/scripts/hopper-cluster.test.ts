// scripts/hopper-cluster.sh (issue #1373, docs/kubernetes.md): a compose install moved onto Kubernetes — a cluster on this
// host, the data moved into the chart's release, and the cutover. podman, kubectl, helm, systemctl, loginctl and curl are
// stubs on PATH that record each call (never the master key: a stub that reads it records only whether it matched), so no
// cluster, container or unit of this machine is touched. The image prints the script: `hopper cluster script`.
//
// Feature: a compose install moves onto a cluster, and back
//   Scenario: bootstrap refuses when a cluster is there, and with --use-existing prints its kubeconfig
//   Scenario: bootstrap installs k3s and helm, checksums checked, under a rootless user unit; nothing of Podman changes
//   Scenario: bootstrap refuses a download whose checksum does not match, and a host whose cgroups are not delegated
//   Scenario: migrate refuses a master key whose fingerprint is not the running hopper's: nothing stops
//   Scenario: migrate cuts over: the key only on pipes, the hopper at 0 until the data is in, compose stopped, not removed
//   Scenario: a cluster hopper that is not healthy rolls back: the cluster hopper to 0, the compose stack started again
//   Scenario: rollback after a migration starts the compose stack again
//   Scenario: an install with the local KMS is refused
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { delegated, filesHolding, FP, host, KEY, migrate, removeHosts, ROOT, SCRIPT, sha } from '../support/hopper-cluster.ts';

afterEach(removeHosts);


describe('hopper-cluster.sh bootstrap', () => {
  it('refuses when a cluster is there, and with --use-existing prints its kubeconfig and changes nothing', () => {
    const h = host();
    const kube = join(h.dir, '.kube-config');
    writeFileSync(kube, 'apiVersion: v1\n');
    const r = h.run(['bootstrap'], { KUBECONFIG: kube });
    expect(r.status).toBe(1);
    expect(r.err).toContain('a cluster is already there');
    const u = h.run(['bootstrap', '--use-existing'], { KUBECONFIG: kube });
    expect(u.status, u.err).toBe(0);
    expect(u.out.trim()).toBe(kube);
    expect(h.calls().filter((c) => c.startsWith('curl') || c.startsWith('systemctl --user enable'))).toEqual([]);
    expect(existsSync(h.state)).toBe(false);
  });

  it('installs k3s and helm, checked against their checksums, under a rootless user unit, and touches nothing of Podman', () => {
    const h = host();
    const k3s = Buffer.from('#!/bin/sh\necho k3s\n');
    const helmBin = Buffer.from('#!/bin/sh\necho helm\n');
    writeFileSync(join(h.files, 'k3s'), k3s);
    writeFileSync(join(h.files, 'sha256sum-amd64.txt'), `${sha(k3s)}  k3s\n${sha('other')}  k3s-airgap-images-amd64.tar\n`);
    writeFileSync(join(h.files, 'sha256sum-arm64.txt'), `${sha(k3s)}  k3s-arm64\n`);
    writeFileSync(join(h.files, 'k3s-arm64'), k3s);
    const pack = join(h.dir, '.pack');
    for (const arch of ['amd64', 'arm64']) {
      mkdirSync(join(pack, `linux-${arch}`), { recursive: true });
      writeFileSync(join(pack, `linux-${arch}`, 'helm'), helmBin);
      const tgz = join(h.files, `helm-v3.19.0-linux-${arch}.tar.gz`);
      expect(spawnSync('tar', ['-czf', tgz, '-C', pack, `linux-${arch}`]).status).toBe(0);
      writeFileSync(`${tgz}.sha256sum`, `${sha(readFileSync(tgz))}  helm-v3.19.0-linux-${arch}.tar.gz\n`);
    }
    const r = h.run(['bootstrap']);
    expect(r.status, r.err).toBe(0);
    const kube = join(h.state, 'kubeconfig.yaml');
    expect(r.out.trim()).toBe(kube);
    expect(readFileSync(join(h.state, 'bin', 'k3s'))).toEqual(k3s);
    expect(readFileSync(join(h.state, 'bin', 'helm'))).toEqual(helmBin);
    const unit = readFileSync(join(h.home, '.config', 'systemd', 'user', 'hopper-k3s.service'), 'utf8');
    expect(unit).toMatch(/ExecStart=.*k3s" server --rootless --data-dir "[^"]*\/cluster\/data" --write-kubeconfig "[^"]*kubeconfig\.yaml" --write-kubeconfig-mode 600 --disable traefik/);
    expect(unit).toContain('Delegate=yes');
    expect(h.calls()).toContain('systemctl --user enable --now hopper-k3s.service');
    expect(h.calls().filter((c) => c.startsWith('podman'))).toEqual([]);
  });

  it('refuses a download whose checksum does not match: no binary is left', () => {
    const h = host();
    writeFileSync(join(h.files, 'k3s'), 'tampered');
    writeFileSync(join(h.files, 'k3s-arm64'), 'tampered');
    writeFileSync(join(h.files, 'sha256sum-amd64.txt'), `${sha('the real one')}  k3s\n`);
    writeFileSync(join(h.files, 'sha256sum-arm64.txt'), `${sha('the real one')}  k3s-arm64\n`);
    expect(h.run(['bootstrap']).err).toContain('does not match its checksum');
    expect(existsSync(join(h.state, 'bin', 'k3s'))).toBe(false);
    expect(existsSync(join(h.state, 'bin', 'k3s.next'))).toBe(false);
  });

  it('refuses a host whose cgroup controllers are not delegated to the user, and says the root step', () => {
    const h = host();
    writeFileSync(join(delegated(h.cgroups), 'cgroup.controllers'), 'pids');
    const r = h.run(['bootstrap']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('the cgroup controller cpu is not delegated');
    expect(r.err).toContain('Delegate=cpu cpuset io memory pids');
    expect(h.calls().filter((c) => c.startsWith('curl'))).toEqual([]);
  });
});

describe('hopper-cluster.sh migrate', () => {
  it('refuses a master key whose fingerprint is not the running hopper\'s: nothing stops, nothing is installed', () => {
    const h = host();
    const r = migrate(h, { HOPPER_MASTER_KEY: 'ab'.repeat(32) });
    expect(r.status).toBe(1);
    expect(r.err).toContain(`the running hopper ${FP}`);
    expect(h.calls().filter((c) => /^podman stop|^helm install|create secret/.test(c))).toEqual([]);
  });

  it('works the fingerprint out as the hopper does, from a key in hex or in base64', () => {
    for (const key of [KEY, Buffer.from(KEY, 'hex').toString('base64'), Buffer.from(KEY, 'hex').toString('base64url')]) {
      const h = host();
      const r = h.run(['migrate', '--chart', h.chart], { HOPPER_MASTER_KEY: key });
      expect(r.err, key).toContain(`the master key from HOPPER_MASTER_KEY matches the running hopper (fingerprint ${FP})`);
    }
  });

  it('moves the data and cuts over: the key only on pipes, the hopper at 0 until the data is in, the stack stopped and never removed', () => {
    const h = host({ unit: true });
    const r = migrate(h, { STUB_LAUNCH_KEY: KEY });
    expect(r.status, r.err).toBe(0);
    const calls = h.calls();
    const at = (re: RegExp) => { const i = calls.findIndex((c) => re.test(c)); expect(i, `${String(re)} in\n${calls.join('\n')}`).toBeGreaterThanOrEqual(0); return i; };

    // The key: from the hopper's launch environment, onto the Secret on a pipe; never an argument, never a file.
    expect(r.err).toContain("the master key from the compose hopper's launch environment matches the running hopper");
    expect(calls).toContain('key-matched');
    for (const c of calls) expect(c).not.toContain(KEY);
    expect(filesHolding(h.dir, KEY)).toEqual([]);

    // The order: the release with the hopper at 0 while compose runs; then the watchdog off and the compose hopper stopped;
    // the dump; the hopper at 1; the checks; the home; then the whole stack stopped.
    const install = at(/^helm install hopper .* --namespace hopper -f - --wait --wait-for-jobs/);
    const watchdog = at(/^systemctl --user disable hopper-compose.service hopper-compose-check.timer/);
    const stopHopper = at(/^podman stop hopperid$/);
    const restore = at(/^restored-dump$/);
    const upgrade = at(/^helm upgrade hopper .* --reuse-values --set replicas=1/);
    const fingerprint = at(/exec deployment\/hopper -c hopper -- hopper master-key status/);
    const home = at(/^home-copied$/);
    const stopAll = at(/^podman stop hopperid pgid$/);
    expect([install, watchdog, stopHopper, restore, upgrade, fingerprint, home, stopAll]).toEqual([...[install, watchdog, stopHopper, restore, upgrade, fingerprint, home, stopAll]].sort((a, b) => a - b));
    at(/DROP DATABASE IF EXISTS hopper WITH \(FORCE\)/);
    at(/delete job -l app.kubernetes.io\/instance=hopper,app.kubernetes.io\/component=openfga-migrate/);

    // Nothing of compose is removed.
    for (const c of calls) expect(c).not.toMatch(/^podman (rm|rmi|volume|image rm|compose|system)|\bdown\b/);

    // The values: the image and port compose ran, the hopper at 0, the master key Secret mounted, the names machines reach
    // it by, and the hopper's own settings, the secret ones from a Secret.
    const values = JSON.parse(readFileSync(join(h.home, 'values.json'), 'utf8')) as Record<string, unknown>;
    expect(values).toMatchObject({
      replicas: 0, port: 4790, service: { type: 'ClusterIP' }, image: { repository: 'ghcr.io/henningfutrell/hopper', tag: 'beta' },
      masterKey: { existingSecret: 'hopper-master-key' }, hopperVault: { enabled: false },
    });
    expect(String(values.lanNames).split(',')).toContain('box.lan');
    expect(String(values.lanNames).split(',')).not.toContain('hopper');
    expect(values.extraEnv).toEqual([
      { name: 'HOPPER_PUBLIC_URL', value: 'https://hopper.example' },
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', valueFrom: { secretKeyRef: { name: 'hopper-carried-env', key: 'CLAUDE_CODE_OAUTH_TOKEN' } } },
    ]);
    expect(calls).toContain('carried: CLAUDE_CODE_OAUTH_TOKEN=tok-123');
    expect(JSON.stringify(values)).not.toContain('tok-123');
  });

  it('rolls back when the cluster hopper is not healthy: the cluster hopper to 0, the compose stack started again', () => {
    const h = host({ unit: true });
    const r = migrate(h, { STUB_LAUNCH_KEY: KEY, STUB_UNHEALTHY: '1' });
    expect(r.status).toBe(1);
    expect(r.err).toContain('rolled back');
    const calls = h.calls();
    const scale = calls.indexOf('kubectl --namespace hopper scale deployment/hopper --replicas=0');
    const restart = calls.indexOf('systemctl --user restart hopper-compose.service');
    expect(scale).toBeGreaterThan(calls.indexOf('podman stop hopperid'));
    expect(restart).toBeGreaterThan(scale);
    expect(calls).toContain('systemctl --user enable hopper-compose.service hopper-compose-check.timer');
    expect(calls).not.toContain('home-copied');
    expect(calls).not.toContain('podman stop hopperid pgid');
  });

  it('rollback after a migration starts the compose stack again, postgres first, and deletes nothing', () => {
    const h = host();
    expect(migrate(h, { STUB_LAUNCH_KEY: KEY }).status).toBe(0);
    const before = h.calls().length;
    const r = h.run(['rollback']);
    expect(r.status, r.err).toBe(0);
    const calls = h.calls().slice(before);
    expect(calls).toContain('kubectl --namespace hopper scale deployment/hopper --replicas=0');
    expect(calls.filter((c) => /^podman start/.test(c))).toEqual(['podman start pgid', 'podman start hopperid']);
    for (const c of calls) expect(c).not.toMatch(/^podman (rm|rmi|volume)|helm uninstall|delete pvc/);
  });

  it('refuses an install that runs the local KMS: its keys are in a compose volume', () => {
    const h = host();
    const r = migrate(h, { STUB_LAUNCH_KEY: KEY, STUB_PROFILES: 'hopper-vault,kms' });
    expect(r.status).toBe(1);
    expect(r.err).toContain('runs the local KMS');
    expect(h.calls().filter((c) => /^podman stop|^helm install/.test(c))).toEqual([]);
  });

  it('refuses when no cluster answers, and when the compose hopper does not run', () => {
    expect(migrate(host(), { STUB_NO_CLUSTER: '1' }).err).toContain('no cluster answers');
    expect(migrate(host(), { STUB_DOWN: '1' }).err).toContain('the compose hopper does not run');
  });
});

it('hopper cluster script prints this build\'s script, with no database', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'cluster', 'script'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  expect([r.status, r.stdout]).toEqual([0, readFileSync(SCRIPT, 'utf8')]);
});
