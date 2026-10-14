// scripts/hopper.ps1 and scripts/hopper.cmd (issue #712): the hopper CLI on Windows, for a hopper in WSL. Each runs
// `hopper` with the person's arguments in the hopper's container, through wsl.exe and podman exec, with the
// credentials the CLI already has there; Windows keeps none. They find the container by its compose labels, never by
// a fixed name, since the name changes with the compose project. Windows has no runner here, so these read the files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');
const ps1 = read('scripts', 'hopper.ps1');
const cmd = read('scripts', 'hopper.cmd');
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
    for (const call of code.match(/wsl\.exe [^\n]*/g) ?? []) expect(call).toMatch(/ -e podman /);
    expect(code.match(/wsl\.exe /g)?.length).toBe(2);
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
