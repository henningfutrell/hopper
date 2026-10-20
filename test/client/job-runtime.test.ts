// The job's own container runtime (issue #1295, design.md "Work tree" → "The job's container runtime"), run for real: the
// setup a job's shell runs, the guards it puts first on PATH, the reap and the survey, with a stand-in podman and docker
// first on PATH and a stand-in for the user's runtime dir (its bus a real socket). A job's runtime is never the host's: a
// `podman system reset` in a job is refused whatever the job did to HOME or XDG_*, and the reap resets only the job's.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, readSurvey, reapArgv, surveyArgv } from '../../src/client/reap.ts';
import { guardsCommand, guardsOutcome, runtimeCommand, runtimeOutcome, runtimeSetupArgv, setupCommand } from '../../src/client/job-runtime.ts';
import { TERMINAL_LINE_MAX } from '../../src/executors/herdr/client.ts';

const JOB = 'job-1295-abcdef';

// The stand-in runtime: each call logged to $FAKE/calls with the runtime it was given; `ps -aq` and `volume ls -q` answer
// $FAKE/containers and $FAKE/volumes; `system reset` records the storage config it read and removes the storage it was named.
const FAKE_RUNTIME = `#!/bin/sh
n=\${0##*/}
printf '%s %s | XDG_RUNTIME_DIR=%s DOCKER_HOST=%s CONTAINER_HOST=%s\\n' "$n" "$*" "$XDG_RUNTIME_DIR" "$DOCKER_HOST" "\${CONTAINER_HOST-unset}" >> "$FAKE/calls"
st=; [ "$1" = --root ] && st=$2
case "$*" in
  *" ps -aq") cat "$FAKE/containers" 2>/dev/null;;
  *" volume ls -q") cat "$FAKE/volumes" 2>/dev/null;;
  *"system reset --force") grep graphroot "$CONTAINERS_STORAGE_CONF" >> "$FAKE/reset"; [ -n "$st" ] && rm -rf "$st";;
esac
exit 0
`;

