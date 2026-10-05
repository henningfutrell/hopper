// The install page on GitHub Pages (issue #113): site/index.html gives one install command, which
// fetches install.sh from the same site; .github/workflows/pages.yml publishes scripts/get.sh as that
// install.sh. Every hopper script the page tells you to run must exist in scripts/. Windows installs
// the same way, inside WSL (issue #116).
// Issue #115: the page is the main install path for someone new, so it says where to get every
// prerequisite, checks them in one command, and walks through to a first finished job (gh CLI only).
// Issue #125: the recommended path is the published image with Podman; the host install is the other way.
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
    const named = [...page.matchAll(/hopper\/scripts\/([\w-]+\.sh)/g)].map((m) => m[1] ?? '');
    expect(named.length).toBeGreaterThan(0);
    for (const script of new Set(named)) expect(existsSync(join(ROOT, 'scripts', script)), script).toBe(true);
  });

  it('loads nothing from another site', () => {
    expect(page).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
  });

  it('says where to get each prerequisite, not only that it is needed', () => {
    for (const source of ['https://herdr.dev', 'https://nodejs.org', 'https://docs.docker.com', 'https://cli.github.com', 'https://claude.ai/install.sh'])
      expect(page, source).toContain(source);
  });

  it('says the service runs /usr/bin/node, so a Node.js from nvm will not do', () => {
    expect(page).toContain('the service runs <code>/usr/bin/node</code>, so a Node.js from nvm or fnm will not do');
  });

  it('checks every prerequisite with one command to copy', () => {
    expect(page).toMatch(/data-copy="for c in [^"]*herdr/);
  });

  it('keeps the services running after logout as a step, not a footnote', () => {
    expect(page).toMatch(/<h[23][^>]*>[^<]*[Kk]eep it running/);
    expect(page).toContain('loginctl enable-linger');
  });

  it('walks to a first job: the hopper label is created, and a job is picked up within a minute', () => {
    expect(page).toContain('gh label create hopper');
    expect(page).toMatch(/within a minute/);
  });

  it('reaches the UI of a host without a browser through an ssh tunnel', () => {
    expect(page).toContain('ssh -L 4790:127.0.0.1:4790');
  });

  it('keeps the Podman containers running after a reboot: podman-restart and lingering', () => {
    const podman = page.slice(page.indexOf('id="podman"'), page.indexOf('id="first-job"'));
    expect(podman).toContain('systemctl --user enable podman-restart.service');
    expect(podman).toContain('loginctl enable-linger');
  });

  it('covers the gh CLI path only, not a GitHub App (issue #113)', () => {
    expect(page).not.toMatch(/GitHub App/);
  });
});

describe('the Windows install (WSL)', () => {
  const windows = page.slice(page.indexOf('id="windows"'));

  it('has its own section, linked from the top of the page', () => {
    expect(page).toContain('href="#windows"');
    expect(windows.length).toBeLessThan(page.length);
  });

  it('runs the hopper with Podman inside WSL, the same steps as on Linux (issue #125)', () => {
    expect(windows).toContain('sudo apt-get install -y podman podman-compose');
    expect(windows).toContain('href="#podman"');
  });

  it('sets up WSL with systemd, then runs the same one-line install inside it', () => {
    expect(windows).toContain('data-copy="wsl --install -d Ubuntu-24.04"');
    expect(windows).toContain('systemd=true');
    expect(windows).toContain('wsl --shutdown');
    expect(windows).toContain(`data-copy="${INSTALL}"`);
  });

  it('signs the Windows browser in with a login link', () => {
    expect(windows).toContain('hopper login-code --link http://127.0.0.1:4790');
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
