// scripts/hopper.ps1 and scripts/hopper.cmd (issue #712): the hopper CLI on Windows, for a hopper in WSL. Each runs
// `hopper` with the person's arguments in the hopper's container, through wsl.exe and podman exec, with the
// credentials the CLI already has there; Windows keeps none. They find the container by its compose labels, never by
// a fixed name, since the name changes with the compose project. `hopper autostart on|off|status` keeps the distro, and
// the hopper in it, running after a Windows sign-in and after wsl --shutdown, with no admin rights (docs/deploy.md
// "Keep it running on Windows"). Windows has no runner here, so these read the files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');
const ps1 = read('scripts', 'hopper.ps1');
const cmd = read('scripts', 'hopper.cmd');
const page = read('site', 'install.html');
const project = /^name: (\S+)$/m.exec(read('compose.yaml'))?.[1];

describe.each([['hopper.ps1', ps1], ['hopper.cmd', cmd]])('%s', (_name, script) => {
  const code = script.split(/\r?\n/).filter((l) => !/^\s*(#|rem\b|@rem\b)/i.test(l)).join('\n');

  it('finds the hopper container by its compose project and service labels, never by a fixed name', () => {
    expect(code).toMatch(/podman ps -q --filter "?label\^?=com\.docker\.compose\.project\^?=/);
    expect(code).toMatch(/--filter "?'?label\^?=com\.docker\.compose\.service\^?=hopper/);
    expect(code).not.toMatch(/hopper[_-]hopper[_-]1/);
  });

  it('takes the project from HOPPER_COMPOSE_PROJECT, else compose.yaml\'s name', () => {
    expect(project).toBe('hopper');
    expect(code).toContain('HOPPER_COMPOSE_PROJECT');
    expect(code).toMatch(/else \{ 'hopper' \}|set "HOPPER_PROJECT=hopper"/);
  });

  it('runs in the distro HOPPER_WSL_DISTRO names, else WSL\'s default one, with no shell between', () => {
    expect(code).toContain('HOPPER_WSL_DISTRO');
    expect(code).toContain('-d');
    const calls = code.match(/wsl\.exe [^\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toMatch(/^wsl\.exe (@wsl|%HOPPER_WSL%) -e /);
      expect(call).not.toMatch(/ -e (sh|bash)\b/);
    }
    expect(code.match(/wsl\.exe [^\n]* -e podman /g)?.length).toBe(2);
  });

  it('runs the CLI in the container with every argument, and ends with its exit code', () => {
    expect(code).toMatch(/podman (@exec|exec -i) [^\n]*hopper (@args|%\*)/);
    expect(code).toMatch(/exit (\$LASTEXITCODE|\/b %ERRORLEVEL%)/);
  });

  it('says what to do when no hopper container runs', () => {
    expect(script).toContain('podman compose up -d');
  });

  it('keeps no token and reads no credential on Windows', () => {
    expect(code).not.toMatch(/TOKEN|HOPPER_DATABASE_URL|password/i);
  });

  it('has Windows line endings', () => {
    expect(script).toContain('\r\n');
    expect(script.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('hopper.ps1', () => {
  it('gives the CLI a terminal only when PowerShell has one', () => {
    expect(ps1).toContain('[Console]::IsInputRedirected');
    expect(ps1).toContain('[Console]::IsOutputRedirected');
  });
});

describe('hopper autostart (docs/deploy.md "Keep it running on Windows")', () => {
  it('in hopper.cmd, runs hopper.ps1 from its own folder, and says how to get it when it is missing', () => {
    expect(cmd).toMatch(/if \/i "%~1"=="autostart" goto autostart/);
    expect(cmd).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0hopper.ps1" %*');
    expect(cmd).toContain('https://henningfutrell.github.io/hopper/hopper.ps1');
  });

  it('takes on, off and status, and nothing else', () => {
    expect(ps1).toMatch(/\$args\[0\] -eq 'autostart'/);
    for (const action of ['on', 'off', 'status']) expect(ps1).toContain(`'${action}' {`);
    expect(ps1).toContain('usage: hopper autostart on|off|status');
  });

  it('on: refuses without systemd, with the /etc/wsl.conf fix', () => {
    expect(ps1).toContain("@('cat', '/proc/1/comm')");
    expect(ps1).toContain('systemd=true');
    expect(ps1).toContain('/etc/wsl.conf');
    expect(ps1).toContain('wsl --shutdown');
  });

  it('on: turns on linger, through sudo, and enables podman-restart.service', () => {
    expect(ps1).toContain('-e sudo loginctl enable-linger $user');
    expect(ps1).toContain('-e systemctl --user enable podman-restart.service');
  });

  it('on: writes a keep-alive loop under %LOCALAPPDATA%\\hopper that starts the distro again 5 s after it ends', () => {
    expect(ps1).toContain("Join-Path $env:LOCALAPPDATA 'hopper'");
    expect(ps1).toContain("'  & wsl.exe @wsl -e sleep infinity'");
    expect(ps1).toContain("'  Start-Sleep -Seconds 5'");
  });

  it('on: adds a hidden Startup-folder shortcut for this user only, and starts the loop now', () => {
    expect(ps1).toContain("[Environment]::GetFolderPath('Startup')");
    expect(ps1).not.toMatch(/CommonStartup|Register-ScheduledTask|schtasks|RunAs/);
    expect(ps1).toContain('-WindowStyle Hidden');
    expect(ps1).toContain('Start-Process $powershell -WindowStyle Hidden');
  });

  it('on and off: use the shortcut name of the install page and see its loop, so the distro never gets two loops', () => {
    expect(ps1).toContain("'hopper-wsl.lnk'");
    expect(page).toContain('Startup\\hopper-wsl.lnk');
    expect(ps1).toContain("Contains('-e sleep infinity; Start-Sleep')");
    expect(page).toContain('-e sleep infinity; Start-Sleep -Seconds 5');
  });

  it('off: stops the loop and removes the shortcut, and changes nothing in the distro', () => {
    const off = ps1.slice(ps1.indexOf("'off' {"), ps1.indexOf("'status' {"));
    expect(off).toContain('Stop-Process');
    expect(off).toContain('Remove-Item');
    expect(off).not.toContain('wsl.exe');
  });

  it('status: says whether each of the four parts is on, and exits 1 when one is not', () => {
    const status = ps1.slice(ps1.indexOf("'status' {"), ps1.indexOf('default {'));
    for (const part of ['Startup shortcut', 'keep-alive loop runs', 'linger is on', 'podman-restart.service is enabled']) {
      expect(status).toContain(part);
    }
    expect(status).toContain('exit 1');
  });
});
