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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintOf, shortFingerprint } from '../../src/secrets/master-key.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'hopper-cluster.sh');
const KEY = 'f00dfeed'.repeat(8);
// The running hopper's: the fingerprint the script works out in the hopper's container must be the hopper's own.
const FP = shortFingerprint(fingerprintOf(KEY));
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The compose stack: container ids by service; `inspect` answers its launch environment, image and labels; `exec` the
// hopper's CLI (the fingerprint of the key on stdin, the status), postgres's dump and table count; `cp` a home as a tar.
const PODMAN = `#!/bin/bash
in=''
case "$*" in "exec -i hopperid node -e "*) in="$(cat)";; esac
printf 'podman %s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  "ps -aq --filter label=com.docker.compose.project=hopper") echo hopperid; echo pgid ;;
  "ps -aq --filter label=com.docker.compose.project=hopper --filter status=exited") echo hopperid; echo pgid ;;
  "ps -q --filter label=com.docker.compose.project=hopper") [ -f "$STUB_DIR/stopped" ] || { echo hopperid; echo pgid; } ;;
  "ps -q --filter label=com.docker.compose.project=hopper --filter label=com.docker.compose.service=hopper") [ -n "\${STUB_DOWN:-}" ] || echo hopperid ;;
  "ps -q --filter label=com.docker.compose.project=hopper --filter label=com.docker.compose.service=postgres") echo pgid ;;
  "ps -q --filter label=com.docker.compose.project=hopper --filter label=com.docker.compose.service="*) ;;
  "inspect --format {{range .Config.Env}}{{println .}}{{end}} hopperid")
    printf 'PATH=/usr/bin\\nHOPPER_MASTER_KEY=%s\\nHOPPER_PORT=4790\\nHOPPER_LAN_NAMES=hopper,box.lan\\nCOMPOSE_PROFILES=%s\\nHOPPER_DATABASE_URL_FILE=/run/x\\nHOPPER_PUBLIC_URL=https://hopper.example\\nCLAUDE_CODE_OAUTH_TOKEN=tok-123\\nHOPPER_LOCAL_MACHINE=false\\n' "\${STUB_LAUNCH_KEY:-}" "\${STUB_PROFILES:-}" ;;
  "inspect --format {{.Config.Image}} hopperid") echo ghcr.io/henningfutrell/hopper:beta ;;
  "inspect --format {{.Image}} hopperid") echo imageid ;;
  "image inspect --format {{range .Config.Env}}{{println .}}{{end}} imageid") printf 'PATH=/usr/bin\\nHOPPER_LOCAL_MACHINE=false\\n' ;;
  "inspect --format {{index .Config.Labels \\"com.docker.compose.service\\"}} hopperid") echo hopper ;;
  "inspect --format {{index .Config.Labels \\"com.docker.compose.service\\"}} pgid") echo postgres ;;
  "exec -i hopperid node -e "*) printf '%s' "$in" | '${process.execPath}' -e "$6" ;;
  "exec hopperid hopper master-key status") printf '{ "source": "given", "fingerprint": "${FP}", "previous": false }\\n' ;;
  "exec pgid pg_dump -U hopper -d hopper -Fc") printf 'DUMP' ;;
  "exec pgid psql -tA -U hopper -d hopper -c "*) echo 42 ;;
  "cp hopperid:/home/node -") tar -cf - -C "$STUB_DIR" node ;;
  stop\\ *) [ "$*" = "stop hopperid" ] || touch "$STUB_DIR/stopped" ;;
esac
exit 0
`;

// The cluster: a release that is not there yet, a Secret store, the chart's postgres and hopper.
const KUBECTL = `#!/bin/bash
in=''
case "$*" in *"create secret generic"*|*"apply -f -"*|*" exec -i "*) in="$(cat)";; esac
printf 'kubectl %s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"create secret generic hopper-master-key --from-file=master-key=/dev/stdin"*) [ "$in" = "$STUB_KEY" ] && echo key-matched >> "$STUB_LOG"; touch "$STUB_DIR/secret" ;;
  *"get secret hopper-master-key"*) [ -f "$STUB_DIR/secret" ] && printf '%s' "$STUB_KEY" | base64 -w0 ;;
  *"create secret generic hopper-carried-env"*) printf 'carried: %s\\n' "$(printf '%s' "$in" | tr '\\n' ' ')" >> "$STUB_LOG"; echo 'kind: Secret' ;;
  version*) [ -z "\${STUB_NO_CLUSTER:-}" ] || exit 1 ;;
  *"wait --for=condition=Ready node"*) exit 0 ;;
  *"exec hopper-postgres-0 -c postgres -- psql -tA"*) echo 42 ;;
  *"exec -i hopper-postgres-0 -c postgres -- pg_restore"*) [ "$in" = DUMP ] && echo restored-dump >> "$STUB_LOG" ;;
  *"get deployment/hopper -o"*) printf 4790 ;;
  *"exec deployment/hopper -c hopper -- node -e fetch('http://127.0.0.1"*) [ -z "\${STUB_UNHEALTHY:-}" ] || exit 1; printf '{"ok":true}' ;;
  *"exec deployment/hopper -c hopper -- hopper master-key status"*) printf '{ "fingerprint": "${FP}" }' ;;
  *"exec -i deployment/hopper -c hopper -- tar"*) [ -n "$in" ] && echo home-copied >> "$STUB_LOG" ;;
esac
exit 0
`;

