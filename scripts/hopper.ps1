# The hopper CLI on Windows, for a hopper that runs in WSL with Podman (issue #712, docs/deploy.md "The hopper CLI
# from Windows"). It runs `hopper` with your arguments in the hopper's container, through wsl.exe and podman exec.
# The CLI uses the credentials it already has in the container: Windows keeps none.
#
# hopper autostart on|off|status keeps the distro, and the hopper in it, running: after you sign in to Windows and
# after wsl --shutdown (docs/deploy.md "Keep it running on Windows"). It needs no admin rights and no secret.
# hopper doctor checks, from Windows, what a hopper in WSL needs, and gives the fix for each check that fails
# (docs/deploy.md "Check it from Windows"). It only reads: it changes nothing and sends no token.
#
#   HOPPER_WSL_DISTRO       the WSL distro the hopper runs in (unset: WSL's default distro)
#   HOPPER_COMPOSE_PROJECT  the compose project of the hopper (unset: hopper, the name in compose.yaml)
#
# Put this file in a folder on PATH, then run, for example: hopper help
$ErrorActionPreference = 'Stop'
$project = if ($env:HOPPER_COMPOSE_PROJECT) { $env:HOPPER_COMPOSE_PROJECT } else { 'hopper' }
$wsl = @()
if ($env:HOPPER_WSL_DISTRO) { $wsl = @('-d', $env:HOPPER_WSL_DISTRO) }

function Fail([string] $message) {
  [Console]::Error.WriteLine("hopper: $message")
  exit 1
}

# The output of a command in the distro, or '' when it fails.
function Read-Distro([string[]] $command) {
  $ErrorActionPreference = 'Continue'
  try { $out = & wsl.exe @wsl -e @command 2>$null } catch { return '' }
  if ($LASTEXITCODE -ne 0) { return '' }
  return (@($out) -join "`n").Trim()
}

function Invoke-Autostart([string] $action) {
  $dir = Join-Path $env:LOCALAPPDATA 'hopper'
  $loop = Join-Path $dir 'hopper-keepalive.ps1'
  $link = Join-Path ([Environment]::GetFolderPath('Startup')) 'hopper-wsl.lnk'
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $loopArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$loop`""
  # The keep-alive loops of this user: by the script they run, or the loop the install page's shortcut runs by hand.
  # The shortcut has the install page's name, so on replaces that one and off removes it.
  $running = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($loop) -or $_.CommandLine.Contains('-e sleep infinity; Start-Sleep')) })
  switch ($action) {
    'on' {
      if ((Read-Distro @('cat', '/proc/1/comm')) -ne 'systemd') {
        Fail "systemd does not run in the WSL distro. In it, run: printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf. Then run wsl --shutdown in PowerShell, and hopper autostart on again."
      }
      $user = Read-Distro @('id', '-un')
      if (-not $user) { Fail 'the WSL distro does not answer. Run wsl --list to see its name, and set HOPPER_WSL_DISTRO.' }
      if ((Read-Distro @('loginctl', 'show-user', $user, '-p', 'Linger', '--value')) -ne 'yes') {
        # sudo can ask for the distro user's password, once.
        & wsl.exe @wsl -e sudo loginctl enable-linger $user
        if ($LASTEXITCODE -ne 0) { Fail "loginctl enable-linger failed. In the WSL distro, run: sudo loginctl enable-linger $user" }
      }
      & wsl.exe @wsl -e systemctl --user enable podman-restart.service
      if ($LASTEXITCODE -ne 0) { Fail 'systemctl --user enable podman-restart.service failed. Run it in the WSL distro to see why.' }
      New-Item -ItemType Directory -Force $dir | Out-Null
      $distro = if ($env:HOPPER_WSL_DISTRO) { "@('-d', '$($env:HOPPER_WSL_DISTRO -replace "'", "''")')" } else { '@()' }
      Set-Content -Path $loop -Encoding UTF8 -Value @(
        '# Written by hopper autostart on. It keeps a process in the WSL distro, so WSL does not stop the distro,',
        '# and starts the distro again after wsl --shutdown. hopper autostart off removes it.',
        "`$wsl = $distro",
        'while ($true) {',
        '  & wsl.exe @wsl -e sleep infinity',
        '  Start-Sleep -Seconds 5',
        '}')
      $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
      $shortcut.TargetPath = $powershell
      $shortcut.Arguments = $loopArgs
      $shortcut.WindowStyle = 7
      $shortcut.Save()
      if ($running.Count -eq 0) { Start-Process $powershell -WindowStyle Hidden -ArgumentList $loopArgs }
      Write-Output 'hopper: autostart is on. The WSL distro, and the hopper in it, now start when you sign in to Windows and again after wsl --shutdown.'
    }
    'off' {
      foreach ($p in $running) {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($p.ProcessId)")
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        foreach ($c in $children) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }
      }
      Remove-Item -Force -ErrorAction SilentlyContinue $link, $loop
      Write-Output 'hopper: autostart is off. Linger and podman-restart.service stay on in the WSL distro. WSL stops the distro when it is idle.'
    }
    'status' {
      $user = Read-Distro @('id', '-un')
      $state = [ordered]@{
        'Startup shortcut' = Test-Path $link
        'keep-alive loop runs' = $running.Count -gt 0
        'linger is on' = [bool]$user -and (Read-Distro @('loginctl', 'show-user', $user, '-p', 'Linger', '--value')) -eq 'yes'
        'podman-restart.service is enabled' = (Read-Distro @('systemctl', '--user', 'is-enabled', 'podman-restart.service')) -eq 'enabled'
      }
      foreach ($k in $state.Keys) { Write-Output ('{0,-36} {1}' -f $k, $(if ($state[$k]) { 'yes' } else { 'no' })) }
      if ($state.Values -contains $false) {
        Write-Output 'hopper: autostart is not fully on. Run: hopper autostart on'
        exit 1
      }
    }
    default { Fail 'usage: hopper autostart on|off|status' }
  }
  exit 0
}

