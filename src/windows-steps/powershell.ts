// What the hopper runs on a Windows host for one step (issue #731, design.md "Windows sandbox steps"), pure. Every
// remote command is `powershell -EncodedCommand`: the script travels as base64 of UTF-16LE, so no quoting rule of the
// host's default shell (PowerShell or cmd) can change it. The host's working directory and the outputs are checked by
// src/domain/windows-steps.ts before they get here; they go into single-quoted strings only.

/** The scratch directory a step keeps in the host's working directory while it runs, removed after: the inputs tar, the step's script, the outputs tar. */
export const STEP_SCRATCH = '.hopper-step';

/** A PowerShell single-quoted string. */
export const psQuote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** The remote command that runs `script` in Windows PowerShell, whatever the host's default shell is. */
export function encodedCommand(script: string): string {
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

/** `C:\work\app` as scp names it on the host: `C:/work/app`. */
export const scpPath = (windowsPath: string): string => windowsPath.replaceAll('\\', '/').replace(/\/+$/, '');

const scratchOf = (workDir: string): string => `${workDir.replace(/[\\/]+$/, '')}\\${STEP_SCRATCH}`;

/** Before the copy: the working directory exists, and the step's scratch directory is there and empty. */
export function prepareScript(workDir: string): string {
  const scratch = psQuote(scratchOf(workDir));
  return [
    "$ErrorActionPreference = 'Stop'",
    `if (-not (Test-Path -LiteralPath ${psQuote(workDir)} -PathType Container)) { [Console]::Error.WriteLine('hopper-step: the working directory ' + ${psQuote(workDir)} + ' is not there'); exit 2 }`,
    `if (Test-Path -LiteralPath ${scratch}) { Remove-Item -LiteralPath ${scratch} -Recurse -Force }`,
    `New-Item -ItemType Directory -Path ${scratch} | Out-Null`,
  ].join('\n');
}

/**
 * The step: the inputs extracted in the working directory (Windows' own tar, which refuses absolute paths and `..`),
 * the job's command run there in a PowerShell of its own, its output as it comes, then the outputs packed. Exits with
 * the command's exit code.
 */
export function runScript(o: { workDir: string; inputs: boolean; outputs: string[] }): string {
  const scratch = scratchOf(o.workDir);
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `Set-Location -LiteralPath ${psQuote(o.workDir)}`,
    ...(o.inputs ? [
      `tar -xf ${psQuote(`${scratch}\\inputs.tar`)}`,
      "if ($LASTEXITCODE) { [Console]::Error.WriteLine('hopper-step: the inputs did not extract'); exit 2 }",
    ] : []),
    `& powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${psQuote(`${scratch}\\step.ps1`)}`,
    '$code = $LASTEXITCODE',
    ...(o.outputs.length > 0 ? [
      `$outputs = @(${o.outputs.map(psQuote).join(', ')})`,
      "$missing = @($outputs | Where-Object { -not (Test-Path -LiteralPath $_) })",
      "foreach ($m in $missing) { [Console]::Error.WriteLine('hopper-step: output ' + $m + ' is not there') }",
      "$present = @($outputs | Where-Object { Test-Path -LiteralPath $_ })",
      `if ($present.Count -gt 0) { tar -cf ${psQuote(`${scratch}\\outputs.tar`)} -- @present }`,
    ] : []),
    'exit $code',
  ].join('\n');
}

/** The job's command as the step's own script: its exit code is the last native command's, or 1 when the last statement failed. */
export function stepFile(command: string): string {
  return [
    '$global:LASTEXITCODE = 0',
    command,
    '$hopperOk = $?',
    'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
    'if (-not $hopperOk) { exit 1 }',
    'exit 0',
    '',
  ].join('\r\n');
}

/** After: the scratch directory removed, whatever came before. */
export function cleanupScript(workDir: string): string {
  const scratch = psQuote(scratchOf(workDir));
  return `if (Test-Path -LiteralPath ${scratch}) { Remove-Item -LiteralPath ${scratch} -Recurse -Force -ErrorAction SilentlyContinue }`;
}

/** The scratch directory as scp names it. */
export const scpScratch = (workDir: string): string => `${scpPath(workDir)}/${STEP_SCRATCH}`;
