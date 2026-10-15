// Issue #1246: compose reads compose.override.yaml beside the compose.yaml an update puts in. An override that mounts a
// target compose.yaml mounts itself (the Podman socket, issue #1157) or publishes the same port makes the merged stack
// fail at `up -d`, after the old stack is down. The update checks the merge first, refuses with what conflicts and where,
// and can drop an override entry that only repeats what compose.yaml gives.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runCli, type CliIo } from '../../src/cli.ts';
import { composeConflicts, dropRedundant, OVERRIDE_MARK } from '../../src/update/compose-conflicts.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const IMAGE = 'ghcr.io/henningfutrell/hopper:beta';
const SHIPPED = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');

/** An install's own override: the socket compose.yaml now mounts itself, and a label of its own. */
const SOCKET_OVERRIDE = `# mine
services:
  hopper:
    volumes:
      - \${XDG_RUNTIME_DIR}/podman/podman.sock:/run/podman/podman.sock
      - ./notes:/notes:ro
    labels: [mine]
`;

const merged = (override: string) => composeConflicts([{ name: 'compose.yaml', text: SHIPPED }, { name: 'compose.override.yaml', text: override }]);

async function cli(argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: {}, stdin: () => stdin, out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

describe('the conflicts of compose.yaml and compose.override.yaml (issue #1246)', () => {
  it('finds none in the shipped compose.yaml with no override, or with one of the install\'s own', () => {
    expect(merged('')).toEqual({ conflicts: [] });
    expect(merged('services:\n  hopper:\n    volumes:\n      - ./notes:/notes:ro\n')).toEqual({ conflicts: [] });
  });

  it('refuses an override that mounts a target compose.yaml mounts itself, and names the file, service and key', () => {
    const { conflicts } = merged(SOCKET_OVERRIDE);
    expect(conflicts).toEqual([{
      kind: 'duplicate-mount', refuse: true, fixable: true, file: 'compose.override.yaml', service: 'hopper', key: 'volumes',
      value: '/run/podman/podman.sock',
      detail: expect.stringMatching(/compose\.yaml mounts \/run\/podman\/podman\.sock itself/),
      resolution: expect.stringMatching(/remove .*\/run\/podman\/podman\.sock.* from compose\.override\.yaml/),
    }]);
  });

  it('finds the same target in the long form, and a published port compose.yaml publishes', () => {
    const long = 'services:\n  hopper:\n    volumes:\n      - type: bind\n        source: /x/podman.sock\n        target: /run/podman/podman.sock\n';
    expect(merged(long).conflicts.map((c) => [c.kind, c.value])).toEqual([['duplicate-mount', '/run/podman/podman.sock']]);
    const port = 'services:\n  hopper:\n    ports:\n      - "4790:4790"\n';
    expect(merged(port).conflicts.map((c) => [c.kind, c.key, c.value, c.fixable])).toEqual([['duplicate-port', 'ports', '4790/tcp', true]]);
  });

  it('refuses a target mounted twice in the override itself, with nothing to drop for it', () => {
    const twice = 'services:\n  hopper:\n    volumes:\n      - ./a:/data\n      - ./b:/data\n';
    expect(merged(twice).conflicts.map((c) => [c.kind, c.value, c.fixable])).toEqual([['duplicate-mount', '/data', false]]);
  });

  it('warns, and does not refuse, when the override gives a fixed setting of compose.yaml another value', () => {
    const env = 'services:\n  hopper:\n    environment:\n      HOPPER_PODMAN_SOCKET: /elsewhere.sock\n      HOPPER_PUBLIC_URL: https://x.example.test\n';
    expect(merged(env).conflicts.map((c) => [c.kind, c.key, c.refuse])).toEqual([['conflicting-env', 'environment.HOPPER_PODMAN_SOCKET', false]]);
    // The same value is no conflict.
    expect(merged('services:\n  hopper:\n    environment:\n      HOPPER_PODMAN_SOCKET: /run/podman/podman.sock\n').conflicts).toEqual([]);
  });

  it('says so, and checks nothing, when the override is not YAML', () => {
    expect(merged('services: [').unread).toMatch(/compose\.override\.yaml/);
  });

  it('drops the override entries that only repeat compose.yaml, and keeps the rest and its comments', () => {
    const fixed = dropRedundant(SOCKET_OVERRIDE, merged(SOCKET_OVERRIDE).conflicts);
    expect(fixed).toMatch(/^# mine/);
    expect(parse(fixed)).toEqual({ services: { hopper: { volumes: ['./notes:/notes:ro'], labels: ['mine'] } } });
    expect(merged(fixed).conflicts).toEqual([]);
    // A list that is empty after it goes, and a service with nothing left.
    const only = 'services:\n  hopper:\n    volumes:\n      - ${XDG_RUNTIME_DIR}/podman/podman.sock:/run/podman/podman.sock\n';
    expect(parse(dropRedundant(only, merged(only).conflicts)) ?? {}).toEqual({ services: {} });
  });
});

describe('hopper update check, carry and fix-override with the override (issue #1246)', () => {
  const stdin = (override: string) => `${SHIPPED}\n${OVERRIDE_MARK}\n${override}`;

  it('check: the conflicts as JSON, exit 4, and each said on stderr', async () => {
    const r = await cli(['update', 'check', '--image', IMAGE, '--with-override'], stdin(SOCKET_OVERRIDE));
    expect(r.code).toBe(4);
    expect(JSON.parse(r.out)).toEqual({ ok: false, conflicts: [expect.objectContaining({ kind: 'duplicate-mount', file: 'compose.override.yaml', service: 'hopper', key: 'volumes', value: '/run/podman/podman.sock' })] });
    expect(r.err).toMatch(/hopper update: conflict: compose\.override\.yaml: services\.hopper\.volumes: \/run\/podman\/podman\.sock/);
    const clean = await cli(['update', 'check', '--image', IMAGE, '--with-override'], stdin('services:\n  hopper:\n    labels: [mine]\n'));
    expect(clean.code, clean.err).toBe(0);
    expect(JSON.parse(clean.out)).toEqual({ ok: true, conflicts: [] });
  });

  it('carry refuses, and prints no compose.yaml, while the merge conflicts', async () => {
    const r = await cli(['update', 'carry', '--image', IMAGE, '--with-override'], stdin(SOCKET_OVERRIDE));
    expect(r.code).toBe(4);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/conflict: compose\.override\.yaml: services\.hopper\.volumes/);
  });

  it('fix-override prints the override without the redundant entries; then carry goes on', async () => {
    const fixed = await cli(['update', 'fix-override', '--image', IMAGE, '--with-override'], stdin(SOCKET_OVERRIDE));
    expect(fixed.code, fixed.err).toBe(0);
    expect(parse(fixed.out)).toEqual({ services: { hopper: { volumes: ['./notes:/notes:ro'], labels: ['mine'] } } });
    const carried = await cli(['update', 'carry', '--image', IMAGE, '--with-override'], stdin(fixed.out));
    expect(carried.code, carried.err).toBe(0);
    expect(carried.out).toMatch(/^# hopper version: /);
  });

  it('fix-override refuses, and prints nothing, when a conflict is not one it can drop', async () => {
    const r = await cli(['update', 'fix-override', '--image', IMAGE, '--with-override'], stdin('services:\n  hopper:\n    volumes:\n      - ./a:/data\n      - ./b:/data\n'));
    expect(r.code).toBe(4);
    expect(r.out).toBe('');
  });
});
