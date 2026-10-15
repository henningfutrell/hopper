// The migration check (issue #1373, docs/kubernetes.md "Check it on kind"): a seeded compose install moved onto a fresh
// kind cluster by scripts/hopper-cluster.sh, end to end. It starts the compose stack of compose.yaml (the project
// `hopper`, a master key given at launch), adds a user, makes the cluster, and runs `hopper-cluster.sh migrate`. Then the
// cluster hopper must be healthy and hold the user, and the compose stack's containers, volumes and images must be the
// ones from before (stopped, not removed). Then `hopper-cluster.sh rollback` must bring the compose hopper back, healthy.
// At the end it deletes the cluster and the compose stack it made. Needs `kind`, `helm`, `kubectl`, and Docker with its
// compose plugin, or Podman with KIND_EXPERIMENTAL_PROVIDER=podman and `podman compose`.
//
//   node scripts/kind-migrate-check.ts [--cluster NAME] [--tag TAG] [--keep]
//
// --cluster names the kind cluster (default hopper-migrate-check), --tag the hopper's image tag (default latest), --keep
// keeps the cluster and the compose stack at the end. It refuses to run where a compose project `hopper` is there already:
// the migration would move that one. Exit 0 when the check passes, 1 when not, 2 when it refused.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = join(import.meta.dirname, '..');
const CHART = join(ROOT, 'deploy', 'helm', 'hopper');
const SCRIPT = join(ROOT, 'scripts', 'hopper-cluster.sh');
const PROJECT = 'hopper';
const NAMESPACE = 'hopper';
const USER = 'migrated-user';

interface Run { status: number | null; stdout: string }

function sh(cmd: string, args: string[], o: { capture?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', cwd: o.cwd, env: o.env ?? process.env,
    stdio: o.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '' };
}

const lines = (r: Run): string[] => r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).sort();

