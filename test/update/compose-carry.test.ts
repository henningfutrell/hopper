// Issue #697: compose.yaml is the one the image ships with, replaced whole at each update, so what an install changed in it moves
// to .env first: the published port's bind address, the port, and the hopper's own settings. What .env cannot hold — a
// service of the install's own, a host folder mounted into a service, a key the shipped file never sets — moves to
// compose.override.yaml, which compose reads beside it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { carryCompose, carryLocalSettings, carryOverride } from '../../src/update/compose-carry.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SHIPPED = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
const OLD_LAN = readFileSync(join(ROOT, 'test', 'fixtures', 'compose', 'old-lan.yaml'), 'utf8');

/** The shipped compose.yaml with the hopper's published port replaced by `port`. */
const withPort = (port: string): string => SHIPPED.replace(/^ {6}- "\$\{HOPPER_BIND[^\n]*$/m, `      - "${port}"`);

describe('carrying an install\'s own settings out of its compose.yaml (issue #697)', () => {
  it('carries nothing from the shipped compose.yaml itself', () => {
    expect(carryLocalSettings(SHIPPED, SHIPPED)).toEqual({ env: [], notes: [] });
  });

  it('moves an old LAN install\'s bind address, LAN names and public URL to .env lines', () => {
    const r = carryLocalSettings(OLD_LAN, SHIPPED);
    expect(r.env).toEqual(['HOPPER_BIND=0.0.0.0', 'HOPPER_LAN_NAMES=hopper,lanbox', 'HOPPER_PUBLIC_URL=https://hopper.example.test']);
    expect(r.notes).toEqual([]);
  });

  it('reads a published port without an address as every interface, and a fixed port as HOPPER_PORT', () => {
    expect(carryLocalSettings(withPort('8080:4790'), SHIPPED).env).toEqual(['HOPPER_BIND=0.0.0.0', 'HOPPER_PORT=8080']);
    expect(carryLocalSettings(withPort('192.168.1.5:${HOPPER_PORT:-4790}:${HOPPER_PORT:-4790}'), SHIPPED).env).toEqual(['HOPPER_BIND=192.168.1.5']);
    expect(carryLocalSettings(withPort('127.0.0.1:${HOPPER_PORT:-4790}:${HOPPER_PORT:-4790}'), SHIPPED).env).toEqual([]);
  });

  it('says so, and carries nothing, when the old file is not a compose file with a hopper service', () => {
    expect(carryLocalSettings('services: [', SHIPPED)).toEqual({ env: [], notes: [expect.stringMatching(/not read/)] });
    expect(carryLocalSettings('services:\n  other:\n    image: x\n', SHIPPED).notes).toEqual([expect.stringMatching(/no hopper service/)]);
  });
});

describe('moving what .env cannot hold to compose.override.yaml (issue #697)', () => {
  it('moves nothing from the shipped compose.yaml itself', () => {
    expect(carryOverride(SHIPPED, SHIPPED, undefined)).toEqual({ override: undefined, notes: [] });
  });

  it('moves an old install\'s own service with its volume, a host folder mounted into the hopper and a key the shipped file never sets', () => {
    const r = carryOverride(OLD_LAN, SHIPPED, undefined);
    expect(r.override).toBeDefined();
    expect(parse(r.override!)).toEqual({
      services: {
        hopper: { volumes: ['/run/podman/podman.sock:/run/podman/podman.sock'], group_add: ['0'] },
        whoami: { image: 'docker.io/traefik/whoami:v1.10', restart: 'unless-stopped', volumes: ['whoami-data:/data'] },
      },
      volumes: { 'whoami-data': null },
    });
    expect(r.override).toMatch(/^# .*hopper update/);
    expect(r.notes).toEqual([
      'hopper: volume /run/podman/podman.sock:/run/podman/podman.sock moved to compose.override.yaml',
      'hopper: group_add moved to compose.override.yaml',
      'service whoami moved to compose.override.yaml',
      'volume whoami-data moved to compose.override.yaml',
    ]);
  });

  it('keeps an existing compose.override.yaml, its comments, and what it has already', () => {
    const existing = '# mine\nservices:\n  whoami:\n    image: docker.io/traefik/whoami:v1.11\n  hopper:\n    group_add: ["1"]\n';
    const r = carryOverride(OLD_LAN, SHIPPED, existing);
    expect(r.override).toMatch(/^# mine\n/);
    const doc = parse(r.override!);
    expect(doc.services.whoami).toEqual({ image: 'docker.io/traefik/whoami:v1.11' });
    expect(doc.services.hopper).toEqual({ group_add: ['1'], volumes: ['/run/podman/podman.sock:/run/podman/podman.sock'] });
    expect(r.notes).toEqual(expect.arrayContaining([
      'service whoami: compose.override.yaml has it already, kept',
      'hopper: group_add: compose.override.yaml has it already, kept',
    ]));
  });

  it('keeps an install\'s own project name: another name would start the stack on new, empty volumes', () => {
    const r = carryOverride(SHIPPED.replace(/^name: hopper$/m, 'name: lab'), SHIPPED, undefined);
    expect(parse(r.override!)).toEqual({ name: 'lab' });
    expect(r.notes).toEqual(['name moved to compose.override.yaml']);
  });

  it('drops a service the hopper once shipped and no longer does, and moves nothing it named itself', () => {
    const old = SHIPPED.replace(/^services:\n/m, 'services:\n  secrets:\n    image: x\n');
    expect(carryOverride(old, SHIPPED, undefined)).toEqual({ override: undefined, notes: ['service secrets: the hopper no longer ships it, dropped'] });
  });

  it('says so, and moves nothing, when the old file or the override is not YAML', () => {
    expect(carryOverride('services: [', SHIPPED, undefined)).toEqual({ override: undefined, notes: [expect.stringMatching(/not read/)] });
    expect(carryOverride(OLD_LAN, SHIPPED, 'services: [')).toEqual({ override: undefined, notes: [expect.stringMatching(/compose\.override\.yaml was not read/)] });
  });
});

describe('the new compose.yaml, with the install\'s own settings in it: no .env (issue #894)', () => {
  const IMAGE = 'ghcr.io/henningfutrell/hopper:beta';
  const KEY = 'a'.repeat(64);
  const hopperEnv = (text: string): Record<string, string> =>
    (parse(text) as { services: { hopper: { environment: Record<string, string> } } }).services.hopper.environment;

  it('names the image it updates to, and changes nothing else of the shipped file', () => {
    const r = carryCompose({ old: SHIPPED, shipped: SHIPPED, dotenv: '', image: IMAGE });
    expect(r.compose).toBe(SHIPPED.replaceAll('${HOPPER_IMAGE:-ghcr.io/henningfutrell/hopper:latest}', `\${HOPPER_IMAGE:-${IMAGE}}`));
    expect(r.overrideEnv).toEqual({});
  });

  it('moves an old LAN install\'s settings and its .env into compose.yaml, and the master key into no file', () => {
    const dotenv = `HOPPER_MASTER_KEY=${KEY}\nHOPPER_IMAGE=ghcr.io/henningfutrell/hopper:latest\n# a comment\nexport HOPPER_LAN_PEERS="192.168.0.0/16"\n`;
    const r = carryCompose({ old: OLD_LAN, shipped: SHIPPED, dotenv, image: IMAGE });
    expect(r.compose).not.toContain(KEY);
    expect(r.compose).toContain('"${HOPPER_BIND:-0.0.0.0}:${HOPPER_PORT:-4790}:${HOPPER_PORT:-4790}"');
    expect(r.compose).toMatch(/^ {4}image: \$\{HOPPER_IMAGE:-ghcr\.io\/henningfutrell\/hopper:beta\}$/m);
    expect(hopperEnv(r.compose)).toMatchObject({
      HOPPER_LAN_NAMES: '${HOPPER_LAN_NAMES:-hopper,lanbox}',
      HOPPER_LAN_PEERS: '${HOPPER_LAN_PEERS:-192.168.0.0/16}',
      HOPPER_PUBLIC_URL: '${HOPPER_PUBLIC_URL:-https://hopper.example.test}',
      HOPPER_MASTER_KEY: '${HOPPER_MASTER_KEY:-}',
    });
    expect(r.overrideEnv).toEqual({});
    expect(r.notes).toEqual(expect.arrayContaining([
      'HOPPER_BIND: set in compose.yaml',
      'HOPPER_LAN_PEERS: set in compose.yaml',
      expect.stringMatching(/^HOPPER_MASTER_KEY: in no file: give it at launch/),
    ]));
  });

  it('keeps what an earlier update set in compose.yaml, at the next update', () => {
    const first = carryCompose({ old: OLD_LAN, shipped: SHIPPED, dotenv: 'HOPPER_PORT=4800\nCOMPOSE_PROFILES=kms\n', image: IMAGE });
    const next = carryCompose({ old: first.compose, shipped: SHIPPED, dotenv: '', image: 'ghcr.io/henningfutrell/hopper:stable' });
    expect(next.compose).toContain('"${HOPPER_BIND:-0.0.0.0}:${HOPPER_PORT:-4800}:${HOPPER_PORT:-4800}"');
    expect(hopperEnv(next.compose)).toMatchObject({ HOPPER_LAN_NAMES: '${HOPPER_LAN_NAMES:-hopper,lanbox}', COMPOSE_PROFILES: '${COMPOSE_PROFILES:-kms}' });
    expect(next.compose).toContain('${HOPPER_IMAGE:-ghcr.io/henningfutrell/hopper:stable}');
  });

  it('takes the settings given at launch over the old .env and the old compose.yaml', () => {
    const r = carryCompose({ old: OLD_LAN, shipped: SHIPPED, dotenv: 'HOPPER_LAN_NAMES=from-env\n', launch: 'HOPPER_LAN_NAMES=from-launch\nHOPPER_PORT=4800\n', image: IMAGE });
    expect(hopperEnv(r.compose)).toMatchObject({ HOPPER_LAN_NAMES: '${HOPPER_LAN_NAMES:-from-launch}', HOPPER_PORT: '${HOPPER_PORT:-4800}' });
  });

  it('turns on the services of COMPOSE_PROFILES in the file itself, and leaves the others behind their profile', () => {
    const r = carryCompose({ old: SHIPPED, shipped: SHIPPED, dotenv: 'COMPOSE_PROFILES=hopper-vault,kms\n', image: IMAGE });
    const services = (parse(r.compose) as { services: Record<string, { profiles?: string[] }> }).services;
    expect(services['hopper-vault']!.profiles).toBeUndefined();
    expect(services.kms!.profiles).toBeUndefined();
    expect(services.vault!.profiles).toEqual(['vault']);
    expect(hopperEnv(r.compose).COMPOSE_PROFILES).toBe('${COMPOSE_PROFILES:-hopper-vault,kms}');
  });

  it('moves a setting compose.yaml does not name to compose.override.yaml; a secret only by name, given at launch', () => {
    const r = carryCompose({ old: SHIPPED, shipped: SHIPPED, dotenv: 'HOPPER_GREETING=a $b c\nCLAUDE_CODE_OAUTH_TOKEN=t0\nHOPPER_LAN_NAMES=x y\n', image: IMAGE });
    expect(r.overrideEnv).toEqual({ HOPPER_GREETING: 'a $$b c', CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_CODE_OAUTH_TOKEN:-}', HOPPER_LAN_NAMES: 'x y' });
    expect(r.compose).not.toContain('t0');
    const o = carryOverride(SHIPPED, r.compose, undefined, r.overrideEnv);
    expect(parse(o.override!)).toEqual({ services: { hopper: { environment: r.overrideEnv } } });
  });
});
