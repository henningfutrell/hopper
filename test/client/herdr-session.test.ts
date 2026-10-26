// Issue #2802: a reinstalled Windows client's herdr session opened its panes in PowerShell, and every job there failed:
// the Git Bash config that fixed it (issue #367) was the person's own, outside the hopper. Now the client on Windows
// writes its own herdr config (Git Bash, a login shell that stays in the cwd) and starts its session's server itself,
// when none runs.
//
// Feature: a Windows client's herdr session opens its panes in a POSIX shell
//   Scenario: Git Bash is found from the sh on the PATH, never WSL's bash
//   Scenario: the client writes its herdr config and runs herdr with it
//   Scenario: a herdr call that no server answered starts the server with that config, and runs again
//   Scenario: no Git Bash, or a herdr config the machine names, is said at start
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clientHerdr } from '../../src/executors/client.ts';
import { gitBashOf, HERDR_CONFIG_FILE, herdrConfigText, ownHerdrOf } from '../../src/client/herdr-session.ts';
import { startTestClient, type TestClient } from '../support/client.ts';

const TOKEN = 'c'.repeat(43);
const GIT = 'C:\\Program Files\\Git';
const BASH = `${GIT}\\bin\\bash.exe`;
const has = (...paths: string[]) => (p: string): boolean => paths.includes(p);

let c: TestClient | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await c?.stop();
  c = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'jh-2802-')); dirs.push(d); return d; };

describe('Git Bash on a Windows machine', () => {
  it('is the bash.exe of the Git whose sh.exe is on the PATH', () => {
    const env = { Path: `C:\\Windows\\System32;D:\\Tools\\Git\\usr\\bin;${GIT}\\cmd`, SystemRoot: 'C:\\WINDOWS' };
    expect(gitBashOf(env, has('D:\\Tools\\Git\\usr\\bin\\sh.exe', 'D:\\Tools\\Git\\bin\\bash.exe', BASH))).toBe('D:\\Tools\\Git\\bin\\bash.exe');
  });

  it('is never the bash.exe under the Windows dir (WSL\'s)', () => {
    const env = { PATH: 'C:\\Windows\\System32', SYSTEMROOT: 'C:\\Windows' };
    expect(gitBashOf(env, has('C:\\Windows\\System32\\sh.exe', 'C:\\Windows\\System32\\bash.exe'))).toBeUndefined();
  });

  it('else is Git for Windows in Program Files, or in the user\'s programs', () => {
    expect(gitBashOf({ PATH: '', ProgramFiles: 'C:\\Program Files' }, has(BASH))).toBe(BASH);
    const user = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe';
    expect(gitBashOf({ PATH: '', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, has(user))).toBe(user);
  });
});

describe('the client\'s herdr config', () => {
  it('names Git Bash as the default shell, as a login shell', () => {
    const text = herdrConfigText(BASH);
    expect(text).toContain('[terminal]');
    expect(text).toContain('default_shell = "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe"');
    expect(text).toContain('shell_mode = "login"');
  });

  it('is written to the client dir on Windows, and herdr runs with it and CHERE_INVOKING', () => {
    const dir = tempDir();
    const got = ownHerdrOf({ platform: 'win32', env: { PATH: '', ProgramFiles: 'C:\\Program Files' }, dir, herdrBin: 'herdr', session: 'hopper-client', exists: has(BASH) });
    expect(readFileSync(join(dir, HERDR_CONFIG_FILE), 'utf8')).toBe(herdrConfigText(BASH));
    expect(got.own?.env).toMatchObject({ HERDR_CONFIG_PATH: join(dir, HERDR_CONFIG_FILE), CHERE_INVOKING: '1' });
    expect(got.said).toContain('Git Bash');
  });

  it('is none off Windows', () => {
    expect(ownHerdrOf({ platform: 'linux', env: {}, dir: tempDir(), herdrBin: 'herdr', session: 's' })).toEqual({});
  });

  it('is none, said at start, with no Git Bash or with a herdr config the machine names', () => {
    const none = ownHerdrOf({ platform: 'win32', env: { PATH: '' }, dir: tempDir(), herdrBin: 'herdr', session: 's', exists: () => false });
    expect(none.own).toBeUndefined();
    expect(none.said).toMatch(/no Git Bash .* PowerShell/);
    const mine = ownHerdrOf({ platform: 'win32', env: { HERDR_CONFIG_PATH: 'C:\\herdr.toml' }, dir: tempDir(), herdrBin: 'herdr', session: 's', exists: has(BASH) });
    expect(mine.own).toBeUndefined();
    expect(mine.said).toContain('C:\\herdr.toml');
  });
});

describe('a herdr call on a Windows client with no server running', () => {
  it('starts the session\'s server with the client\'s config, and runs again', async () => {
    const dir = tempDir();
    const running = join(dir, 'running');
    const bin = join(dir, 'herdr');
    // A herdr whose server only marks that it runs, and keeps the environment it started with.
    writeFileSync(bin, `#!/bin/sh
[ "$3" = server ] && { printf '%s %s\\n' "$HERDR_CONFIG_PATH" "$CHERE_INVOKING" > '${running}'; exit 0; }
[ -e '${running}' ] || { echo '{"error":{"code":"server_not_running","message":"no herdr server is running"}}'; exit 1; }
echo "{\\"result\\":{\\"config\\":\\"$HERDR_CONFIG_PATH\\"}}"
`);
    chmodSync(bin, 0o755);
    const own = ownHerdrOf({ platform: 'win32', env: { ...process.env, PATH: process.env.PATH ?? '', ProgramFiles: 'C:\\Program Files' }, dir, herdrBin: bin, session: 'hopper', exists: has(BASH) }).own!;
    c = await startTestClient({ token: () => TOKEN, herdrBin: bin, session: 'hopper', ownHerdr: own });
    const r = await clientHerdr(c.transport(TOKEN, 'win'), ['workspace', 'list'], 15_000);
    const config = join(dir, HERDR_CONFIG_FILE);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout).toContain(config);
    expect(existsSync(running) && readFileSync(running, 'utf8')).toBe(`${config} 1\n`);
  });
});