let root: string;
let fake: string;
let host: string;
let work: string;
let scratch: string;
let bus: Server;
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hopper-jrt-'));
  fake = join(root, 'bin');
  host = join(root, 'run');
  work = join(root, 'work');
  scratch = join(work, '.worktrees', '@scratch', JOB);
  for (const d of [fake, join(host, 'systemd'), scratch]) mkdirSync(d, { recursive: true });
  for (const n of ['podman', 'docker']) writeFileSync(join(fake, n), FAKE_RUNTIME, { mode: 0o755 });
  writeFileSync(join(fake, 'calls'), '');
  // The user's systemd stays out of reach: the test's bus never answers, and a real systemctl waits on it.
  writeFileSync(join(fake, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // What stands for the hopper stack's runtime state in the user's runtime dir.
  mkdirSync(join(host, 'containers'));
  writeFileSync(join(host, 'containers', 'hopper-stack'), 'running');
  bus = createServer();
  await new Promise<void>((done) => bus.listen(join(host, 'bus'), done));
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  await new Promise<void>((done) => bus.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

const PATH = (): string => `${fake}${delimiter}/usr/bin${delimiter}/bin`;
const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ HOME: root, PATH: PATH(), FAKE: fake, XDG_RUNTIME_DIR: host, ...more });
const run = (argv: string[], e = env()): string => {
  const [file, ...args] = argv;
  return execFileSync(file!, args, { encoding: 'utf8', env: e, timeout: 30000 });
};
const calls = (): string[] => readFileSync(join(fake, 'calls'), 'utf8').split('\n').filter(Boolean);
const own = (): string => join(host, `hopper-runtime-${JOB}`);
const containers = (): string => join(scratch, 'containers');

/** A job's shell: the runtime command run in sh, then `script` in the same shell. */
function inJobShell(script: string, e = env()): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('sh', ['-c', `${runtimeCommand(JOB, scratch, false)} >/dev/null; ${script}`], { encoding: 'utf8', env: e, timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('a job gets a container runtime of its own (issue #1295)', () => {
  it('its runtime dir in the user\'s, only its own, its storage in the scratch dir, its socket started in its environment', () => {
    expect(run(runtimeSetupArgv(JOB, scratch, true)).trim()).toBe('own');
    expect(statSync(own()).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(containers(), 'storage.conf'), 'utf8')).toContain(`graphroot = "${containers()}/storage"`);
    expect(readFileSync(join(containers(), 'storage.conf'), 'utf8')).toContain(`runroot = "${own()}/storage"`);
    // Rootless Podman 4 reads no graphroot from a storage config that is not the user's own: only this.
    expect(readFileSync(join(containers(), 'storage.conf'), 'utf8')).toContain(`rootless_storage_path = "${containers()}/storage"`);
    expect(readFileSync(join(containers(), 'containers.conf'), 'utf8')).toContain(`tmp_dir = "${own()}/libpod/tmp"`);
    // The user's bus is the same socket, so podman's network helpers reach systemd from inside its own /run.
    expect(statSync(join(own(), 'bus')).ino).toBe(statSync(join(host, 'bus')).ino);
    expect(readFileSync(join(own(), 'scratch'), 'utf8').trim()).toBe(scratch);
    const sock = `unix://${own()}/podman/podman.sock`;
    // The socket starts in the background: wait for its call.
    for (let i = 0; i < 50 && !calls().some((c) => c.includes('system service')); i++) spawnSync('sleep', ['0.1']);
    expect(calls()).toContainEqual(`podman system service --time=0 ${sock} | XDG_RUNTIME_DIR=${own()} DOCKER_HOST=${sock} CONTAINER_HOST=unset`);
  });

  it('the shell sees the job\'s runtime, the guards first on PATH, no other runtime named', () => {
    const r = inJobShell('printf "%s\\n" "$XDG_RUNTIME_DIR" "$DOCKER_HOST" "${CONTAINER_HOST-unset}" "${DOCKER_CONTEXT-unset}" "$(command -v podman)" "$DBUS_SESSION_BUS_ADDRESS"',
      env({ CONTAINER_HOST: 'unix:///elsewhere.sock', DOCKER_CONTEXT: 'host' }));
    expect(r.stdout.trim().split('\n')).toEqual([own(), `unix://${own()}/podman/podman.sock`, 'unset', 'unset', join(containers(), 'bin', 'podman'), `unix:path=${own()}/bus`]);
  });

  it('a machine with no podman: no runtime, and DOCKER_HOST names a socket that is not there, never the host\'s', () => {
    rmSync(join(fake, 'podman'));
    // A PATH with only the tools the setup needs, so a podman of this machine's is not found either.
    const tools = join(root, 'tools');
    mkdirSync(tools);
    for (const t of ['sh', 'mkdir', 'chmod', 'ln', 'id']) symlinkSync(execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(), join(tools, t));
    const r = spawnSync('sh', ['-c', `${runtimeCommand(JOB, scratch, true)}; docker ps`], { encoding: 'utf8', env: env({ DOCKER_HOST: 'unix:///run/docker.sock', PATH: `${fake}${delimiter}${tools}` }) });
    expect(runtimeOutcome(r.stdout)).toBe('none');
    expect(existsSync(own())).toBe(false);
    const dockerHost = `unix://${containers()}/no-container-runtime.sock`;
    expect(calls()).toEqual([`docker ps | XDG_RUNTIME_DIR=${host} DOCKER_HOST=${dockerHost} CONTAINER_HOST=unset`]);
  });

  it('a runtime dir the user does not have: no runtime either', () => {
    const r = spawnSync('sh', ['-c', runtimeCommand(JOB, scratch, false)], { encoding: 'utf8', env: env({ XDG_RUNTIME_DIR: join(root, 'missing') }) });
    expect(runtimeOutcome(r.stdout)).toBe('none');
  });
});

describe('a pane sets the runtime up in two steps, each one a terminal line keeps (issue #2234)', () => {
  it('each step fits a terminal line, even with a long work tree', () => {
    const long = `/home/agent/${'w'.repeat(120)}/.worktrees/@scratch/${'0'.repeat(8)}-0000-0000-0000-000000000000`;
    expect(guardsCommand(long).length).toBeLessThanOrEqual(TERMINAL_LINE_MAX);
    expect(setupCommand('00000000-0000-0000-0000-000000000000', long, true).length).toBeLessThanOrEqual(TERMINAL_LINE_MAX);
  });

  it('the guards step writes podman and docker; the setup step then gives the job its runtime', () => {
    const guards = spawnSync('sh', ['-c', guardsCommand(scratch)], { encoding: 'utf8', env: env() });
    expect(guardsOutcome(guards.stdout)).toBe('written');
    for (const n of ['podman', 'docker']) expect(statSync(join(containers(), 'bin', n)).mode & 0o111).toBe(0o111);
    const setUp = spawnSync('sh', ['-c', setupCommand(JOB, scratch, false)], { encoding: 'utf8', env: env() });
    expect(runtimeOutcome(setUp.stdout)).toBe('own');
  });

  it('the setup step with no guards written fails: the job never runs without them', () => {
    const r = spawnSync('sh', ['-c', setupCommand(JOB, scratch, false)], { encoding: 'utf8', env: env() });
    expect(runtimeOutcome(r.stdout)).toBe('failed');
  });
});

describe('the guards: podman and docker in a job use only its own runtime (issue #1295)', () => {
  it('podman system reset --force is refused, whatever HOME and XDG_* the job set; nothing reaches podman', () => {
    const r = inJobShell(`HOME=${root}/h XDG_DATA_HOME=${root}/d XDG_RUNTIME_DIR=${host} podman system reset --force`);
    expect(r.status).toBe(126);
    expect(r.stderr).toContain('system reset: refused in a job');
    expect(calls()).toEqual([]);
    expect(readFileSync(join(host, 'containers', 'hopper-stack'), 'utf8')).toBe('running');
  });

  it('so are migrate and renumber, and a reset after global options', () => {
    for (const cmd of ['podman system migrate', 'podman system renumber', 'podman --log-level debug system --help reset', 'podman --log-level=debug system reset -f']) {
      expect(inJobShell(cmd).status, cmd).toBe(126);
    }
    expect(calls()).toEqual([]);
  });

  it('a global flag that names another runtime or its storage is refused', () => {
    for (const cmd of ['podman --url unix:///run/podman.sock ps', 'podman --connection=host ps', 'podman -r ps', 'podman --root /host ps', 'podman --runroot=/run/user/1 ps',
      'podman --tmpdir /x ps', 'docker -H unix:///var/run/docker.sock ps', 'docker --host=tcp://h ps', 'docker --context host ps', 'docker -c host ps']) {
      expect(inJobShell(cmd).status, cmd).toBe(126);
    }
    expect(calls()).toEqual([]);
  });

  it('an argument that names the host\'s runtime, its storage or a host socket is refused: a job never mounts or dials it', () => {
    for (const cmd of [`podman run -v ${host}/podman/podman.sock:/run/podman.sock img`, 'docker run -v /var/run/docker.sock:/var/run/docker.sock img',
      `podman run --volume=${host}/containers:/c img`, 'podman run -v /run/podman/podman.sock:/s img', `podman run -v ${root}/.local/share/containers/storage:/s img`,
      `docker run --mount type=bind,src=${host}/docker.sock,dst=/d img`]) {
      const r = inJobShell(cmd);
      expect(r.status, cmd).toBe(126);
      expect(r.stderr, cmd).toContain('the host\'s container runtime');
    }
    expect(calls()).toEqual([]);
  });

  it('what a job makes carries its job label; its own socket may be named', () => {
    const r = inJobShell([
      'podman run --rm img echo hi', 'podman --log-level debug container create --name c img', 'podman pod create --name p', 'podman volume create v',
      'podman network create kind', 'docker run -d img', `podman run -v ${own()}/podman/podman.sock:/s img`, 'podman ps --filter label=x',
    ].join(' && '));
    expect(r.status).toBe(0);
    const label = `--label hopper.job=${JOB}`;
    expect(calls().map((c) => c.slice(0, c.indexOf(' | ')))).toEqual([
      `podman run ${label} --rm img echo hi`, `podman --log-level debug container create ${label} --name c img`, `podman pod create ${label} --name p`,
      `podman volume create ${label} v`, `podman network create ${label} kind`, `docker run ${label} -d img`,
      `podman run ${label} -v ${own()}/podman/podman.sock:/s img`, 'podman ps --filter label=x',
    ]);
  });

  it('podman\'s health check timers run on the job\'s runtime: its systemd-run gives them the job\'s variables; any other call is as it was', () => {
    writeFileSync(join(fake, 'systemd-run'), '#!/bin/sh\nprintf "systemd-run %s\\n" "$*" >> "$FAKE/calls"\n', { mode: 0o755 });
    const r = inJobShell('systemd-run --property LogLevelMax=notice --user --unit abc /usr/bin/podman --root /s healthcheck run --ignore-result abc'
      + ' && systemd-run --scope --user -p Delegate=yes kind create cluster', env({ PATH: `${fake}${delimiter}/usr/bin${delimiter}/bin` }));
    expect(r.status).toBe(0);
    expect(calls()).toEqual([
      `systemd-run --setenv=XDG_RUNTIME_DIR=${own()} --setenv=CONTAINERS_CONF_OVERRIDE=${containers()}/containers.conf --setenv=CONTAINERS_STORAGE_CONF=${containers()}/storage.conf`
        + ` --setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=${own()}/bus --property LogLevelMax=notice --user --unit abc /usr/bin/podman --root /s healthcheck run --ignore-result abc`,
      'systemd-run --scope --user -p Delegate=yes kind create cluster',
    ]);
  });

  it('anything else runs on the job\'s runtime, whatever the caller set, with its arguments as they are but for the job label', () => {
    const r = inJobShell(`XDG_RUNTIME_DIR=${host} DOCKER_HOST=unix://${host}/podman/podman.sock CONTAINER_HOST=x podman ps -a && podman run --rm img system reset && docker ps`);
    expect(r.status).toBe(0);
    const sock = `unix://${own()}/podman/podman.sock`;
    expect(calls()).toEqual([
      `podman ps -a | XDG_RUNTIME_DIR=${own()} DOCKER_HOST=${sock} CONTAINER_HOST=unset`,
      `podman run --label hopper.job=${JOB} --rm img system reset | XDG_RUNTIME_DIR=${own()} DOCKER_HOST=${sock} CONTAINER_HOST=unset`,
      `docker ps | XDG_RUNTIME_DIR=${own()} DOCKER_HOST=${sock} CONTAINER_HOST=unset`,
    ]);
  });
});

describe('the reap resets the job\'s runtime and only it (issue #1295)', () => {
  beforeEach(() => {
    run(runtimeSetupArgv(JOB, scratch, false));
    mkdirSync(join(containers(), 'storage', 'overlay'), { recursive: true });
    writeFileSync(join(fake, 'containers'), 'kindnode01\nryuk0002\n');
    writeFileSync(join(fake, 'volumes'), 'kindvol\n');
  });

  it('names its containers and volumes as removed, resets its storage, removes its runtime dir; the host\'s stays', () => {
    const said = readReap(run(reapArgv(JOB, scratch)));
    expect(said?.removed).toEqual({ containers: ['kindnode01', 'ryuk0002'], volumes: ['kindvol'] });
    const reset = calls().find((c) => c.includes('system reset --force'));
    // No --runroot: Podman 4 refuses one longer than 50 characters, and the runtime dir's is; storage.conf names it.
    expect(reset).toBe(`podman --root ${containers()}/storage --tmpdir ${own()}/libpod/tmp system reset --force | XDG_RUNTIME_DIR=${own()} DOCKER_HOST= CONTAINER_HOST=unset`);
    expect(existsSync(join(containers(), 'storage'))).toBe(false);
    expect(existsSync(own())).toBe(false);
    expect(readFileSync(join(host, 'containers', 'hopper-stack'), 'utf8')).toBe('running');
    expect(existsSync(join(host, 'bus'))).toBe(true);
  });

  it('stops what of its containers the reset could not: their health check timers and scopes, by their ids', () => {
    writeFileSync(join(fake, 'systemctl'), '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$FAKE/calls"\n', { mode: 0o755 });
    run(reapArgv(JOB, scratch));
    expect(calls()).toContain('systemctl --user stop kindnode01*.timer kindnode01*.service ryuk0002*.timer ryuk0002*.service');
    expect(calls()).toContain('systemctl --user kill -s KILL libpod-kindnode01*.scope libpod-conmon-kindnode01*.scope libpod-ryuk0002*.scope libpod-conmon-ryuk0002*.scope');
  });

  it('a job that pointed its storage config at the host\'s storage: the reap writes it again first', () => {
    writeFileSync(join(containers(), 'storage.conf'), `[storage]\ngraphroot = "${host}"\nrunroot = "${host}"\n`);
    run(reapArgv(JOB, scratch));
    expect(readFileSync(join(fake, 'reset'), 'utf8').trim()).toBe(`graphroot = "${containers()}/storage"`);
  });

  it('with no scratch dir given, the one the runtime dir names', () => {
    readReap(run(reapArgv(JOB)));
    expect(calls().some((c) => c.startsWith(`podman --root ${containers()}/storage `))).toBe(true);
    expect(existsSync(own())).toBe(false);
  });

  it('a runtime dir that names another job\'s scratch dir: no reset, the dir removed', () => {
    writeFileSync(join(own(), 'scratch'), `${work}/.worktrees/@scratch/another-job\n`);
    run(reapArgv(JOB));
    expect(calls().some((c) => c.includes('system reset'))).toBe(false);
    expect(existsSync(own())).toBe(false);
  });

  it('stops what still runs from the job\'s runtime dir, never anything else', async () => {
    const mine = spawn('sleep', ['60'], { env: { ...env(), XDG_RUNTIME_DIR: own() }, stdio: 'ignore' });
    const other = spawn('sleep', ['60'], { env: env(), stdio: 'ignore' });
    children.push(mine, other);
    const ended = new Promise((done) => mine.once('exit', done));
    run(reapArgv(JOB, scratch));
    await ended;
    expect(mine.exitCode ?? mine.signalCode).toBe('SIGKILL');
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
  });

  it('a timed-out job\'s reap (keep) leaves its runtime: it may go on there', () => {
    run(reapArgv(JOB, scratch, true));
    expect(existsSync(own())).toBe(true);
    expect(calls().some((c) => c.includes('system reset'))).toBe(false);
  });

  it('the survey names the job while its runtime dir is there, and not after the reap', () => {
    expect(readSurvey(run(surveyArgv([])))?.containers).toContain(JOB);
    run(reapArgv(JOB, scratch));
    expect(readSurvey(run(surveyArgv([])))?.containers).not.toContain(JOB);
  });
});
