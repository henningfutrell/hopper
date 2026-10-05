// The install page on GitHub Pages (issue #113): site/index.html gives one install command, which
// fetches install.sh from the same site; .github/workflows/pages.yml publishes scripts/get.sh as that
// install.sh. Every hopper script the page tells you to run must exist in scripts/. Windows installs
// the same way, inside WSL (issue #116).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const page = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');

const INSTALL = 'curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash';

describe('the install page', () => {
  it('gives the one-line install from the Pages site, as a command to copy', () => {
    expect(page).toContain(`data-copy="${INSTALL}"`);
  });

  it('is published with scripts/get.sh as its install.sh, and republished when get.sh changes', () => {
    expect(workflow).toMatch(/cp scripts\/get\.sh site\/install\.sh/);
    expect(workflow).toMatch(/paths:.*scripts\/get\.sh/);
  });

  it('names only hopper scripts that exist', () => {
    const named = [...page.matchAll(/job-hopper\/scripts\/([\w-]+\.sh)/g)].map((m) => m[1] ?? '');
    expect(named.length).toBeGreaterThan(0);
    for (const script of new Set(named)) expect(existsSync(join(ROOT, 'scripts', script)), script).toBe(true);
  });

  it('loads nothing from another site', () => {
    expect(page).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
  });
});

describe('the Windows install (WSL)', () => {
  const windows = page.slice(page.indexOf('id="windows"'));

  it('has its own section, linked from the top of the page', () => {
    expect(page).toContain('href="#windows"');
    expect(windows.length).toBeLessThan(page.length);
  });

  it('sets up WSL with systemd, then runs the same one-line install inside it', () => {
    expect(windows).toContain('data-copy="wsl --install -d Ubuntu-24.04"');
    expect(windows).toContain('systemd=true');
    expect(windows).toContain('wsl --shutdown');
    expect(windows).toContain(`data-copy="${INSTALL}"`);
  });

  it('signs the Windows browser in with a login link', () => {
    expect(windows).toContain('job-hopper login-code --link http://127.0.0.1:4790');
  });
});

describe('get.sh without a running systemd (WSL with systemd off)', () => {
  it('stops before cloning, and says how to turn systemd on in WSL', () => {
    const bin = mkdtempSync(join(tmpdir(), 'get-sh-bin-'));
    const fake = (name: string, body: string): void => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    fake('git', 'echo "git ran: $*" >&2; exit 3');
    fake('npm', 'exit 0');
    fake('node', 'echo v24.0.0');
    fake('systemctl', 'echo "System has not been booted with systemd as init system (PID 1). Can\'t operate." >&2; exit 1');
    const run = spawnSync('bash', [join(ROOT, 'scripts', 'get.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('systemd');
    expect(run.stderr).toContain('/etc/wsl.conf');
    expect(run.stderr).toContain('wsl --shutdown');
    expect(run.stderr).not.toContain('git ran');
  });
});
