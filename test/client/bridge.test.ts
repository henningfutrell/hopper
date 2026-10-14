// The bridge release (issue #545, design.md "Client releases" → "Clients with a fixed file list"): a client
// released before manifests checks a load against a list of file names fixed in its own release.ts, so it
// refuses any release with other files. The bridge is a release made of exactly the names it accepts,
// with the id it computes; its main.ts carries the hopper's release, writes it over the install dir and
// exits 75, so whatever runs the client starts the hopper's release. Tested against the field client
// itself: release 835e17bd3c9c6ac3, its files kept verbatim in test/fixtures.
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readRelease } from '../../src/client/release.ts';
import { bridgeRelease, fixedNamesOf } from '../../src/machines/client-bridge.ts';
import * as field from '../fixtures/client-835e17bd3c9c6ac3/release.ts';

const SRC = fileURLToPath(new URL('../../src/client', import.meta.url));
const FIELD = fileURLToPath(new URL('../fixtures/client-835e17bd3c9c6ac3', import.meta.url));
const HOPPERS = readRelease(SRC);

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `node <install>/main.ts` as a client's unit does; resolves its exit code. */
const runMain = (install: string): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
  execFile(process.execPath, [join(install, 'main.ts')], { cwd: dir, encoding: 'utf8', timeout: 20000 }, (err, stdout, stderr) => {
    resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
  });
});

describe('the bridge release, for a client with a fixed file list', () => {
  it('is believed by the field client\'s own check: exactly its names, the id it computes', () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-bridge-'));
    expect(field.releaseId(readRelease(FIELD).files)).toBe('835e17bd3c9c6ac3');
    const bridge = bridgeRelease(HOPPERS, field.CLIENT_FILES);
    expect(Object.keys(bridge.files).sort()).toEqual([...field.CLIENT_FILES].sort());
    expect(field.checkRelease(bridge)).toEqual(bridge);
    // The field client reads a body of at most 1 MiB.
    expect(Buffer.byteLength(JSON.stringify({ release: bridge }))).toBeLessThan(1024 * 1024);
  });

  it('loaded by the field client and started: the hopper\'s release is in the install dir, and it exits 75 to be started again', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-bridge-'));
    const install = join(dir, 'hopper-client');
    cpSync(FIELD, install, { recursive: true });
    field.installRelease(install, bridgeRelease(HOPPERS, field.CLIENT_FILES));
    const run = await runMain(install);
    expect(run.code, run.stderr).toBe(75);
    expect(run.stdout).toContain(`unpacked release ${HOPPERS.id}`);
    expect(readRelease(install)).toEqual(HOPPERS);
    // The release before the bridge stays beside it, for a rollback by hand.
    expect(readFileSync(join(`${install}.prev`, 'server.ts'), 'utf8')).toBe(readFileSync(join(FIELD, 'server.ts'), 'utf8'));
    expect(existsSync(`${install}.next`)).toBe(false);
  });

  it('the names a fixed list holds are read from the field client\'s refusal', () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-bridge-'));
    const refusal = field.checkRelease(HOPPERS);
    expect(typeof refusal).toBe('string');
    expect(fixedNamesOf(`client studio: 400 ${JSON.stringify({ error: refusal })}`)).toEqual([...field.CLIENT_FILES]);
    expect(fixedNamesOf('client studio: 400 {"error":"body must be JSON"}')).toBeUndefined();
  });
});
