// scripts/hopper.ps1 and scripts/hopper.cmd (issue #712): the hopper CLI on Windows, for a hopper in WSL. Each runs
// `hopper` with the person's arguments in the hopper's container, through wsl.exe and podman exec, with the
// credentials the CLI already has there; Windows keeps none. They find the container by its compose labels, never by
// a fixed name, since the name changes with the compose project. `hopper autostart on|off|status` keeps the distro, and
// the hopper in it, running after a Windows sign-in and after wsl --shutdown, with no admin rights (docs/deploy.md
// "Keep it running on Windows"). `hopper doctor` checks, from Windows, what a hopper in WSL needs, and gives the fix for
// each check that fails (docs/deploy.md "Check it from Windows"). Windows has no runner here, so these read the files.
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
    const calls = (code.match(/wsl\.exe [^\n]*/g) ?? []).filter((c) => !c.startsWith('wsl.exe -ArgumentList'));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toMatch(/^wsl\.exe (@wsl|%HOPPER_WSL%) -e /);
      expect(call).not.toMatch(/ -e (sh|bash)\b/);
    }
    // hopper.ps1's keep-alive loop finds the container and runs the CLI too, to report the Windows link.
    expect(code.match(/wsl\.exe [^\n]* -e podman /g)?.length).toBe(script === ps1 ? 4 : 2);
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
  const loop = ps1.slice(ps1.indexOf("$body = @'"), ps1.indexOf("'@", ps1.indexOf("$body = @'")));
  it('in hopper.cmd, runs hopper.ps1 from its own folder, and says how to get it when it is missing', () => {
    expect(cmd).toMatch(/if \/i "%~1"=="autostart" goto ps1/);
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
    expect(loop).toContain("Start-Process wsl.exe -ArgumentList (@($wsl) + @('-e', 'sleep', 'infinity')) -WindowStyle Hidden -PassThru");
    expect(loop).toContain('$keep.HasExited');
    expect(loop).toContain('Start-Sleep -Seconds 5');
  });

  it('on: the loop reports the Windows link through the CLI, at most every 5 minutes, with no token', () => {
    expect(loop).toContain('AddMinutes(5)');
    expect(loop).not.toContain('/api/health');
    expect(loop).toContain("$urls = @('http://localhost:__PORT__/job/address', 'http://127.0.0.1:__PORT__/job/address')");
    expect(loop).toContain('foreach ($u in $urls)');
    expect(ps1).toContain("if ($env:HOPPER_PORT) { $env:HOPPER_PORT } else { '4790' }");
    expect(loop).toContain('Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri $u');
    expect(loop).toContain("@('--status', [string][int]$_.Exception.Response.StatusCode)");
    expect(loop).toContain("& wsl.exe @wsl -e wslinfo --networking-mode");
    expect(loop).toContain('-e podman exec $container.Trim() hopper windows-link report --link $url @result');
    expect(loop).not.toMatch(/TOKEN|Authorization|password/i);
  });

  it('on: a loop that runs now is stopped, so the new loop runs in its place', () => {
    const on = ps1.slice(ps1.indexOf("'on' {"), ps1.indexOf("'off' {"));
    expect(on.indexOf('Stop-Loops $running')).toBeLessThan(on.indexOf('Start-Process $powershell'));
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
    expect(off).toContain('Stop-Loops $running');
    expect(ps1.slice(ps1.indexOf('function Stop-Loops'), ps1.indexOf('function Invoke-Autostart'))).toContain('Stop-Process');
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

describe('hopper doctor (docs/deploy.md "Check it from Windows")', () => {
  const doctor = ps1.slice(ps1.indexOf('function Write-Check'), ps1.indexOf('# The container\'s name changes'));

  it('in hopper.cmd, runs hopper.ps1 from its own folder, and says how to get it when it is missing', () => {
    expect(cmd).toMatch(/if \/i "%~1"=="doctor" goto ps1/);
    expect(cmd).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0hopper.ps1" %*');
    expect(cmd).toContain('https://henningfutrell.github.io/hopper/hopper.ps1');
  });

  it('in hopper.ps1, runs before the container is looked up, so it works when the hopper does not run', () => {
    expect(ps1).toMatch(/\$args\[0\] -eq 'doctor'\) \{ Invoke-Doctor \}/);
    expect(ps1.indexOf("-eq 'doctor'")).toBeLessThan(ps1.indexOf("# The container's name changes"));
  });

  it('opens the address check (/job/address, no session) at localhost, then at 127.0.0.1, on the port HOPPER_PORT names, else 4790', () => {
    expect(doctor).toContain("if ($env:HOPPER_PORT) { $env:HOPPER_PORT } else { '4790' }");
    expect(doctor).not.toContain('/api/health');
    expect(doctor).toContain('Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://localhost:$port/job/address"');
    expect(doctor).toContain('Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$loopback/job/address"');
  });

  it('any HTTP answer is a working link; only 127.0.0.1 answering is a warning, not a FAIL, that says to open 127.0.0.1', () => {
    expect(doctor).toContain('$_.Exception.Response');
    expect(doctor).toContain("'warn'");
    expect(doctor).toContain('Windows tries ::1 first for localhost: open $loopback in place of localhost.');
  });

  it('reads the networking mode from wslinfo, and localhostForwarding and networkingMode from %UserProfile%\\.wslconfig', () => {
    expect(doctor).toContain("@('wslinfo', '--networking-mode')");
    expect(doctor).toContain("Join-Path $env:USERPROFILE '.wslconfig'");
    expect(doctor).toContain("'localhostforwarding'");
    expect(doctor).toContain("'networkingmode'");
  });

  it('for a broken link gives the same fix as the Machines banner, by networking mode', async () => {
    const model = '../../ui/src/model/windows-link.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
    const { windowsLinkFix } = (await import(model)) as { windowsLinkFix(l: { url: string; mode?: string; ok: boolean; at: string }): string[] };
    for (const mode of ['nat', 'mirrored', undefined]) {
      const fix = windowsLinkFix({ url: 'http://localhost:4790/job/address', mode, ok: false, at: '' });
      for (const line of fix) expect(doctor).toContain(line.replace('http://127.0.0.1:4790', '$loopback'));
    }
  });

  it('checks the keep-alive shortcut in this user\'s Startup folder', () => {
    expect(doctor).toContain("[Environment]::GetFolderPath('Startup')");
    expect(doctor).toContain("'hopper-wsl.lnk'");
    expect(doctor).not.toContain('keep-alive.lnk');
    expect(doctor).toContain('hopper autostart on');
    expect(doctor).toContain('install.html#windows-keep-running');
  });

  it('checks in the distro: systemd=true in /etc/wsl.conf, linger, and podman-restart.service, each with its fix', () => {
    expect(doctor).toContain("@('cat', '/etc/wsl.conf')");
    expect(doctor).toContain("printf '[boot]\\nsystemd=true\\n' | sudo tee -a /etc/wsl.conf");
    expect(doctor).toContain("'-p', 'Linger', '--value'");
    expect(doctor).toContain('sudo loginctl enable-linger');
    expect(doctor).toContain("@('systemctl', '--user', 'is-enabled', 'podman-restart.service')");
    expect(doctor).toContain('systemctl --user enable podman-restart.service');
  });

  it('prints ok or the fix for each check, and exits 1 when one fails', () => {
    expect(doctor).toContain("'ok  '");
    expect(doctor).toContain("'FAIL'");
    expect(doctor).toMatch(/if \(\$script:failed\) \{ exit 1 \}/);
  });

  it('only reads: it changes nothing, sends no token and starts nothing', () => {
    expect(doctor).not.toMatch(/TOKEN|Authorization|password/i);
    expect(doctor).not.toMatch(/Set-Content|New-Item|Remove-Item|Start-Process|Stop-Process|CreateShortcut|enable-linger \$|'--user', 'enable'/);
    expect(doctor).not.toMatch(/-Method (Post|Put|Delete)/i);
  });
});
