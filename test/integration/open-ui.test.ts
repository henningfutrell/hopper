// scripts/open-ui.sh: reads the login code from the data dir, writes a 0600 auto-posting page,
// and opens that FILE — the code never appears on a command line. Run against a live daemon.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN_RE, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';

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
  for (const tool of ['rm', 'chmod']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
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
  it('writes a 0600 page auto-posting the code to /ui/login and opens only its path; the page logs in', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    t = await startTestApp({ dbPath: db.dbPath });
    const port = new URL(t.url).port;
    const { bin, argvFile } = fakeBin(true);
    const r = await run({ PATH: bin, HOME: '/nonexistent', JOB_HOPPER_DB: db.dbPath, JOB_HOPPER_PORT: port });
    expect(r.code, r.stderr).toBe(0);
    const page = join(t.dataDir, 'ui-login.html');
    expect(statSync(page).mode & 0o777).toBe(0o600);
    const code = readFileSync(join(t.dataDir, 'ui-login-code'), 'utf8').trim();
    const html = readFileSync(page, 'utf8');
    expect(html).toContain(`action="http://127.0.0.1:${port}/ui/login"`);
    expect(html).toMatch(/method="post"/i);
    expect(html).toContain(`value="${code}"`);
    expect(html).toMatch(/\.submit\(\)/);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    expect(argv).toEqual([page]);
    expect(r.stdout + r.stderr).not.toContain(code);

    const res = await rawRequest(t.url, {
      method: 'POST', path: '/ui/login', body: `code=${/name="code" value="([0-9a-f]+)"/.exec(html)![1]}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
    });
    expect(res.status).toBe(200);
    expect(TOKEN_RE.test(res.text)).toBe(true);
  });

  it('prints the page path when xdg-open is missing, and fails clearly when there is no code file', async () => {
    const data = mkdtempSync(join(tmpdir(), 'jh-open-ui-data-'));
    dirs.push(data);
    const { bin } = fakeBin(false);
    const env = { PATH: bin, HOME: '/nonexistent', JOB_HOPPER_DB: join(data, 'job-hopper.db') };
    const missing = await run(env);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain(join(data, 'ui-login-code'));
    writeFileSync(join(data, 'ui-login-code'), `${'c'.repeat(64)}\n`, { mode: 0o600 });
    const r = await run(env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(join(data, 'ui-login.html'));
    expect(r.stdout).not.toContain('c'.repeat(64));
    expect(readFileSync(join(data, 'ui-login.html'), 'utf8')).toContain('action="http://127.0.0.1:4790/ui/login"');
  });

  it('defaults the data dir to ~/.local/share/job-hopper', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jh-open-ui-home-'));
    dirs.push(home);
    const data = join(home, '.local/share/job-hopper');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'ui-login-code'), 'd'.repeat(64), { mode: 0o600 });
    const { bin } = fakeBin(false);
    const r = await run({ PATH: bin, HOME: home });
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(data, 'ui-login.html'))).toBe(true);
  });
});
