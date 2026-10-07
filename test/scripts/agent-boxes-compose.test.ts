// scripts/agent-boxes.sh with the hopper in its compose container (issue #306, design.md "Agent boxes"):
// no host install and no database the host reaches. The boxes join the hopper's compose network, are
// attached as `agent@<box>` (the name the hopper resolves there), and the plugins config is changed by
// the hopper's own CLI in its container. A stand-in docker answers as a compose deploy does and logs
// every call, so no engine is touched.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'agent-boxes.sh');
const HOPPER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxWxd8NGtwDjmH0KQxSwU0m++PyQWok+VTcSyB7yJ3e';
const BOX_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGv8n9cYc0bTqgYk2m0h3iN1wqXo3f5rB0g8m1Xx3c1B';

/** A docker that answers as a host with the compose hopper running (unless `hopper` is false). `box`:
 *  no box yet, or one running on the default bridge only. */
function standIn(opts: { hopper: boolean; box: 'none' | 'running'; answers?: boolean }) {
  const d = mkdtempSync(join(tmpdir(), 'jh-boxes-compose-'));
  mkdirSync(join(d, 'bin'));
  writeFileSync(join(d, 'bin', 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${d}/calls"
last="\${@: -1}"
case "$1" in
  info|build|start|rm) exit 0 ;;
  run) touch "${d}/created"; exit 0 ;;
  network) exit 0 ;;
  ps)
    case "$*" in
      *com.docker.compose.service=hopper*) ${opts.hopper ? 'echo hopper-hopper-1' : 'true'} ;;
      *hopper.agent-box*) [ -f "${d}/created" ] || [ "${opts.box}" = running ] && echo hopper-box-codex ;;
    esac; exit 0 ;;
  port) echo 127.0.0.1:40022; exit 0 ;;
  image) echo sha256:one; exit 0 ;;
  container)
    case "$*" in
      *State.Running*) if [ "${opts.box}" = running ] || [ -f "${d}/created" ]; then echo true; else exit 1; fi ;;
      *.Image*) echo sha256:one ;;
      *Networks*) if [ "$last" = hopper-hopper-1 ] || [ -f "${d}/created" ]; then echo hopper_default; else echo bridge; fi ;;
    esac; exit 0 ;;
  exec)
    while [ "$1" != -- ]; do shift; done; shift; shift
    case "$*" in
      'test -s'*) exit 0 ;;
      'sh -c'*) cat >/dev/null; exit 0 ;;
      'cat /etc/ssh/ssh_host_ed25519_key.pub') echo "${BOX_KEY} root@box" ;;
      *'status server') echo 'status: running' ;;
      'hopper config version plugins') echo 7 ;;
      'hopper config get plugins') echo '{"version":1}' ;;
      'hopper config set plugins'*) cat > "${d}/set.json" ;;
      'ssh-keyscan'*) echo "hopper-box-codex ${BOX_KEY}" ;;
      'sh -s'*) cat >/dev/null; ${opts.answers === false ? `echo 'Connection refused' >&2; exit 255` : `echo 'status: running'; echo 'cli: codex-cli 0.1.0'`} ;;
      *) echo "unexpected exec: $*" >&2; exit 1 ;;
    esac; exit 0 ;;
esac
echo "unexpected: $*" >&2; exit 1
`);
  writeFileSync(join(d, 'bin', 'herdr'), '#!/bin/sh\n');
  chmodSync(join(d, 'bin', 'docker'), 0o755);
  chmodSync(join(d, 'bin', 'herdr'), 0o755);
  const run = (args: string[]) => {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${join(d, 'bin')}:${process.env.PATH ?? ''}`, HOPPER_SSH_PUBLIC_KEY: HOPPER_KEY,
        HOPPER_SSH_KEY_FILE: '', HOPPER_DATABASE_URL: '', HOPPER_DATABASE_URL_FILE: '', HOPPER_APP_DIR: join(d, 'no-install'),
      },
    });
    return { ...r, calls: readFileSync(join(d, 'calls'), 'utf8').split('\n').filter(Boolean) };
  };
  return { d, run };
}

describe('agent-boxes.sh with the hopper in its compose container', () => {
  it('starts a new box on the hopper\'s network and attaches it as agent@<box>, through the hopper\'s own CLI', () => {
    const { d, run } = standIn({ hopper: true, box: 'none' });
    const r = run(['--attach', 'codex']);
    expect(r.status, r.stderr).toBe(0);
    const create = r.calls.find((c) => c.startsWith('run '))!;
    expect(create).toContain('--network hopper_default');
    expect(create).toContain('-p 127.0.0.1::22');
    expect(r.calls).toContain('exec -i -- hopper-hopper-1 hopper config set plugins --if-version 7');
    expect(r.calls.some((c) => c.startsWith('exec -- hopper-hopper-1 ssh-keyscan'))).toBe(true);
    const set = JSON.parse(readFileSync(join(d, 'set.json'), 'utf8')) as { machines: { name: string; options: { ssh: string; hostKey: string } }[] };
    expect(set.machines).toEqual([expect.objectContaining({ name: 'hopper-box-codex', options: expect.objectContaining({ ssh: 'agent@hopper-box-codex', hostKey: BOX_KEY }) })]);
  });

  it('joins a running box that is not on the hopper\'s network to it, and keeps the box', () => {
    const { run } = standIn({ hopper: true, box: 'running' });
    const r = run(['codex']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain('network connect hopper_default hopper-box-codex');
    expect(r.calls.some((c) => c.startsWith('run ') || c.startsWith('rm '))).toBe(false);
  });

  it('--attach with no hopper to attach to says how to start one', () => {
    const { run } = standIn({ hopper: false, box: 'none' });
    const r = run(['--attach', 'codex']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--attach needs the hopper: its compose container running, or a host install\'s database (HOPPER_DATABASE_URL or HOPPER_DATABASE_URL_FILE)');
    expect(r.calls.some((c) => c.startsWith('build '))).toBe(false);
  });

  it('--check proves each box answers the hopper: over ssh from its container, its herdr session running and its agent CLI there', () => {
    const { run } = standIn({ hopper: true, box: 'running' });
    const r = run(['--check', 'codex']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain('exec -i -- hopper-hopper-1 sh -s -- hopper-box-codex codex');
    expect(r.stdout).toContain('hopper-box-codex: ok — herdr session running, codex-cli 0.1.0');
    expect(r.calls.some((c) => /^(build|run|rm|network) /.test(c))).toBe(false);
  });

  it('--check fails, naming the box and what ssh said, when a box does not answer the hopper', () => {
    const { run } = standIn({ hopper: true, box: 'running', answers: false });
    const r = run(['--check', 'codex']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('hopper-box-codex: FAILED — Connection refused');
  });

  it('--check with no hopper container says how to start one', () => {
    const { run } = standIn({ hopper: false, box: 'running' });
    const r = run(['--check', 'codex']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--check needs the hopper\'s compose container running');
  });
});
