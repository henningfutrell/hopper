// The trim (issue #2494, design.md "Hopper's own disk use" → "Part 9"), run for real: fstrim on the filesystem the
// machine's home is on, by sudo with no password when only root may and sudo lets it, and what it said. The script runs
// with a PATH of only the tools it needs and a fake fstrim and sudo, so the real ones on this machine are never asked.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTrim, trimArgv } from '../../src/client/trim.ts';

const TOOLS = ['sh', 'df', 'awk', 'sed', 'grep', 'tr', 'cut', 'head', 'id', 'timeout', 'cat'];
// The fake fstrim: with the file $FAKE/fails, and not as root (FAKE_ROOT, which the fake sudo sets), it prints that file and
// exits 1; else it prints $FAKE/fstrim-says and exits 0. Each call goes to $FAKE/calls.
const FAKE_FSTRIM = `#!/bin/sh
echo "fstrim $* root=\${FAKE_ROOT:-no}" >> "$FAKE/calls"
if [ -f "$FAKE/fails" ] && [ -z "$FAKE_ROOT" ]; then cat "$FAKE/fails"; exit 1; fi
cat "$FAKE/fstrim-says"
`;
// The fake sudo: lets `-n` through only when the file `sudo-ok` is there; runs the rest as root.
const FAKE_SUDO = `#!/bin/sh
echo "sudo $*" >> "$FAKE/calls"
[ -f "$FAKE/sudo-ok" ] || { echo "sudo: a password is required" >&2; exit 1; }
[ "$1" = -n ] && shift
[ "$1" = true ] && exit 0
FAKE_ROOT=yes exec "$@"
`;

let fake: string, bin: string;
beforeEach(() => {
  fake = mkdtempSync(join(tmpdir(), 'hopper-trim-'));
  bin = join(fake, 'bin');
  execFileSync('mkdir', [bin]);
  for (const t of TOOLS) {
    const at = execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim();
    if (at.startsWith('/')) symlinkSync(at, join(bin, t));
  }
  writeFileSync(join(fake, 'calls'), '');
  writeFileSync(join(fake, 'fstrim-says'), '');
});
afterEach(() => rmSync(fake, { recursive: true, force: true }));

const withFstrim = (): void => writeFileSync(join(bin, 'fstrim'), FAKE_FSTRIM, { mode: 0o755 });
const withSudo = (ok: boolean): void => {
  writeFileSync(join(bin, 'sudo'), FAKE_SUDO, { mode: 0o755 });
  if (ok) writeFileSync(join(fake, 'sudo-ok'), '');
};
const run = (env: NodeJS.ProcessEnv = {}): string => {
  const [file, ...args] = trimArgv();
  return execFileSync(file!, args, { encoding: 'utf8', env: { FAKE: fake, HOME: fake, PATH: bin, ...env }, timeout: 30000 });
};
// The mount point the home is on, as df says.
const mount = (): string => execFileSync('df', ['-P', fake], { encoding: 'utf8' }).split('\n')[1]!.split(/\s+/).slice(5).join(' ');
const calls = (): string[] => readFileSync(join(fake, 'calls'), 'utf8').split('\n').filter(Boolean);
const asRoot = process.getuid?.() === 0;

describe('the trim (issue #2494)', () => {
  it('runs fstrim on the filesystem the home is on, and says how much it trimmed', () => {
    withFstrim();
    writeFileSync(join(fake, 'fstrim-says'), `${mount()}: 1 GiB (1073741824 bytes) trimmed on /dev/fake\n`);
    expect(readTrim(run())).toMatchObject({ mount: mount(), outcome: 'trimmed', bytes: 1073741824 });
    expect(calls()).toEqual([`fstrim -v ${mount()} root=no`]);
  });

  it('a filesystem with no discard: unsupported, with what fstrim said', () => {
    withFstrim();
    writeFileSync(join(fake, 'fails'), `fstrim: ${mount()}: the discard operation is not supported\n`);
    expect(readTrim(run())).toMatchObject({ mount: mount(), outcome: 'unsupported', said: `fstrim: ${mount()}: the discard operation is not supported` });
  });

  it.skipIf(asRoot)('only root may, and there is no sudo: refused, with what fstrim said', () => {
    withFstrim();
    writeFileSync(join(fake, 'fails'), `fstrim: ${mount()}: FITRIM ioctl failed: Operation not permitted\n`);
    expect(readTrim(run())).toMatchObject({ outcome: 'refused', said: `fstrim: ${mount()}: FITRIM ioctl failed: Operation not permitted` });
  });

  it.skipIf(asRoot)('only root may, and sudo asks for a password: refused, and nothing waits on it', () => {
    withFstrim();
    withSudo(false);
    writeFileSync(join(fake, 'fails'), `fstrim: ${mount()}: FITRIM ioctl failed: Operation not permitted\n`);
    expect(readTrim(run())).toMatchObject({ outcome: 'refused' });
    expect(calls().filter((l) => l.startsWith('sudo'))).toEqual(['sudo -n true']);
  });

  it.skipIf(asRoot)('only root may, and sudo lets it with no password: fstrim by its full path, as root', () => {
    withFstrim();
    withSudo(true);
    writeFileSync(join(fake, 'fails'), `fstrim: ${mount()}: FITRIM ioctl failed: Operation not permitted\n`);
    writeFileSync(join(fake, 'fstrim-says'), `${mount()}: 2 GiB (2147483648 bytes) trimmed\n`);
    expect(readTrim(run())).toMatchObject({ outcome: 'trimmed', bytes: 2147483648 });
    expect(calls()).toContain(`sudo -n ${join(bin, 'fstrim')} -v ${mount()}`);
    expect(calls()).toContain(`fstrim -v ${mount()} root=yes`);
  });

  it('no fstrim there: unsupported', () => {
    expect(readTrim(run())).toMatchObject({ mount: mount(), outcome: 'unsupported', said: 'no fstrim' });
  });

  it('in WSL, says so: the host\'s virtual disk shrinks only by a compaction there', () => {
    withFstrim();
    expect(readTrim(run({ WSL_DISTRO_NAME: 'Ubuntu' }))).toMatchObject({ outcome: 'trimmed', wsl: true });
  });

  it('a trim that did not finish is undefined', () => {
    expect(readTrim('hopper-trim|/|trimmed|5\n')).toBeUndefined();
  });
});
