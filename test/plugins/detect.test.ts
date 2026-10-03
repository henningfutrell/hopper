import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDetectionKit } from '../../src/plugins/detect.ts';
import { useTempDirs } from './support.ts';

const temp = useTempDirs();

describe('detection kit (real)', () => {
  it('which: finds a binary on PATH, an absolute executable, and nothing else', async () => {
    const dir = temp();
    const bin = join(dir, 'tool');
    writeFileSync(bin, '#!/bin/sh\necho tool 2.3.4\n');
    chmodSync(bin, 0o755);
    const plain = join(dir, 'plain');
    writeFileSync(plain, 'not executable');
    const kit = createDetectionKit({ env: { PATH: `/nonexistent:${dir}` } });
    expect(await kit.which('tool')).toBe(bin);
    expect(await kit.which(bin)).toBe(bin);
    expect(await kit.which(plain)).toBeUndefined();
    expect(await kit.which('plain')).toBeUndefined();
    expect(await kit.which('no-such-binary-anywhere')).toBeUndefined();
  });

  it('version: first line of stdout; undefined on failure or timeout', async () => {
    const dir = temp();
    const tool = join(dir, 'tool');
    writeFileSync(tool, '#!/bin/sh\necho "tool 2.3.4"\necho second\n');
    const slow = join(dir, 'slow');
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n');
    const failing = join(dir, 'failing');
    writeFileSync(failing, '#!/bin/sh\nexit 3\n');
    for (const f of [tool, slow, failing]) chmodSync(f, 0o755);
    const kit = createDetectionKit({ env: { PATH: dir }, timeoutMs: 200 });
    expect(await kit.version('tool')).toBe('tool 2.3.4');
    const started = Date.now();
    expect(await kit.version('slow', ['--version'])).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await kit.version('failing')).toBeUndefined();
    expect(await kit.version('/nonexistent/x')).toBeUndefined();
  });

  it('the version timeout is 5 s by default', () => {
    expect(createDetectionKit().timeoutMs).toBe(5000);
  });

  it('exists, env', async () => {
    const dir = temp();
    const kit = createDetectionKit({ env: { JH_X: 'y' } });
    expect(await kit.exists(dir)).toBe(true);
    expect(await kit.exists(join(dir, 'missing'))).toBe(false);
    expect(kit.env('JH_X')).toBe('y');
    expect(kit.env('JH_MISSING')).toBeUndefined();
  });

  it('pythonImports: true for a stdlib module, false for a missing one or a missing python', async () => {
    const kit = createDetectionKit();
    expect(await kit.pythonImports('python3', 'json')).toBe(true);
    expect(await kit.pythonImports('python3', 'job_hopper_no_such_module')).toBe(false);
    expect(await kit.pythonImports('/nonexistent/python', 'json')).toBe(false);
  });
});
