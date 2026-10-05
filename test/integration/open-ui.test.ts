// scripts/open-ui.sh: mints a login code with `hopper login-code` (the database from
// HOPPER_DATABASE_URL, else the daemon's env file), writes a 0600 auto-posting page, and opens
// that FILE — the code never appears on a command line. Run against a live daemon.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN_RE, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { rawRequest } from '../support/http.ts';
import { waitFor } from '../support/wait.ts';

const SCRIPT = fileURLToPath(new URL('../../scripts/open-ui.sh', import.meta.url));
let t: TestApp | undefined;
const dirs: string[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A PATH holding only rm/chmod and, optionally, an xdg-open that records its argv. */
function fakeBin(withXdgOpen: boolean): { bin: string; argvFile: string } {
  const bin = mkdtempSync(join(tmpdir(), 'jh-open-ui-'));
  dirs.push(bin);
  for (const tool of ['rm', 'chmod', 'mkdir', 'grep', 'head', 'cut']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
  symlinkSync(process.execPath, join(bin, 'node'));
  const argvFile = join(bin, 'argv.json');
  if (withXdgOpen) {
    writeFileSync(join(bin, 'xdg-open'), `#!/usr/bin/node\nrequire('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(join(bin, 'xdg-open'), 0o755);
  }
  return { bin, argvFile };
}

function run(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('/usr/bin/bash', [SCRIPT], { env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

describe('scripts/open-ui.sh', () => {
  it('writes a 0600 page auto-posting a fresh code to /ui/login and opens only its path; the page logs in', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    t = await startTestApp({ dbPath: db.dbPath });
    const port = new URL(t.url).port;
    const { bin, argvFile } = fakeBin(true);
    const runtime = mkdtempSync(join(tmpdir(), 'jh-open-ui-run-'));
    dirs.push(runtime);
    const r = await run({ PATH: bin, HOME: '/nonexistent', XDG_RUNTIME_DIR: runtime, HOPPER_DATABASE_URL: databaseUrlFor(db.dbPath), HOPPER_PORT: port });
    expect(r.code, r.stderr).toBe(0);
    const page = join(runtime, 'hopper', 'ui-login.html');
    expect(statSync(page).mode & 0o777).toBe(0o600);
    expect(statSync(join(runtime, 'hopper')).mode & 0o777).toBe(0o700);
    const html = readFileSync(page, 'utf8');
    const code = /name="code" value="([0-9a-f]{64})"/.exec(html)![1]!;
    expect(html).toContain(`action="http://127.0.0.1:${port}/ui/login"`);
    expect(html).toMatch(/method="post"/i);
    expect(html).toMatch(/\.submit\(\)/);
    const argv = await waitFor(() => existsSync(argvFile) && JSON.parse(readFileSync(argvFile, 'utf8')) as string[], { what: 'xdg-open to run' });
    expect(argv).toEqual([page]);
    expect(r.stdout + r.stderr).not.toContain(code);

    const res = await rawRequest(t.url, {
      method: 'POST', path: '/ui/login', body: `code=${code}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
    });
    expect(res.status).toBe(200);
    expect(TOKEN_RE.test(res.text)).toBe(true);
  });

  it('reads HOPPER_DATABASE_URL from the env file when it is not set, and prints the page path without xdg-open', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    t = await startTestApp({ dbPath: db.dbPath });
    const envDir = mkdtempSync(join(tmpdir(), 'jh-open-ui-env-'));
    dirs.push(envDir);
    const envFile = join(envDir, 'daemon.env');
    writeFileSync(envFile, `# comment\nGITHUB_APP_PRIVATE_KEY=-----BEGIN\\nx\nHOPPER_DATABASE_URL=${databaseUrlFor(db.dbPath)}\n`, { mode: 0o600 });
    const runtime = mkdtempSync(join(tmpdir(), 'jh-open-ui-run-'));
    dirs.push(runtime);
    const { bin } = fakeBin(false);
    const r = await run({ PATH: bin, HOME: '/nonexistent', XDG_RUNTIME_DIR: runtime, HOPPER_ENV_FILE: envFile });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(join(runtime, 'hopper', 'ui-login.html'));
    expect(readFileSync(join(runtime, 'hopper', 'ui-login.html'), 'utf8')).toContain('action="http://127.0.0.1:4790/ui/login"');
  });

  it('fails clearly, before anything is written, when no database is known', async () => {
    const runtime = mkdtempSync(join(tmpdir(), 'jh-open-ui-run-'));
    dirs.push(runtime);
    const { bin } = fakeBin(false);
    const r = await run({ PATH: bin, HOME: '/nonexistent', XDG_RUNTIME_DIR: runtime, HOPPER_ENV_FILE: join(runtime, 'missing.env') });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/HOPPER_DATABASE_URL/);
    expect(existsSync(join(runtime, 'hopper', 'ui-login.html'))).toBe(false);
  });
});