if ($args.Count -gt 0 -and $args[0] -eq 'autostart') { Invoke-Autostart $(if ($args.Count -gt 1) { $args[1] } else { '' }) }

# The keys of one [section] of an ini file (.wslconfig, /etc/wsl.conf): names and values in lower case.
function Read-Ini([string] $text, [string] $section) {
  $keys = @{}
  $in = $false
  foreach ($line in ($text -split "`r?`n")) {
    $l = $line.Trim()
    if ($l -match '^\[(.+)\]$') { $in = $Matches[1].Trim() -eq $section; continue }
    if ($in -and $l -match '^([^#;=]+)=(.*)$') { $keys[$Matches[1].Trim().ToLower()] = ($Matches[2] -replace '\s*[#;].*$', '').Trim().ToLower() }
  }
  return $keys
}

# One line of hopper doctor: ok, or FAIL and the fix, one step a line.
function Write-Check([string] $name, [bool] $ok, [string[]] $fix) {
  Write-Output ('{0}  {1}' -f $(if ($ok) { 'ok  ' } else { 'FAIL' }), $name)
  if ($ok) { return }
  $script:failed = $true
  foreach ($line in $fix) { Write-Output "      $line" }
}

function Invoke-Doctor {
  $script:failed = $false
  $port = if ($env:HOPPER_PORT) { $env:HOPPER_PORT } else { '4790' }
  $loopback = "http://127.0.0.1:$port"
  $mode = (Read-Distro @('wslinfo', '--networking-mode')).ToLower()
  $wslconfig = Join-Path $env:USERPROFILE '.wslconfig'
  $wsl2 = if (Test-Path $wslconfig) { Read-Ini (Get-Content -Raw $wslconfig) 'wsl2' } else { @{} }
  $shutdown = 'Then run wsl --shutdown in PowerShell, and start the hopper again.'
  # The fix the Machines banner gives for a broken Windows link (ui/src/model/windows-link.ts), by networking mode.
  $linkFix = if ($mode -eq 'nat') {
    @("In .wslconfig, in your Windows user folder (%UserProfile%), set localhostForwarding=true under [wsl2].",
      "If it is already set, in .wslconfig, in your Windows user folder (%UserProfile%), set networkingMode=mirrored under [wsl2] instead, or open $loopback in place of localhost.",
      $shutdown)
  } else {
    @("Open $loopback in place of localhost.",
      "Or: In .wslconfig, in your Windows user folder (%UserProfile%), set networkingMode=mirrored under [wsl2].",
      $shutdown)
  }

  $status = 0
  try { $status = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://localhost:$port/api/health").StatusCode } catch { $status = 0 }
  Write-Check "Windows opens http://localhost:$port/api/health" ($status -eq 200) (@('If the hopper does not run, run podman compose up -d in its folder in WSL.') + $linkFix)

  $forwarding = $wsl2['localhostforwarding']
  $configured = $wsl2['networkingmode']
  if ($mode -eq 'nat' -and $forwarding -eq 'false') {
    Write-Check "WSL networking mode: nat, with localhostForwarding=false in $wslconfig" $false $linkFix
  } elseif ($mode -and $configured -and $configured -ne $mode) {
    Write-Check "WSL networking mode: $mode, but $wslconfig sets networkingMode=$configured" $false @($shutdown)
  } else {
    Write-Check "WSL networking mode: $(if ($mode) { $mode } else { 'unknown (wslinfo did not answer)' })" $true @()
  }

  # hopper autostart on and the install page make the same shortcut, hopper-wsl.lnk.
  $link = Join-Path ([Environment]::GetFolderPath('Startup')) 'hopper-wsl.lnk'
  Write-Check 'keep-alive shortcut in the Startup folder' (Test-Path $link) @(
    'Run: hopper autostart on',
    'Or add the shortcut from the install page: https://henningfutrell.github.io/hopper/install.html#windows-keep-running')

  $user = Read-Distro @('id', '-un')
  if (-not $user) {
    Write-Check 'the WSL distro answers' $false @('Run wsl --list to see the names of the distros, and set HOPPER_WSL_DISTRO to the one the hopper runs in.')
  } else {
    $boot = Read-Ini (Read-Distro @('cat', '/etc/wsl.conf')) 'boot'
    Write-Check 'systemd=true in /etc/wsl.conf' ($boot['systemd'] -eq 'true') @(
      "In the WSL distro, run: printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf",
      'Then run wsl --shutdown in PowerShell, and open the distro again.')
    Write-Check "linger is on for $user" ((Read-Distro @('loginctl', 'show-user', $user, '-p', 'Linger', '--value')) -eq 'yes') @(
      'In the WSL distro, run: sudo loginctl enable-linger "$USER"')
    Write-Check 'podman-restart.service is enabled' ((Read-Distro @('systemctl', '--user', 'is-enabled', 'podman-restart.service')) -eq 'enabled') @(
      'In the WSL distro, run: systemctl --user enable podman-restart.service')
  }

  if ($script:failed) { exit 1 }
  Write-Output 'hopper: every check passed.'
  exit 0
}

if ($args.Count -gt 0 -and $args[0] -eq 'doctor') { Invoke-Doctor }

# The container's name changes with the compose project, so find it by its compose labels.
$container = & wsl.exe @wsl -e podman ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=hopper' |
  Select-Object -First 1
if ($LASTEXITCODE -ne 0 -or -not $container) {
  [Console]::Error.WriteLine("hopper: no hopper container of the compose project '$project' runs in WSL. In WSL, run podman compose up -d in the hopper's folder. Set HOPPER_WSL_DISTRO or HOPPER_COMPOSE_PROJECT if the hopper runs in another distro or project.")
  exit 1
}
$exec = @('exec', '-i')
if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) { $exec += '-t' }
& wsl.exe @wsl -e podman @exec $container.Trim() hopper @args
exit $LASTEXITCODE
