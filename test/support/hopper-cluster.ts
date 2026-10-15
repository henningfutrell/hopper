// The host scripts/hopper-cluster.sh runs on in its tests (test/scripts/hopper-cluster*.test.ts): podman, kubectl, helm,
// systemctl, loginctl and curl are stubs on PATH that record each call (never the master key: a stub that reads it records
// only whether it matched), so no cluster, container or unit of this machine is touched.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintOf, shortFingerprint } from '../../src/secrets/master-key.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const SCRIPT = join(ROOT, 'scripts', 'hopper-cluster.sh');
export const KEY = 'f00dfeed'.repeat(8);
// The running hopper's: the fingerprint the script works out in the hopper's container must be the hopper's own.
export const FP = shortFingerprint(fingerprintOf(KEY));
const dirs: string[] = [];

/** Removes every host made since the last call: each test file calls it in afterEach. */
export function removeHosts(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

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
  *"get secret owner-key -o go-template="*) [ -z "\${STUB_OWNER_SECRET:-}" ] || printf yes ;;
  *"get secret hopper-master-key -o go-template="*) printf yes ;;
  *"run hopper-key-check "*) printf '%s' "\${STUB_SECRET_FP:-${FP}}" ;;
  *"get deployment/hopper -o jsonpath={.spec.template.spec.containers[?(@.name==\\"hopper\\")].image}"*) printf ghcr.io/henningfutrell/hopper:beta ;;
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

export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const uid = process.getuid?.() ?? 1000;
export const delegated = (cgroups: string) => join(cgroups, 'user.slice', `user-${uid}.slice`, `user@${uid}.service`);

export function host(o: { unit?: boolean } = {}) {
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
export function filesHolding(dir: string, needle: string): string[] {
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
/** `migrate` with the stub chart. */
export const migrate = (h: ReturnType<typeof host>, env: Record<string, string> = {}, args: string[] = []) => h.run(['migrate', '--chart', h.chart, ...args], env);

