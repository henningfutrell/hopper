// Issue #2146: the port-forward helper runs one command while kubectl port-forward holds a local port, and stops the
// forward when the command ends. Run here with a kubectl of the test's own on PATH, which says what kubectl says and
// keeps running as kubectl port-forward does. The script: src/sandbox/port-forward-helper.ts; its place in an image:
// test/sandbox/tools.test.ts.
//
// Feature: the port-forward helper
//   Scenario: the command runs once the port is forwarded, and the forward stops when it ends
//   Scenario: the command's exit code is the helper's, and the forward stops then too
//   Scenario: a forward that does not start runs no command, and says kubectl's words
//   Scenario: a port that is not ready in time runs no command
//   Scenario: a bad call is refused
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PORT_FORWARD_HELPER } from '../../src/sandbox/port-forward-helper.ts';

// The test's kubectl: FAKE_MODE ok says the port is forwarded and runs until stopped; fail says why and ends; silent
// runs and never says it is ready. It writes its arguments and its pid, and its pid file is gone once it is stopped.
const FAKE_KUBECTL = `#!/bin/sh
printf '%s\\n' "$*" > "$FAKE_DIR/args"
echo $$ > "$FAKE_DIR/pid"
trap 'rm -f "$FAKE_DIR/pid"; exit 0' TERM
case $FAKE_MODE in
  fail) echo 'error: services "prometheus" is forbidden: cannot create resource "services/portforward"' >&2; exit 1 ;;
  silent) ;;
  *) for p in $(echo "$*" | awk '{print $NF}'); do echo "Forwarding from 127.0.0.1:\${p%%:*} -> \${p#*:}"; done ;;
esac
while :; do sleep 0.05; done
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'port-forward-'));
  writeFileSync(join(dir, 'kubectl'), FAKE_KUBECTL);
  writeFileSync(join(dir, 'hopper-port-forward'), PORT_FORWARD_HELPER);
  chmodSync(join(dir, 'kubectl'), 0o755);
  chmodSync(join(dir, 'hopper-port-forward'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], mode = 'ok', env: Record<string, string> = {}) => spawnSync('sh', [join(dir, 'hopper-port-forward'), ...args], {
  encoding: 'utf8', timeout: 15_000,
  env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, FAKE_DIR: dir, FAKE_MODE: mode, ...env },
});
const alive = (): boolean => {
  if (!existsSync(join(dir, 'pid'))) return false;
  try {
    process.kill(Number(readFileSync(join(dir, 'pid'), 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
};

describe('the port-forward helper (issue #2146)', () => {
  it('the command runs once the port is forwarded, and the forward stops when it ends', () => {
    const r = run(['-n', 'monitoring', 'svc/prometheus', '9090:80', '--', 'sh', '-c', 'test -f "$FAKE_DIR/pid" && echo queried']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('queried\n');
    expect(readFileSync(join(dir, 'args'), 'utf8')).toBe('--namespace monitoring port-forward --address 127.0.0.1 svc/prometheus 9090:80\n');
    expect(alive()).toBe(false);
  });

  it('the command\'s exit code is the helper\'s, and the forward stops then too', () => {
    const r = run(['--context', 'utility', 'svc/grafana', '3000', '--', 'sh', '-c', 'exit 3']);
    expect(r.status).toBe(3);
    expect(readFileSync(join(dir, 'args'), 'utf8')).toBe('--context utility port-forward --address 127.0.0.1 svc/grafana 3000\n');
    expect(alive()).toBe(false);
  });

  it('a forward that does not start runs no command, and says kubectl\'s words', () => {
    const r = run(['svc/prometheus', '9090', '--', 'sh', '-c', 'echo ran'], 'fail');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('cannot create resource "services/portforward"');
    expect(r.stderr).toContain('hopper-port-forward: kubectl port-forward svc/prometheus ended before 127.0.0.1:9090 was ready');
  });

  it('a port that is not ready in time runs no command', () => {
    const r = run(['svc/prometheus', '9090', '--', 'sh', '-c', 'echo ran'], 'silent', { HOPPER_PORT_FORWARD_WAIT_S: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('hopper-port-forward: 127.0.0.1:9090 was not ready after 1 s');
    expect(alive()).toBe(false);
  });

  it('a bad call is refused', () => {
    for (const args of [[], ['svc/prometheus', '9090', 'echo'], ['svc/prometheus', ':9090', '--', 'true'], ['-x', 'svc/p', '1', '--', 'true']]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('usage: hopper-port-forward');
    }
  });
});
