// The client release (issues #70, #545, design.md "Client releases"): the hopper client's files as the
// hopper holds them, their manifest (each file's SHA-256) and the id that names it. The hopper loads its
// release onto a client target whose release differs; the client checks the release against the manifest
// it carries before it writes a byte, and swaps it in whole. No list of file names is fixed in the client:
// a release may add, remove or rename files.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRelease, installRelease, readRelease, releaseOf } from '../../src/client/release.ts';

const SRC = fileURLToPath(new URL('../../src/client', import.meta.url));

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the client release', () => {
  it('is every client file in the client\'s directory, and nothing the client does not run', () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-rel-'));
    const release = readRelease(SRC);
    expect(Object.keys(release.files).sort()).toEqual(readdirSync(SRC).filter((f) => f.endsWith('.ts')).sort());
    expect(Object.keys(release.files)).toContain('main.ts');
    expect(release.files['server.ts']).toBe(readFileSync(join(SRC, 'server.ts'), 'utf8'));
  });

  it('carries its manifest: each file\'s SHA-256; its id is the manifest\'s', () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-rel-'));
    const { id, manifest, files } = readRelease(SRC);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(manifest).sort()).toEqual(Object.keys(files).sort());
    for (const hash of Object.values(manifest)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(releaseOf(files).id).toBe(id);
    expect(releaseOf({ ...files, 'main.ts': `${files['main.ts']} ` }).id).not.toBe(id);
    expect(releaseOf({ ...files, 'extra.ts': '' }).id).not.toBe(id);
  });

  it('a release that adds, removes or renames files is believed: the manifest names them, not the client', () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-rel-'));
    const { files } = readRelease(SRC);
    const { ['work-tree.ts']: tree, ...fewer } = files;
    for (const f of [{ ...files, 'added.ts': 'export {};\n' }, fewer, { ...fewer, 'renamed.ts': tree! }]) {
      const release = releaseOf(f);
      expect(checkRelease(release)).toEqual(release);
    }
  });

  it('is believed only when every file is the manifest\'s, the manifest is the id\'s, and the names are plain client files', () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-rel-'));
    const good = readRelease(SRC);
    expect(checkRelease(good)).toEqual(good);
    expect(checkRelease({ ...good, id: '0123456789abcdef' })).toMatch(/id/);
    expect(checkRelease({ ...good, files: { ...good.files, 'main.ts': 'changed' } })).toMatch(/main\.ts.*manifest/);
    const { ['dial.ts']: _gone, ...missing } = good.files;
    expect(checkRelease({ ...good, files: missing })).toMatch(/dial\.ts/);
    for (const name of ['../../.bashrc', 'sub/x.ts', 'x.js', '.hidden.ts', 'X.ts']) {
      expect(checkRelease(releaseOf({ ...good.files, [name]: 'x' })), name).toMatch(/name/);
    }
    const { ['main.ts']: _main, ...headless } = good.files;
    expect(checkRelease(releaseOf(headless))).toMatch(/main\.ts/);
    expect(checkRelease({ ...good, files: { ...good.files, 'main.ts': 7 } })).toMatch(/text/);
    expect(checkRelease('nope')).toMatch(/release/);
  });

  it('installs whole: exactly its files in the install dir, the old ones kept beside it as .prev', () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-rel-'));
    const install = join(dir, 'hopper-client');
    const release = readRelease(SRC);
    installRelease(install, releaseOf({ 'main.ts': 'old main.ts', 'gone.ts': 'a file the new release drops' }));
    writeFileSync(join(install, 'stray.txt'), 'left by hand');
    installRelease(install, release);
    expect(readRelease(install)).toEqual(release);
    expect(readdirSync(install).sort()).toEqual(Object.keys(release.files).sort());
    expect(readFileSync(join(`${install}.prev`, 'main.ts'), 'utf8')).toBe('old main.ts');
    expect(existsSync(`${install}.next`)).toBe(false);
  });
});