/** The compose stack's containers, volumes, and every image: what the migration must leave as it found it. */
function snapshot(runtime: string): { containers: string[]; volumes: string[]; images: string[] } {
  return {
    containers: lines(sh(runtime, ['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${PROJECT}`], { capture: true })),
    volumes: lines(sh(runtime, ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`], { capture: true })),
    images: lines(sh(runtime, ['images', '-q', '--no-trunc'], { capture: true })),
  };
}

/** The compose hopper's health, asked in its container, until it is ok or `seconds` pass. */
function composeHealthy(runtime: string, seconds: number): boolean {
  const health = "fetch('http://127.0.0.1:' + (process.env.HOPPER_PORT || 4790) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))";
  for (let waited = 0; waited <= seconds; waited += 5) {
    const id = lines(sh(runtime, ['ps', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--filter', 'label=com.docker.compose.service=hopper'], { capture: true }))[0];
    if (id && sh(runtime, ['exec', id, 'node', '-e', health]).status === 0) return true;
    spawnSync('sleep', ['5']);
  }
  return false;
}

/** The check. Answers what failed, or null. */
function check(o: { runtime: string; dir: string; cluster: string; tag: string; state: string }): string | null {
  const kubeconfig = join(o.state, 'kind.kubeconfig');
  const key = randomBytes(32).toString('hex');
  const env = { ...process.env, HOPPER_IMAGE: `ghcr.io/henningfutrell/hopper:${o.tag}`, HOPPER_MASTER_KEY: key };
  if (sh(o.runtime, ['compose', '-p', PROJECT, 'up', '-d'], { cwd: o.dir, env }).status !== 0) return 'compose up failed';
  if (!composeHealthy(o.runtime, 600)) return 'the compose hopper did not get healthy';
  if (sh(o.runtime, ['compose', '-p', PROJECT, 'exec', '-T', 'hopper', 'hopper', 'user', 'add', USER], { cwd: o.dir, env }).status !== 0) return 'the seed (hopper user add) failed';

  if (sh('kind', ['create', 'cluster', '--name', o.cluster, '--kubeconfig', kubeconfig, '--wait', '5m']).status !== 0) return 'kind create cluster failed';
  const before = snapshot(o.runtime);

  // The migration, as a person runs it: in the compose folder, the key only in the hopper's launch environment.
  const { HOPPER_MASTER_KEY: _given, ...outside } = process.env;
  const run = { ...outside, KUBECONFIG: kubeconfig, HOPPER_CLUSTER_DIR: o.state };
  if (sh('bash', [join(o.dir, 'hopper-cluster.sh'), 'migrate', '--chart', CHART], { cwd: o.dir, env: run }).status !== 0) return 'hopper-cluster.sh migrate failed';

  const kubectl = (args: string[]) => sh('kubectl', ['--kubeconfig', kubeconfig, '--namespace', NAMESPACE, ...args], { capture: true });
  const users = kubectl(['exec', 'deploy/hopper', '-c', 'hopper', '--', 'hopper', 'users']);
  if (users.status !== 0 || !users.stdout.includes(USER)) return `the cluster hopper does not hold the seeded user: ${users.stdout.trim()}`;
  console.log(`users in the cluster: ${users.stdout.trim()}`);

  const after = snapshot(o.runtime);
  for (const part of ['containers', 'volumes', 'images'] as const) {
    if (JSON.stringify(before[part]) !== JSON.stringify(after[part])) return `the migration changed the host's ${part}: ${JSON.stringify(before[part])} → ${JSON.stringify(after[part])}`;
  }
  if (lines(sh(o.runtime, ['ps', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`], { capture: true })).length > 0) return 'the compose stack still runs after the cutover';

  if (sh('bash', [join(o.dir, 'hopper-cluster.sh'), 'rollback'], { cwd: o.dir, env: run }).status !== 0) return 'hopper-cluster.sh rollback failed';
  if (!composeHealthy(o.runtime, 300)) return 'the compose hopper is not healthy after the rollback';
  const scaled = kubectl(['get', 'deploy/hopper', '-o', 'jsonpath={.spec.replicas}']);
  if (scaled.stdout.trim() !== '0') return `the cluster hopper is not at 0 after the rollback: ${scaled.stdout.trim()}`;
  return null;
}

function main(): number {
  const { values } = parseArgs({ options: { cluster: { type: 'string' }, tag: { type: 'string' }, keep: { type: 'boolean' } } });
  const cluster = values.cluster ?? 'hopper-migrate-check';
  const runtime = process.env.KIND_EXPERIMENTAL_PROVIDER === 'podman' ? 'podman' : 'docker';
  // Never a stack that is there already: the migration would move it, and the clean-up remove it.
  const there = sh(runtime, ['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`], { capture: true });
  if (there.status !== 0) { console.error(`kind-migrate-check: ${runtime} does not answer`); return 2; }
  if (lines(there).length > 0) {
    console.error(`kind-migrate-check: a compose project ${PROJECT} is there already in ${runtime}: the check would move it. Run it where none is (a CI runner, a throwaway machine)`);
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), 'hopper-migrate-check-'));
  const state = join(dir, '.cluster');
  copyFileSync(join(ROOT, 'compose.yaml'), join(dir, 'compose.yaml'));
  copyFileSync(SCRIPT, join(dir, 'hopper-cluster.sh'));
  let failed: string | null;
  try {
    failed = check({ runtime, dir, cluster, tag: values.tag ?? 'latest', state });
  } finally {
    if (!values.keep) {
      sh('kind', ['delete', 'cluster', '--name', cluster]);
      sh(runtime, ['compose', '-p', PROJECT, 'down', '-v'], { cwd: dir, env: { ...process.env, HOPPER_MASTER_KEY: '' } });
      rmSync(dir, { recursive: true, force: true });
    } else {
      console.log(`kept: the kind cluster ${cluster} and the compose stack in ${dir}`);
    }
  }
  if (failed) { console.error(`kind-migrate-check: FAILED: ${failed}`); return 1; }
  console.log('kind-migrate-check: passed');
  return 0;
}

if (import.meta.main) process.exitCode = main();
