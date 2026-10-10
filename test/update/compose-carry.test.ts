// Issue #697: compose.yaml is the one the image ships with, replaced whole at each update, so what an install changed in it moves
// to .env first: the published port's bind address, the port, and the hopper's own settings. What cannot move by
// itself (a service of the install's own) is named, so a person moves it to compose.override.yaml.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { carryLocalSettings } from '../../src/update/compose-carry.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SHIPPED = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
const OLD_LAN = readFileSync(join(ROOT, 'test', 'fixtures', 'compose', 'old-lan.yaml'), 'utf8');

/** The shipped compose.yaml with the hopper's published port replaced by `port`. */
const withPort = (port: string): string => SHIPPED.replace(/^ {6}- "\$\{HOPPER_BIND[^\n]*$/m, `      - "${port}"`);

describe('carrying an install\'s own settings out of its compose.yaml (issue #697)', () => {
  it('carries nothing from the shipped compose.yaml itself', () => {
    expect(carryLocalSettings(SHIPPED, SHIPPED)).toEqual({ env: [], notes: [] });
  });

  it('moves an old LAN install\'s bind address, LAN names and public URL to .env lines, and names its own service', () => {
    const r = carryLocalSettings(OLD_LAN, SHIPPED);
    expect(r.env).toEqual(['HOPPER_BIND=0.0.0.0', 'HOPPER_LAN_NAMES=hopper,lanbox', 'HOPPER_PUBLIC_URL=https://hopper.example.test']);
    expect(r.notes).toEqual([expect.stringMatching(/service whoami .*compose\.override\.yaml/)]);
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
