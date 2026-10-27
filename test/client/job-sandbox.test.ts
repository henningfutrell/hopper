// The job's sandbox (issue #1295, design.md "Each job its own container runtime" → "The sandbox"), run for real with the
// machine's bubblewrap: Claude, and all it runs, in mount, PID and IPC namespaces of their own, where the user's runtime dir
// holds only the job's own runtime, the user's container storage and the host's container sockets are empty, the user's
// bus and herdr's sockets are gone, and no process of the host shows. A job that wipes what it sees as the user's runtime
// dir leaves the real one as it was. With a stand-in podman, claude and user runtime dir; skipped where bubblewrap cannot run.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeCommand } from '../../src/client/job-runtime.ts';
import { egressOutcome, sandboxCommand, sandboxOutcome, sandboxSetupArgv } from '../../src/client/job-sandbox.ts';
import { TERMINAL_LINE_MAX } from '../../src/executors/herdr/client.ts';

const JOB = 'job-1295-sandbox';

/** Whether bubblewrap runs here as the sandbox needs it: no bwrap, or no user namespaces (a container), is an environment skip. */
const bwrapRuns = spawnSync('bwrap', ['--dev-bind', '/', '/', '--proc', '/proc', '--unshare-pid', '--unshare-ipc', '--die-with-parent', 'true']).status === 0;
/** Whether it makes a network namespace too, as a confined job's sandbox needs (issue #2849 part 4). */
const netnsRuns = bwrapRuns && spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-net', '--die-with-parent', 'true']).status === 0;

// The stand-in podman: each call logged to $FAKE/calls with the runtime it was given.
const FAKE_PODMAN = `#!/bin/sh
printf '%s %s | CONTAINER_HOST=%s\\n' "\${0##*/}" "$*" "\${CONTAINER_HOST-unset}" >> "$FAKE/calls"
`;
// The stand-in claude: what it sees, one line each, then its arguments.
const FAKE_CLAUDE = `#!/bin/sh
printf 'sandboxed=%s\\n' "\${HOPPER_SANDBOXED-no}"
printf 'args=%s\\n' "$*"
`;

