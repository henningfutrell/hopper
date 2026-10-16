// Issue #1373: scripts/kind-migrate-check.ts moves a compose stack it starts onto a kind cluster, and removes both at the
// end. It must never take a compose stack that was there already: on a machine that runs a hopper, that is the live one.
// docker and kind are stubs on PATH that write what they were asked to a log; nothing starts.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inHopper } from '../../scripts/kind-migrate-check.ts';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'kind-migrate-check.ts');
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('refuses where a compose project hopper is there already, and starts, moves and removes nothing', () => {
  const bin = mkdtempSync(join(tmpdir(), 'jh-kind-migrate-'));
  dirs.push(bin);
  const log = join(bin, 'calls');
  writeFileSync(log, '');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf 'docker %s\\n' "$*" >> "${log}"\n[ "$1" = ps ] && echo 0123456789ab\nexit 0\n`);
  writeFileSync(join(bin, 'kind'), `#!/bin/sh\nprintf 'kind %s\\n' "$*" >> "${log}"\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'kind'), 0o755);
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin } });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('a compose project hopper is there already');
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['docker ps -aq --filter label=com.docker.compose.project=hopper']);
});

// The check runs the dev channel's image, whose CLI may stop on a previous-keys file the chart names and a Secret with no
// previous key does not hold: the command in the pod drops that name when the file is not there, as the daemon reads it.
it('runs a command in the cluster hopper with no previous-keys file name when the file is not there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jh-kind-migrate-'));
  dirs.push(dir);
  const show = ['sh', '-c', 'printf "%s|%s" "${HOPPER_MASTER_KEY_PREVIOUS_FILE-unset}" "$1"', 'sh', 'users'];
  const [command, ...args] = inHopper(show);
  const missing = spawnSync(command!, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOPPER_MASTER_KEY_PREVIOUS_FILE: join(dir, 'previous') } });
  expect(missing.stdout).toBe('unset|users');
  writeFileSync(join(dir, 'previous'), 'k');
  const there = spawnSync(command!, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOPPER_MASTER_KEY_PREVIOUS_FILE: join(dir, 'previous') } });
  expect(there.stdout).toBe(`${join(dir, 'previous')}|users`);
});
