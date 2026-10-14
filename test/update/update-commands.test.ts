// Issues #697, #970: the update of a container install is plain compose commands, the same in the update notice, the drift
// fix and the agent skill. No generated script and no .env: back up the database, make the new compose.yaml from the image
// (`hopper update carry`, the install's own settings in it), read the change, put it in, then pull and start the whole
// stack — never the hopper service alone. The last command refuses before compose runs when the master key is not given at
// launch: a recreate without it starts the hopper limited. Run here in sh against a stub container tool that records each call.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { COMPOSE_TOOLS, updateCommands, updateLines } from '../../src/update/update-commands.ts';
import { UPDATE_SKILL } from '../../src/update/update-skill.ts';
import { driftLine } from '../../src/update/drift.ts';
import { updateCommands as uiUpdateCommands } from '../../ui/src/model/update.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const IMAGE = 'ghcr.io/henningfutrell/hopper:beta';
const KEY = 'a'.repeat(64);
const SHIPPED = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
const OLD_LAN = readFileSync(join(ROOT, 'test', 'fixtures', 'compose', 'old-lan.yaml'), 'utf8');

/** Issue #1063: a stack runs, but this compose tool sees none of it: it would start a second stack on the same volumes. */
const PODMAN_CHECK = `[ -z "$(podman ps -q --filter label=com.docker.compose.project=hopper)" ] || podman compose ps -q 2>/dev/null | grep -Eq '^[0-9a-f]{12,}$' || { echo 'hopper: podman compose does not see the hopper stack that runs. It would start a second stack on the same data: the update stops. Use the compose tool that started the stack. When podman-compose started it: export PODMAN_COMPOSE_PROVIDER=podman-compose' >&2; false; }`;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function cli(argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: {}, stdin: () => stdin, out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

/** A stub `podman` that logs each call with the HOPPER_IMAGE it was given, and runs `run … <image> hopper …` as this checkout's CLI. */
function stubPodman(bin: string): void {
  writeFileSync(join(bin, 'podman'), `#!/bin/sh
printf '%s | HOPPER_IMAGE=%s\\n' "$*" "\${HOPPER_IMAGE:-}" >> "$STUB_LOG"
case "$*" in
  "compose exec -T postgres pg_dump"*) echo DUMP ;;
  "ps -q --filter label=com.docker.compose.project=hopper") printf '%s' "\${STUB_RUNNING:-}" ;;
  "compose ps -q") printf '%s' "\${STUB_SEEN:-}" ;;
  run\\ *) while [ "$1" != hopper ]; do shift; done; shift; exec '${process.execPath}' '${join(ROOT, 'src', 'cli.ts')}' "$@" ;;
esac
exit 0
`);
  chmodSync(join(bin, 'podman'), 0o755);
}

/** An install's folder with `compose`, and each update command but the master key's prompt run in order, in `shell`. */
function update(compose: string, o: { masterKey?: string; shell?: string; running?: string; seen?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-update-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'compose.yaml'), compose);
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  stubPodman(bin);
  const log = join(dir, '.calls');
  writeFileSync(log, '');
  const u = updateCommands('podman', IMAGE);
  // The person runs them one at a time: a failed diff (the files differ) stops nothing.
  const script = [u.check, u.backup, u.carry, `${u.diff} || true`, u.swap, u.up].join('\n');
  const r = spawnSync(o.shell ?? 'sh', ['-c', script], {
    cwd: dir, encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: dir, STUB_LOG: log, STUB_RUNNING: o.running ?? '', STUB_SEEN: o.seen ?? '',
      ...(o.masterKey ? { HOPPER_MASTER_KEY: o.masterKey } : {}),
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { dir, status: r.status, out: `${r.stdout}${r.stderr}`, calls, read: (f: string) => readFileSync(join(dir, f), 'utf8') };
}

describe('the update commands (issue #970)', () => {
  it('are plain compose commands for each tool: the new compose.yaml from the image, then pull and up -d of the whole stack', () => {
    expect(updateCommands('podman', IMAGE)).toEqual({
      give: 'read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY',
      check: PODMAN_CHECK,
      backup: 'podman compose exec -T postgres pg_dump -U hopper -d hopper -Fc > hopper-backup.dump',
      carry: `podman run --rm -i --pull=always ${IMAGE} hopper update carry --image ${IMAGE} < compose.yaml > compose.yaml.next`,
      diff: 'diff -u compose.yaml compose.yaml.next',
      swap: 'cp compose.yaml compose.yaml.bak && mv compose.yaml.next compose.yaml',
      up: `: "\${HOPPER_MASTER_KEY:?is not given: the update stops. Give it first: read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY}" && ${PODMAN_CHECK} && HOPPER_IMAGE=${IMAGE} podman compose pull && HOPPER_IMAGE=${IMAGE} podman compose up -d`,
      prune: 'podman image prune -f --filter label=org.opencontainers.image.title=hopper',
    });
    expect(updateCommands('docker', IMAGE).up).toMatch(/&& HOPPER_IMAGE=\S+ docker compose pull && HOPPER_IMAGE=\S+ docker compose up -d$/);
    expect(updateCommands('podman-compose', IMAGE).up).toMatch(/podman-compose pull && HOPPER_IMAGE=\S+ podman-compose up -d$/);
    expect(updateCommands('podman-compose', IMAGE).carry).toMatch(/^podman run /);
    for (const tool of COMPOSE_TOOLS) expect(updateLines(updateCommands(tool, IMAGE)).join('\n')).not.toMatch(/--no-deps|hopper-update\.sh|printenv/);
  });

  it('the update notice gives the same commands as the hopper (the UI\'s own copy)', () => {
    expect(uiUpdateCommands('Podman', IMAGE)).toEqual(updateCommands('podman', IMAGE));
    expect(uiUpdateCommands('Docker', IMAGE)).toEqual(updateCommands('docker', IMAGE));
  });

  it('bring an old LAN install to the image\'s compose.yaml with its settings in it, the old one kept, the whole stack started', () => {
    const r = update(OLD_LAN, { masterKey: KEY });
    expect(r.status, r.out).toBe(0);
    const compose = r.read('compose.yaml');
    expect(compose).toMatch(/^# hopper version: /);
    expect(compose).toContain(`\${HOPPER_IMAGE:-${IMAGE}}`);
    expect(compose).toContain('"${HOPPER_BIND:-0.0.0.0}:${HOPPER_PORT:-4790}:${HOPPER_PORT:-4790}"');
    expect(compose).toContain('${HOPPER_PUBLIC_URL:-https://hopper.example.test}');
    expect(compose).not.toContain(KEY);
    expect(r.read('compose.yaml.bak')).toBe(OLD_LAN);
    expect(r.read('hopper-backup.dump')).toBe('DUMP\n');
    // What the new file cannot hold is said, for compose.override.yaml; nothing is written there by itself.
    expect(r.out).toMatch(/Add this to compose\.override\.yaml/);
    expect(r.out).toContain('whoami:');
    expect(r.out).not.toContain(KEY);
    // The check (issue #1063) asks first, and again in the up line: no stack runs here.
    expect(r.calls).toEqual([
      'ps -q --filter label=com.docker.compose.project=hopper | HOPPER_IMAGE=',
      'compose exec -T postgres pg_dump -U hopper -d hopper -Fc | HOPPER_IMAGE=',
      `run --rm -i --pull=always ${IMAGE} hopper update carry --image ${IMAGE} | HOPPER_IMAGE=`,
      'ps -q --filter label=com.docker.compose.project=hopper | HOPPER_IMAGE=',
      `compose pull | HOPPER_IMAGE=${IMAGE}`,
      `compose up -d | HOPPER_IMAGE=${IMAGE}`,
    ]);
  });

  for (const shell of ['sh', 'bash']) {
    it(`refuse before compose runs when the master key is not given (${shell})`, () => {
      const r = update(SHIPPED, { shell });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/HOPPER_MASTER_KEY: is not given: the update stops\. Give it first: read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY/);
      expect(r.calls.filter((c) => /^compose (pull|up)/.test(c))).toEqual([]);
    });
  }

  // Issue #1063: `podman compose` runs docker-compose when it finds it, and docker-compose does not see a stack podman-compose
  // started (nor podman-compose one docker-compose started). Its `up` then makes a second stack on the same named volumes.
  it('stop before compose starts anything when the compose tool does not see the stack that runs (issue #1063)', () => {
    const r = update(SHIPPED, { masterKey: KEY, running: '0123456789ab\n' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/podman compose does not see the hopper stack that runs/);
    expect(r.out).toContain('export PODMAN_COMPOSE_PROVIDER=podman-compose');
    expect(r.calls.filter((c) => /^compose (pull|up)/.test(c))).toEqual([]);
    // A stack the tool sees, and no stack at all (a first start), go on.
    expect(update(SHIPPED, { masterKey: KEY, running: '0123456789ab\n', seen: `${'0123456789ab'.repeat(5)}abcd\n` }).status).toBe(0);
    expect(update(SHIPPED, { masterKey: KEY }).status).toBe(0);
  });

  it('the check is in the up line itself, and each tool checks with its own commands (issue #1063)', () => {
    for (const tool of COMPOSE_TOOLS) {
      const u = updateCommands(tool, IMAGE);
      expect(u.up).toContain(`&& ${u.check} && HOPPER_IMAGE=`);
      expect(updateLines(u).slice(0, 3)).toEqual([u.give, u.check, u.backup]);
    }
    expect(updateCommands('docker', IMAGE).check).toMatch(/^\[ -z "\$\(docker ps -q --filter label=com\.docker\.compose\.project=hopper\)" \] \|\| docker compose ps -q /);
    expect(updateCommands('docker', IMAGE).check).not.toContain('PODMAN_COMPOSE_PROVIDER');
    expect(updateCommands('podman-compose', IMAGE).check).toMatch(/\] \|\| podman-compose ps -q /);
  });

  it('the install page gives the same commands to copy, the check among them (issue #1063)', () => {
    const page = readFileSync(join(ROOT, 'site', 'install.html'), 'utf8');
    const copied = [...page.matchAll(/data-copy="([^"]*)"/g)].map((m) => m[1]!.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
    for (const line of updateLines(updateCommands('podman', 'ghcr.io/henningfutrell/hopper:stable'))) expect(copied).toContain(line);
  });

  it('the drift log line gives the same commands', () => {
    const line = driftLine({ state: 'checked', image: IMAGE, gaps: [{ kind: 'service', name: 'openfga', what: 'the service openfga is not running in this stack' }] })!;
    expect(line).toContain(updateCommands('podman', IMAGE).carry);
    expect(line).toContain(updateCommands('podman', IMAGE).up);
  });
});

describe('hopper update (issue #970)', () => {
  it('carry: the new compose.yaml on stdout from the old one on stdin; it needs both', async () => {
    const r = await cli(['update', 'carry', '--image', IMAGE], SHIPPED);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`\${HOPPER_IMAGE:-${IMAGE}}`);
    expect((await cli(['update', 'carry', '--image', IMAGE])).code).toBe(1);
    expect((await cli(['update', 'carry'], SHIPPED)).code).toBe(2);
  });

  it('makes no update script any more', async () => {
    for (const tool of COMPOSE_TOOLS) {
      const r = await cli(['update', tool, '--image', IMAGE]);
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
    }
  });

  // Issue #1013: `hopper update podman > hopper-update.sh` was the documented update before issue #970. Run now, it says the
  // command is gone and gives the commands that replace it, on stderr: the script file it writes stays empty.
  it('says a removed update command is gone and gives the commands that replace it (issue #1013)', async () => {
    for (const tool of COMPOSE_TOOLS) {
      const r = await cli(['update', tool, '--image', IMAGE]);
      expect(r.err).toMatch(new RegExp(`hopper update: 'hopper update ${tool}' was removed`));
      for (const line of updateLines(updateCommands(tool, IMAGE))) expect(r.err).toContain(line);
      expect(r.err).toContain('hopper update skill');
    }
    const bare = await cli(['update', 'podman']);
    expect(bare.code).toBe(2);
    expect(bare.out).toBe('');
    expect(bare.err).toContain(updateCommands('podman', 'ghcr.io/henningfutrell/hopper:<channel>').up);
    const override = await cli(['update', 'override']);
    expect(override.code).toBe(2);
    expect(override.err).toMatch(/'hopper update override' was removed/);
    expect(override.err).toContain('hopper update carry');
  });

  // Issue #1013: an update with no person (an agent, a scheduler) gives the master key in the environment of the compose
  // command, from a secret manager; the prompt is only for a person. The update reads it from nowhere else (issue #970).
  it('the agent skill says how an update runs with no person: the key already in the launch environment (issue #1013)', () => {
    expect(UPDATE_SKILL).toMatch(/already in the environment/);
    expect(UPDATE_SKILL).toMatch(/skip the step that gives it/i);
    expect(UPDATE_SKILL).toMatch(/never from the running container/i);
  });

  it('no update path names .env: the commands, the CLI, the agent skill, the notice and the help', async () => {
    const carried = await cli(['update', 'carry', '--image', IMAGE], OLD_LAN);
    const usage = await cli(['update']);
    const helpText = readFileSync(join(ROOT, 'help', 'deploy-and-update.md'), 'utf8');
    const help = helpText.slice(helpText.indexOf('## Update a container install'), helpText.indexOf('## Host install'));
    expect(help).toContain('hopper update carry');
    const texts = [
      ...COMPOSE_TOOLS.flatMap((t) => updateLines(updateCommands(t, IMAGE))),
      ...updateLines(uiUpdateCommands('Docker', IMAGE)),
      carried.out, carried.err, usage.err, UPDATE_SKILL,
      readFileSync(join(ROOT, 'ui', 'src', 'app', 'update.tsx'), 'utf8').replace(/^\/\/.*$/gm, ''),
      help,
    ];
    for (const text of texts) expect(text).not.toMatch(/(^|[\s`'"(/])\.env\b/m);
  });
});
