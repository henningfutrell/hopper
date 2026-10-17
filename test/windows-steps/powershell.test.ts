// Issue #731: what the hopper runs on a Windows host. Every remote command is an encoded PowerShell script, so the
// host's default shell cannot change it; paths and outputs go only into single-quoted strings.
import { describe, expect, it } from 'vitest';
import { cleanupScript, encodedCommand, prepareScript, psQuote, runScript, scpScratch, secretsInput, stepFile } from '../../src/windows-steps/powershell.ts';

const decode = (command: string): string => Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le');

describe('the PowerShell a step runs', () => {
  it('travels as -EncodedCommand: UTF-16LE in base64, whatever it holds', () => {
    const script = "Write-Output 'a \"b\" & c | d; $e'";
    const command = encodedCommand(script);
    expect(command).toMatch(/^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(decode(command)).toBe(script);
  });

  it('quotes for PowerShell by doubling a single quote', () => {
    expect(psQuote("it's")).toBe("'it''s'");
  });

  it('prepares an empty scratch directory in the working directory, and fails when the working directory is not there', () => {
    const s = prepareScript('C:\\work\\app');
    expect(s).toContain("Test-Path -LiteralPath 'C:\\work\\app' -PathType Container");
    expect(s).toContain("Remove-Item -LiteralPath 'C:\\work\\app\\.hopper-step' -Recurse -Force");
    expect(s).toContain("New-Item -ItemType Directory -Path 'C:\\work\\app\\.hopper-step'");
    expect(cleanupScript('C:\\work\\app\\')).toContain("'C:\\work\\app\\.hopper-step'");
  });

  it('extracts the inputs, runs the step in its own PowerShell, packs the outputs that are there and exits with its code', () => {
    const s = runScript({ workDir: 'C:\\work\\app', inputs: true, outputs: ['bin\\Release', 'build log.txt'] });
    expect(s).toContain("Set-Location -LiteralPath 'C:\\work\\app'");
    expect(s).toContain("tar -xf 'C:\\work\\app\\.hopper-step\\inputs.tar'");
    expect(s).toContain("-File 'C:\\work\\app\\.hopper-step\\step.ps1'");
    expect(s).toContain("$outputs = @('bin\\Release', 'build log.txt')");
    expect(s).toContain("tar -cf 'C:\\work\\app\\.hopper-step\\outputs.tar' -- @present");
    expect(s.trim().split('\n').at(-1)).toBe('exit $code');
    // Issue #1255: a tar that fails leaves no archive behind, and one that packs says how large the archive is.
    expect(s).toContain("if ($LASTEXITCODE) { [Console]::Error.WriteLine('hopper-step: the outputs could not be packed on the host: tar exited ' + $LASTEXITCODE)");
    expect(s).toContain("Remove-Item -LiteralPath 'C:\\work\\app\\.hopper-step\\outputs.tar' -Force -ErrorAction SilentlyContinue");
    expect(s).toContain("[Console]::Error.WriteLine('hopper-step: outputs packed, ' + (Get-Item -LiteralPath 'C:\\work\\app\\.hopper-step\\outputs.tar').Length + ' bytes')");
    const bare = runScript({ workDir: 'C:\\w', inputs: false, outputs: [] });
    expect(bare).not.toContain('tar ');
    expect(bare).not.toContain('[Console]::In');
  });

  it('reads the step\'s secrets from stdin into its environment, before the step runs, and keeps none on disk', () => {
    const s = runScript({ workDir: 'C:\\w', inputs: false, outputs: [], secrets: true });
    const read = s.indexOf('[Console]::In.ReadToEnd()');
    expect(read).toBeGreaterThan(-1);
    expect(s).toContain("[Environment]::SetEnvironmentVariable($hopperName, [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($hopperValue)), 'Process')");
    expect(read).toBeLessThan(s.indexOf('-File'));
    expect(s).not.toMatch(/Set-Content|Out-File/);
  });

  it('sends each secret on a line of its own: its name, then its value as base64 of UTF-8', () => {
    expect(secretsInput({ NUGET_TOKEN: 'tok=en\nline', PASS: 'pässwort' }))
      .toBe(`NUGET_TOKEN=${Buffer.from('tok=en\nline').toString('base64')}\nPASS=${Buffer.from('pässwort').toString('base64')}\n`);
  });

  it("wraps the job's command so its exit code is the last native command's, or 1 when it failed", () => {
    const f = stepFile('msbuild App.sln');
    expect(f.split('\r\n')).toEqual(['$global:LASTEXITCODE = 0', 'msbuild App.sln', '$hopperOk = $?', 'if ($LASTEXITCODE) { exit $LASTEXITCODE }', 'if (-not $hopperOk) { exit 1 }', 'exit 0', '']);
  });

  it('names the scratch directory for scp with forward slashes', () => {
    expect(scpScratch('C:\\work\\app\\')).toBe('C:/work/app/.hopper-step');
  });
});