let root: string;
let fake: string;
let host: string;
let scratch: string;
let bus: Server;
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hopper-jsb-'));
  fake = join(root, 'bin');
  host = join(root, 'run');
  scratch = join(root, 'work', '.worktrees', '@scratch', JOB);
  for (const d of [fake, join(host, 'systemd'), scratch]) mkdirSync(d, { recursive: true });
  for (const n of ['podman', 'docker']) writeFileSync(join(fake, n), FAKE_PODMAN, { mode: 0o755 });
  writeFileSync(join(fake, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  writeFileSync(join(fake, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(fake, 'calls'), '');
  // What stands for the hopper stack's runtime state in the user's runtime dir, and for the user's container storage.
  mkdirSync(join(host, 'containers'));
  writeFileSync(join(host, 'containers', 'hopper-stack'), 'running');
  mkdirSync(join(root, '.local', 'share', 'containers', 'storage'), { recursive: true });
  writeFileSync(join(root, '.local', 'share', 'containers', 'storage', 'db.sql'), 'the stack');
  // herdr's sockets: a job that reaches them types into panes outside the sandbox.
  mkdirSync(join(root, '.config', 'herdr', 'sessions', 'hopper'), { recursive: true });
  writeFileSync(join(root, '.config', 'herdr', 'sessions', 'hopper', 'herdr.sock'), 'herdr');
  bus = createServer();
  await new Promise<void>((done) => bus.listen(join(host, 'bus'), done));
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  await new Promise<void>((done) => bus.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HOME: root, PATH: `${fake}${delimiter}/usr/bin${delimiter}/bin`, FAKE: fake, XDG_RUNTIME_DIR: host,
  HERDR_SOCKET_PATH: join(root, '.config', 'herdr', 'sessions', 'hopper', 'herdr.sock'), ...more,
});
/** A node on the stand-ins' PATH: the setup routes a job only where node runs hopper-egress. */
const withNode = (): void => writeFileSync(join(fake, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`, { mode: 0o755 });
const own = (): string => join(host, `hopper-runtime-${JOB}`);
const calls = (): string[] => readFileSync(join(fake, 'calls'), 'utf8').split('\n').filter(Boolean);

/** A job's pane shell: its runtime set up, then its sandbox, then `script` in the same shell (claude started there). */
function inJobShell(script: string, e = env()): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('sh', ['-c', `${runtimeCommand(JOB, scratch, false)} >/dev/null; ${sandboxCommand(scratch)} >/dev/null; ${script}`],
    { encoding: 'utf8', env: e, timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** What `script` prints run as a job's claude runs: the sandbox's runner around `sh -c`. */
function inSandbox(script: string, e = env()): { status: number | null; stdout: string; stderr: string } {
  return inJobShell(`"${scratch}/sandbox/run" sh -c '${script.replace(/'/g, `'\\''`)}'`, e);
}

describe.skipIf(!bwrapRuns)('the job\'s sandbox (issue #1295)', () => {
  it('its setup says on, and puts its claude first on the shell\'s PATH', () => {
    const r = spawnSync('sh', ['-c', `${runtimeCommand(JOB, scratch, false)} >/dev/null; ${sandboxCommand(scratch)}; command -v claude`], { encoding: 'utf8', env: env() });
    expect(sandboxOutcome(r.stdout)).toBe('on');
    expect(r.stdout.trim().split('\n').at(-1)).toBe(join(scratch, 'sandbox', 'bin', 'claude'));
    expect(statSync(join(scratch, 'sandbox', 'run')).mode & 0o111).toBeTruthy();
  });

  it('claude, as herdr starts it, runs the real one in the sandbox with its arguments', () => {
    const r = inJobShell('claude --model haiku --session-id "a b"');
    expect(r.stdout.trim().split('\n')).toEqual(['sandboxed=1', 'args=--model haiku --session-id a b']);
  });

  it('the user\'s runtime dir holds only the job\'s own runtime; the stack\'s state is not there', () => {
    const r = inSandbox(`ls -A "${host}"; [ -e "${host}/containers/hopper-stack" ] && echo stack-seen; [ -S "${own()}/bus" ] && echo bus-seen; [ -d "${own()}/podman" ] && echo own-podman; printf "%s\\n" "$XDG_RUNTIME_DIR"`);
    expect(r.stdout.trim().split('\n')).toEqual([`hopper-runtime-${JOB}`, 'own-podman', own()]);
  });

  it('a job that wipes the user\'s runtime dir, whatever HOME and XDG_* say, leaves the real one as it was', () => {
    const r = inSandbox(`HOME=/x XDG_DATA_HOME=/y XDG_RUNTIME_DIR="${host}" rm -rf "${host}"/* "${root}/.local/share/containers"/*; echo wiped`);
    expect(r.stdout.trim()).toBe('wiped');
    expect(readFileSync(join(host, 'containers', 'hopper-stack'), 'utf8')).toBe('running');
    expect(existsSync(join(host, 'bus'))).toBe(true);
    expect(readFileSync(join(root, '.local', 'share', 'containers', 'storage', 'db.sql'), 'utf8')).toBe('the stack');
  });

  it('the user\'s container storage and herdr\'s sockets are not in it', () => {
    const r = inSandbox(`ls -A "${root}/.local/share/containers"; [ -e "${root}/.config/herdr/sessions/hopper/herdr.sock" ] && echo herdr-seen; echo end`);
    expect(r.stdout.trim()).toBe('end');
  });

  it('no process of the host shows in it', () => {
    const outside = spawn('sleep', ['30']);
    children.push(outside);
    const r = inSandbox(`kill -0 ${outside.pid} 2>/dev/null && echo seen; ls /proc | grep -c "^[0-9]"`);
    expect(r.stdout).not.toContain('seen');
    expect(Number(r.stdout.trim())).toBeLessThan(10);
  });

  it('podman in it reaches the job\'s own socket, as a remote client; outside it, as before', () => {
    const r = inSandbox('podman ps -a');
    expect(r.status).toBe(0);
    expect(calls()).toEqual([`podman ps -a | CONTAINER_HOST=unix://${own()}/podman/podman.sock`]);
    expect(inJobShell('podman ps').status).toBe(0);
    expect(calls().at(-1)).toBe('podman ps | CONTAINER_HOST=unset');
  });

  it('podman system reset in it is still refused', () => {
    const r = inSandbox(`HOME=/x XDG_RUNTIME_DIR="${host}" podman system reset --force`);
    expect(r.status).toBe(126);
    expect(calls()).toEqual([]);
  });

  it('a sandbox inside the sandbox is the same one: the runner runs its command as it is', () => {
    const r = inSandbox(`"${scratch}/sandbox/run" sh -c "echo \\$HOPPER_SANDBOXED; ls -A \\"${host}\\""`);
    expect(r.stdout.trim().split('\n')).toEqual(['1', `hopper-runtime-${JOB}`]);
  });

  it('with the egress route on, claude runs in the sandbox behind hopper-egress; with it off, or no hopper-egress, as before (issue #2849)', () => {
    // The stand-in hopper-egress: it says what it was given, then runs the command after `--` with its port set.
    const egress = join(root, 'egress');
    writeFileSync(egress, '#!/bin/sh\nprintf "egress %s\\n" "$1"\nshift\nHOPPER_EGRESS_PORT=1 exec "$@"\n', { mode: 0o755 });
    withNode();
    const on = inJobShell('claude --model haiku', env({ HOPPER_EGRESS: egress, HOPPER_EGRESS_ROUTE: '1' }));
    expect(on.stdout.trim().split('\n')).toEqual(['egress --', 'sandboxed=1', 'args=--model haiku']);
    expect(inJobShell('claude --model haiku', env({ HOPPER_EGRESS: egress })).stdout.trim().split('\n')).toEqual(['sandboxed=1', 'args=--model haiku']);
    expect(inJobShell('claude --model haiku', env({ HOPPER_EGRESS: join(root, 'none'), HOPPER_EGRESS_ROUTE: '1' })).stdout.trim().split('\n')).toEqual(['sandboxed=1', 'args=--model haiku']);
  });

  it('the setup says the job\'s egress only when its setting routes it: routed, unrouted with no hopper-egress, and routed with confine where no network namespace holds (issue #2849)', () => {
    const egress = join(root, 'egress');
    writeFileSync(egress, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    withNode();
    const said = (more: NodeJS.ProcessEnv): string | undefined => egressOutcome(spawnSync('sh', ['-c', sandboxCommand(scratch)], { encoding: 'utf8', env: env(more) }).stdout);
    expect(said({ HOPPER_EGRESS: egress })).toBeUndefined();
    expect(said({ HOPPER_EGRESS: egress, HOPPER_EGRESS_ROUTE: '1' })).toBe('routed');
    expect(said({ HOPPER_EGRESS: join(root, 'none'), HOPPER_EGRESS_ROUTE: '1' })).toBe('unrouted');
    expect(said({ HOPPER_EGRESS: egress, HOPPER_EGRESS_ROUTE: '1', HOPPER_EGRESS_CONFINE: '1' })).toBe(netnsRuns ? 'confined' : 'routed');
  });

  it.skipIf(!netnsRuns)('confined, claude runs in a network namespace of its own, between hopper-egress --socket outside and --from inside (issue #2849 part 4)', () => {
    // The stand-in hopper-egress: it says its mode and its network namespace, then runs the command after `--`.
    const egress = join(root, 'egress');
    writeFileSync(egress, '#!/bin/sh\nprintf "egress %s %s\\n" "$1" "$(readlink /proc/self/ns/net)"\nshift 3\nHOPPER_EGRESS_PORT=1 exec "$@"\n', { mode: 0o755 });
    withNode();
    const r = inJobShell('claude --model haiku', env({ HOPPER_EGRESS: egress, HOPPER_EGRESS_ROUTE: '1', HOPPER_EGRESS_CONFINE: '1' }));
    const [outside, inside, ...rest] = r.stdout.trim().split('\n');
    expect(outside).toMatch(/^egress --socket net:\[\d+\]$/);
    expect(inside).toMatch(/^egress --from net:\[\d+\]$/);
    expect(inside!.split(' ')[2]).not.toBe(outside!.split(' ')[2]);
    expect(rest).toEqual(['sandboxed=1', 'args=--model haiku']);
  });

  it('a machine with no runtime of the job\'s: the user\'s runtime dir is empty in it, and so is /run/user/<uid>', () => {
    const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
    const r = spawnSync('sh', ['-c', `${sandboxCommand(scratch)} >/dev/null; "${scratch}/sandbox/run" sh -c 'ls -A "${host}"; ls -A /run/user/${uid}; echo end'`],
      { encoding: 'utf8', env: env() });
    expect(r.stdout.trim()).toBe('end');
  });
});

describe('the job\'s sandbox where bubblewrap cannot run (issue #1295)', () => {
  it('no bwrap on PATH: none, and claude stays the machine\'s own', () => {
    const tools = join(root, 'tools');
    mkdirSync(tools);
    for (const t of ['sh', 'mkdir', 'chmod', 'rm']) writeFileSync(join(tools, t), `#!/bin/sh\nexec ${execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim()} "$@"\n`, { mode: 0o755 });
    const r = spawnSync('/bin/sh', ['-c', `${sandboxCommand(scratch)}; command -v claude`], { encoding: 'utf8', env: env({ PATH: `${fake}${delimiter}${tools}` }) });
    expect(sandboxOutcome(r.stdout)).toBe('none');
    expect(r.stdout.trim().split('\n').at(-1)).toBe(join(fake, 'claude'));
    expect(existsSync(join(scratch, 'sandbox'))).toBe(false);
  });

  it('the setup argv runs alone, for a test', () => {
    expect(sandboxSetupArgv(scratch).slice(0, 2)).toEqual(['sh', '-c']);
  });
});

describe('the job\'s sandbox command is one a terminal line keeps (issue #2234)', () => {
  it('it fits, even with a long work tree', () => {
    const long = `/home/agent/${'w'.repeat(120)}/.worktrees/@scratch/${'0'.repeat(8)}-0000-0000-0000-000000000000`;
    expect(sandboxCommand(long).length).toBeLessThanOrEqual(TERMINAL_LINE_MAX);
  });

  it('no bwrap and the route on: none, and the egress unrouted (issue #2849)', () => {
    const tools = join(root, 'tools');
    mkdirSync(tools);
    for (const t of ['sh', 'mkdir', 'chmod', 'rm']) writeFileSync(join(tools, t), `#!/bin/sh\nexec ${execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim()} "$@"\n`, { mode: 0o755 });
    const r = spawnSync('/bin/sh', ['-c', sandboxCommand(scratch)], { encoding: 'utf8', env: env({ PATH: `${fake}${delimiter}${tools}`, HOPPER_EGRESS_ROUTE: '1' }) });
    expect(sandboxOutcome(r.stdout)).toBe('none');
    expect(egressOutcome(r.stdout)).toBe('unrouted');
  });
});
