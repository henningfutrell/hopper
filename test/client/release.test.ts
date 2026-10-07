// The client release (issue #70, design.md "Client releases"): the hopper client's files as the hopper
// holds them, and the id that names them. The hopper loads its release onto a client target whose
// release differs; the client checks the release before it writes a byte, and swaps it in whole.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_FILES, checkRelease, installRelease, readRelease, releaseId } from '../../src/client/release.ts';

const SRC = fileURLToPath(new URL('../../src/client', import.meta.url));

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the client release', () => {
  it('is every client file, and nothing the client does not run (the relay stays on the hopper)', () => {
    const release = readRelease(SRC);
    expect(Object.keys(release.files).sort()).toEqual([...CLIENT_FILES].sort());
    expect(Object.keys(release.files)).not.toContain('relay.ts');
    expect(release.files['server.ts']).toBe(readFileSync(join(SRC, 'server.ts'), 'utf8'));
    dir = mkdtempSync(join(tmpdir(), 'jh-rel-'));
  });

  it('its id is the files\' content: the same files, the same id; one byte more, another', () => {
    const { id, files } = readRelease(SRC);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(releaseId(files)).toBe(id);
    expect(releaseId({ ...files, 'main.ts': `${files['main.ts']} ` })).not.toBe(id);
    dir = mkdtempSync(join(tmpdir(), 'jh-rel-'));
  });

  it('a release is believed only whole, with the id its files have, and only the client\'s file names', () => {
    const good = readRelease(SRC);
    expect(checkRelease(good)).toEqual(good);
    expect(checkRelease({ ...good, id: '0123456789abcdef' })).toMatch(/id/);
    const { ['dial.ts']: _gone, ...missing } = good.files;
    expect(checkRelease({ id: releaseId(missing as Record<string, string>), files: missing })).toMatch(/files/);
    const extra = { ...good.files, '../../.bashrc': 'x' };
    expect(checkRelease({ id: releaseId(extra), files: extra })).toMatch(/files/);
    expect(checkRelease('nope')).toMatch(/release/);
    dir = mkdtempSync(join(tmpdir(), 'jh-rel-'));
  });

  it('installs whole: the new files in the install dir, the old ones kept beside it as .prev', () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-rel-'));
    const install = join(dir, 'hopper-client');
    const release = readRelease(SRC);
    installRelease(install, { id: 'x', files: Object.fromEntries(CLIENT_FILES.map((f) => [f, `old ${f}`])) });
    writeFileSync(join(install, 'stray.txt'), 'left by hand');
    installRelease(install, release);
    expect(readRelease(install)).toEqual(release);
    expect(readdirSync(install).sort()).toEqual([...CLIENT_FILES].sort());
    expect(readFileSync(join(`${install}.prev`, 'main.ts'), 'utf8')).toBe('old main.ts');
    expect(existsSync(`${install}.next`)).toBe(false);
  });
});
