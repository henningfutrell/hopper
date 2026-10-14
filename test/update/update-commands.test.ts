// Issues #697, #970, #1104: the update of a container install is one command, the same in the update notice, the drift fix
// and the agent skill. It runs scripts/update.sh from the image to update to (test/scripts/update.test.ts runs it): no
// generated script to keep and no .env. `hopper update carry` makes the new compose.yaml from the image, the install's own
// settings in it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { COMPOSE_TOOLS, RUNTIMES, pruneCommand, runtimeOf, updateCommand } from '../../src/update/update-commands.ts';
import { UPDATE_SKILL } from '../../src/update/update-skill.ts';
import { driftLine } from '../../src/update/drift.ts';
import { updateCommand as uiUpdateCommand } from '../../ui/src/model/update.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const IMAGE = 'ghcr.io/henningfutrell/hopper:beta';
const SHIPPED = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
const OLD_LAN = readFileSync(join(ROOT, 'test', 'fixtures', 'compose', 'old-lan.yaml'), 'utf8');

async function cli(argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: {}, stdin: () => stdin, out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

describe('the update command (issue #1104)', () => {
  it('is one command for each runtime: the update the image carries, piped to bash, with the image', () => {
    expect(updateCommand('podman', IMAGE)).toBe(`podman run --rm --pull=always ${IMAGE} hopper update script | bash -s -- ${IMAGE}`);
    expect(updateCommand('docker', IMAGE)).toBe(`docker run --rm --pull=always ${IMAGE} hopper update script | bash -s -- ${IMAGE}`);
    expect(pruneCommand('podman')).toBe('podman image prune -f --filter label=org.opencontainers.image.title=hopper');
    expect(COMPOSE_TOOLS.map(runtimeOf)).toEqual(['podman', 'podman', 'docker']);
  });

  it('the update notice gives the same command as the hopper (the UI\'s own copy)', () => {
    expect(uiUpdateCommand('Podman', IMAGE)).toBe(updateCommand('podman', IMAGE));
    expect(uiUpdateCommand('Docker', IMAGE)).toBe(updateCommand('docker', IMAGE));
  });

  it('hopper update script prints scripts/update.sh, the update itself', async () => {
    const r = await cli(['update', 'script']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(readFileSync(join(ROOT, 'scripts', 'update.sh'), 'utf8'));
  });

  it('the install page gives the same command to copy', () => {
    const page = readFileSync(join(ROOT, 'site', 'install.html'), 'utf8');
    const copied = [...page.matchAll(/data-copy="([^"]*)"/g)].map((m) => m[1]!.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
    expect(copied).toContain(updateCommand('podman', 'ghcr.io/henningfutrell/hopper:stable'));
  });

  it('the drift log line gives the same command', () => {
    const line = driftLine({ state: 'checked', image: IMAGE, gaps: [{ kind: 'service', name: 'openfga', what: 'the service openfga is not running in this stack' }] })!;
    expect(line).toContain(updateCommand('podman', IMAGE));
  });

  it('the agent skill gives the same command, and never the hopper service alone', () => {
    expect(UPDATE_SKILL).toContain(updateCommand('podman', 'ghcr.io/henningfutrell/hopper:<channel>'));
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

  it('makes no update script to keep any more', async () => {
    for (const tool of COMPOSE_TOOLS) {
      const r = await cli(['update', tool, '--image', IMAGE]);
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
    }
  });

  // Issue #1013: `hopper update podman > hopper-update.sh` was the documented update before issue #970. Run now, it says the
  // command is gone and gives the command that replaces it (issue #1104), on stderr: the script file it writes stays empty.
  it('says a removed update command is gone and gives the command that replaces it (issue #1013)', async () => {
    for (const tool of COMPOSE_TOOLS) {
      const r = await cli(['update', tool, '--image', IMAGE]);
      expect(r.err).toMatch(new RegExp(`hopper update: 'hopper update ${tool}' was removed`));
      expect(r.err).toContain(updateCommand(runtimeOf(tool), IMAGE));
      expect(r.err).toContain('hopper update skill');
    }
    const bare = await cli(['update', 'podman']);
    expect(bare.code).toBe(2);
    expect(bare.out).toBe('');
    expect(bare.err).toContain(updateCommand('podman', 'ghcr.io/henningfutrell/hopper:<channel>'));
    const override = await cli(['update', 'override']);
    expect(override.code).toBe(2);
    expect(override.err).toMatch(/'hopper update override' was removed/);
    expect(override.err).toContain('hopper update carry');
  });

  // Issue #1013: an update with no person (an agent, a scheduler) gives the master key in the environment of the compose
  // command, from a secret manager; the prompt is only for a person. The update reads it from nowhere else (issue #970).
  it('the agent skill says how an update runs with no person: the key already in the launch environment (issue #1013)', () => {
    expect(UPDATE_SKILL).toMatch(/in the environment of the update command/);
    expect(UPDATE_SKILL).toMatch(/no step waits\s+for a person/i);
    expect(UPDATE_SKILL).toMatch(/never from the running container/i);
  });

  it('no update path names .env: the commands, the CLI, the agent skill, the notice and the help', async () => {
    const carried = await cli(['update', 'carry', '--image', IMAGE], OLD_LAN);
    const usage = await cli(['update']);
    const helpText = readFileSync(join(ROOT, 'help', 'deploy-and-update.md'), 'utf8');
    const help = helpText.slice(helpText.indexOf('## Update a container install'), helpText.indexOf('## Host install'));
    expect(help).toContain('hopper update script');
    const texts = [
      ...RUNTIMES.map((r) => updateCommand(r, IMAGE)),
      uiUpdateCommand('Docker', IMAGE),
      readFileSync(join(ROOT, 'scripts', 'update.sh'), 'utf8').replace(/^#.*$/gm, ''),
      carried.out, carried.err, usage.err, UPDATE_SKILL,
      readFileSync(join(ROOT, 'ui', 'src', 'app', 'update.tsx'), 'utf8').replace(/^\/\/.*$/gm, ''),
      help,
    ];
    for (const text of texts) expect(text).not.toMatch(/(^|[\s`'"(/])\.env\b/m);
  });
});