const HELM = `#!/bin/bash
printf 'helm %s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  status) exit 1 ;;
  install) cat > "$STUB_DIR/values.json" ;;
esac
exit 0
`;

const SYSTEMCTL = `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  "--user cat hopper-compose.service") [ -n "\${STUB_UNIT:-}" ] ;;
  "--user enable --now hopper-k3s.service") printf 'apiVersion: v1\\n' > "$STUB_KUBECONFIG" ;;
  "is-active --quiet k3s") exit 3 ;;
esac
`;

const LOGINCTL = `#!/bin/sh
printf 'loginctl %s\\n' "$*" >> "$STUB_LOG"
[ "$1" = show-user ] && echo yes
exit 0
`;

// Downloads from a folder: the URL's last segment.
const CURL = `#!/bin/bash
printf 'curl %s\\n' "$*" >> "$STUB_LOG"
out=''
url=''
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; -*) ;; *) url=$1 ;; esac; shift; done
f="$STUB_FILES/\${url##*/}"
[ -f "$f" ] || exit 22
if [ -n "$out" ]; then cat "$f" > "$out"; else cat "$f"; fi
`;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const uid = process.getuid?.() ?? 1000;
const delegated = (cgroups: string) => join(cgroups, 'user.slice', `user-${uid}.slice`, `user@${uid}.service`);

function host(o: { unit?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jh-hopper-cluster-')));
  dirs.push(dir);
  writeFileSync(join(dir, 'hopper-cluster.sh'), readFileSync(SCRIPT));
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  const tools: Record<string, string> = { podman: PODMAN, kubectl: KUBECTL, helm: HELM, systemctl: SYSTEMCTL, loginctl: LOGINCTL, curl: CURL, newuidmap: '#!/bin/sh\n', newgidmap: '#!/bin/sh\n', slirp4netns: '#!/bin/sh\n' };
  for (const [name, body] of Object.entries(tools)) { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); }
  const home = join(dir, '.home');
  mkdirSync(join(home, 'node'), { recursive: true });
  writeFileSync(join(home, 'node', '.claude.json'), '{}');
  const state = join(home, 'cluster');
  const files = join(dir, '.files');
  mkdirSync(files);
  const cgroups = join(dir, '.cgroup');
  mkdirSync(delegated(cgroups), { recursive: true });
  writeFileSync(join(cgroups, 'cgroup.controllers'), 'cpu io memory pids');
  writeFileSync(join(delegated(cgroups), 'cgroup.controllers'), 'cpuset cpu io memory pids');
  const log = join(dir, '.calls');
  const chart = join(dir, '.chart');
  mkdirSync(chart);
  writeFileSync(join(chart, 'Chart.yaml'), 'name: hopper\n');
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('/bin/bash', ['hopper-cluster.sh', ...args], {
      cwd: dir, encoding: 'utf8', input: '',
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: home, USER: 'someone', XDG_CONFIG_HOME: join(home, '.config'), HOPPER_CLUSTER_DIR: state,
        HOPPER_CGROUP_ROOT: cgroups, HOPPER_KEY_TTY: '/nonexistent', STUB_LOG: log, STUB_DIR: home, STUB_FILES: files, STUB_KEY: KEY,
        STUB_KUBECONFIG: join(state, 'kubeconfig.yaml'), KUBECONFIG: join(dir, '.kube-none'), ...(o.unit ? { STUB_UNIT: '1' } : {}), ...env,
      },
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '').trim().split('\n').filter(Boolean);
  return { dir, home, state, files, cgroups, chart, run, calls };
}

/** Every file under `dir`, read: none may hold the master key. */
function filesHolding(dir: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (s.isFile() && readFileSync(p).includes(needle)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

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
  const migrate = (h: ReturnType<typeof host>, env: Record<string, string> = {}) => h.run(['migrate', '--chart', h.chart], env);

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
