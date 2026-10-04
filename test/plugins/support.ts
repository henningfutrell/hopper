// Helpers for the plugin tests: a scripted DetectionKit (the ports seam for detection), temp
// directories, and custom plugin modules written to disk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { DetectionKit } from '../../src/plugins/sdk.ts';

export const fixedClock = { now: () => new Date('2026-10-03T12:00:00.000Z') };

/** Everything present and importable unless overridden. */
export function fakeKit(over: Partial<DetectionKit> = {}): DetectionKit {
  return {
    which: async (bin) => (bin.startsWith('/') ? bin : `/usr/bin/${bin}`),
    version: async () => '1.0.0',
    succeeds: async () => true,
    exists: async () => true,
    readable: async () => true,
    pythonImports: async () => true,
    env: () => undefined,
    ...over,
  };
}

/** Temp directories, removed after each test. */
export function useTempDirs() {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  return () => {
    const d = mkdtempSync(join(tmpdir(), 'jh-plugins-'));
    dirs.push(d);
    return d;
  };
}

/** Write `<dir>/<name>/<file>` with `source`; returns the module path. */
export function writePlugin(dir: string, name: string, source: string, file = 'index.ts'): string {
  mkdirSync(join(dir, name), { recursive: true, mode: 0o700 });
  const path = join(dir, name, file);
  writeFileSync(path, source, { mode: 0o600 });
  return path;
}

/** The documented example plugin (design.md "Plugin contract"), type-checked through `job-hopper/plugin`. */
export const ALWAYS_PROCEED_DIR = join(import.meta.dirname, 'fixtures', 'always-proceed');
