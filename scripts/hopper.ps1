# The hopper CLI on Windows, for a hopper that runs in WSL with Podman (issue #712, docs/deploy.md "The hopper CLI
# from Windows"). It runs `hopper` with your arguments in the hopper's container, through wsl.exe and podman exec.
# The CLI uses the credentials it already has in the container: Windows keeps none.
#
# hopper autostart on|off|status keeps the distro, and the hopper in it, running: after you sign in to Windows and
# after wsl --shutdown (docs/deploy.md "Keep it running on Windows"). It needs no admin rights and no secret. Its loop
# also tells the hopper, at most every 5 minutes, whether Windows opens it at localhost (hopper windows-link report).
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

# The hopper's container, found by its compose labels, since its name changes with the compose project. Returns the
# podman command that sees it (podman, or env with a runtime dir, then podman) and its id; else the podman command
# that was tried last, no id, and what podman said.
# wsl.exe -e runs no shell, so it reads no shell profile. In a WSL terminal a profile can set XDG_RUNTIME_DIR to the
# runtime dir of the systemd user session, /run/user/<uid>, which podman-restart.service uses too, while wsl.exe -e
# gives podman another one (WSLg sets /mnt/wslg/runtime-dir). There podman sees no container run (issue #1512). So it
# tries podman as wsl.exe starts it first, then with the runtime dir of the systemd user session.
function Find-Hopper {
  $ErrorActionPreference = 'Continue'
  $uid = Read-Distro @('id', '-u')
  $runtimes = @('')
  if ($uid -match '^\d+$' -and (Read-Distro @('printenv', 'XDG_RUNTIME_DIR')) -ne "/run/user/$uid") { $runtimes += "/run/user/$uid" }
  $found = @{ podman = @('podman'); container = ''; said = '' }
  foreach ($runtime in $runtimes) {
    $podman = if ($runtime) { @('env', "XDG_RUNTIME_DIR=$runtime", 'podman') } else { @('podman') }
    try { $out = @(& wsl.exe @wsl -e @podman ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=hopper' 2>&1) } catch { $out = @($_) }
    $container = @($out | Where-Object { $_ -is [string] -and $_.Trim() -match '^[0-9a-f]{12,64}$' }) | Select-Object -First 1
    $found = @{ podman = $podman; container = $(if ($container) { $container.Trim() } else { '' }) }
    $found.said = (@($out | Where-Object { $_ -isnot [string] } | ForEach-Object { "$_".Trim() }) -join ' ').Trim()
    if ($found.container) { return $found }
  }
  return $found
}

# Stop keep-alive loops, and the processes each started.
function Stop-Loops($loops) {
  foreach ($p in $loops) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($p.ProcessId)")
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    foreach ($c in $children) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }
  }
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
      $port = if ($env:HOPPER_PORT) { $env:HOPPER_PORT } else { '4790' }
      # The loop. It reports the Windows link with the hopper CLI in the container, which keeps the credentials: the
      # loop keeps none, and the report carries no secret (docs/deploy.md "Keep it running on Windows").
      $body = @'
# Written by hopper autostart on. It keeps a process in the WSL distro, so WSL does not stop the distro,
# and starts the distro again 5 s after wsl --shutdown. At most every 5 minutes, while the hopper runs, it
# tests whether Windows opens the hopper at localhost, else at 127.0.0.1, and tells the hopper the result, which the hopper
# shows with the fix when the link is broken. hopper autostart off removes it.
$wsl = __WSL__
$project = '__PROJECT__'
# The address check answers 204 to anyone the hopper's Host guard lets in, with no session. Windows tries ::1 first for
# localhost, so 127.0.0.1 next.
$urls = @('http://localhost:__PORT__/job/address', 'http://127.0.0.1:__PORT__/job/address')
$ProgressPreference = 'SilentlyContinue'
function Send-WindowsLink {
  # As hopper does (Find-Hopper in hopper.ps1): podman as wsl.exe starts it, then with the systemd user session's runtime dir.
  $uid = (@(& wsl.exe @wsl -e id -u 2>$null) -join '').Trim()
  $container = $null
  $runtimes = @('')
  if ($uid -match '^\d+$') { $runtimes += "/run/user/$uid" }
  foreach ($runtime in $runtimes) {
    $podman = if ($runtime) { @('env', "XDG_RUNTIME_DIR=$runtime", 'podman') } else { @('podman') }
    $container = @(& wsl.exe @wsl -e @podman ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=hopper' 2>$null) | Select-Object -First 1
    if ($container) { break }
  }
  if (-not $container) { return }
  # Any HTTP answer, an error status too, means the hopper answered. The link is the URL that answered, else localhost.
  $url = $urls[0]
  $result = $null
  $firstError = $null
  foreach ($u in $urls) {
    try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri $u; $result = @('--status', [string][int]$r.StatusCode) }
    catch {
      if ($_.Exception.Response) { $result = @('--status', [string][int]$_.Exception.Response.StatusCode) }
      elseif (-not $firstError) { $firstError = @('--error', ($_.Exception.Message -replace '[\s"]+', ' ').Trim()) }
    }
    if ($result) { $url = $u; break }
  }
  if (-not $result) { $result = $firstError }
  $mode = (@(& wsl.exe @wsl -e wslinfo --networking-mode 2>$null) -join '').Trim().ToLower()
  if ($mode -match '^[a-z]{1,20}$') { $result += @('--mode', $mode) }
  & wsl.exe @wsl -e @podman exec $container.Trim() hopper windows-link report --link $url @result *> $null
}
$keep = $null
$next = Get-Date
while ($true) {
  if (-not $keep -or $keep.HasExited) { $keep = Start-Process wsl.exe -ArgumentList (@($wsl) + @('-e', 'sleep', 'infinity')) -WindowStyle Hidden -PassThru }
  if ((Get-Date) -ge $next) {
    $next = (Get-Date).AddMinutes(5)
    try { Send-WindowsLink } catch { }
  }
  Start-Sleep -Seconds 5
}
'@
      Set-Content -Path $loop -Encoding UTF8 -Value $body.Replace('__WSL__', $distro).Replace('__PROJECT__', ($project -replace "'", "''")).Replace('__PORT__', $port)
      $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
      $shortcut.TargetPath = $powershell
      $shortcut.Arguments = $loopArgs
      $shortcut.WindowStyle = 7
      $shortcut.Save()
      # A loop that runs now runs the loop of before: start the new one in its place.
      Stop-Loops $running
      Start-Process $powershell -WindowStyle Hidden -ArgumentList $loopArgs
      Write-Output 'hopper: autostart is on. The WSL distro, and the hopper in it, now start when you sign in to Windows and again after wsl --shutdown.'
    }
    'off' {
      Stop-Loops $running
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

# A warning line of hopper doctor: the check works, but not as it should; the hint, one step a line. Not a failure.
function Write-Warn([string] $name, [string[]] $hint) {
  Write-Output ('{0}  {1}' -f 'warn', $name)
  foreach ($line in $hint) { Write-Output "      $line" }
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
  } elseif ($mode -eq 'mirrored') {
    @("Open $loopback in place of localhost.",
      'If it does not open either, run wsl --shutdown in PowerShell, and start the hopper again.')
  } else {
    @("Open $loopback in place of localhost.",
      "Or, in NAT mode: in .wslconfig, in your Windows user folder (%UserProfile%), set localhostForwarding=true under [wsl2].",
      "Or: in .wslconfig, in your Windows user folder (%UserProfile%), set networkingMode=mirrored under [wsl2].",
      $shutdown)
  }

  # The address check (/job/address) answers 204 to anyone the Host guard lets in, with no session. Any HTTP answer, an
  # error status too, means the hopper answered. localhost first; Windows tries ::1 first for it, so 127.0.0.1 next.
  $atLocalhost = $false
  try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://localhost:$port/job/address"; $atLocalhost = $true } catch { $atLocalhost = [bool] $_.Exception.Response }
  $atLoopback = $false
  if (-not $atLocalhost) {
    try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$loopback/job/address"; $atLoopback = $true } catch { $atLoopback = [bool] $_.Exception.Response }
  }
  if ($atLoopback) {
    Write-Warn "Windows opens $loopback/job/address, but not http://localhost:$port/job/address" @(
      "Windows tries ::1 first for localhost: open $loopback in place of localhost.",
      'Or publish the hopper on ::1 too: https://github.com/henningfutrell/hopper/blob/stable/docs/deploy.md#open-it-at-localhost-from-windows')
  } else {
    Write-Check "Windows opens http://localhost:$port/job/address" $atLocalhost (@('If the hopper does not run, run podman compose up -d in its folder in WSL.') + $linkFix)
  }

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
    # hopper <command> runs the CLI in this container (Find-Hopper): podman ps only reads.
    $hopper = Find-Hopper
    $said = if ($hopper.said) { @("Podman said: $($hopper.said)") } else { @() }
    Write-Check "a hopper container of the compose project '$project' runs (podman ps, as hopper <command> runs it)" ([bool] $hopper.container) ($said + @(
      "In WSL, run podman compose up -d in the hopper's folder, as the distro user $user.",
      'If the hopper runs in another distro or compose project, set HOPPER_WSL_DISTRO or HOPPER_COMPOSE_PROJECT.'))
  }

  if ($script:failed) { exit 1 }
  Write-Output 'hopper: every check passed.'
  exit 0
}

if ($args.Count -gt 0 -and $args[0] -eq 'doctor') { Invoke-Doctor }

# The container's name changes with the compose project, so find it by its compose labels (Find-Hopper).
$hopper = Find-Hopper
if (-not $hopper.container) {
  $said = if ($hopper.said) { " Podman said: $($hopper.said)" } else { '' }
  [Console]::Error.WriteLine("hopper: no hopper container of the compose project '$project' runs in WSL.$said In WSL, run podman compose up -d in the hopper's folder. Set HOPPER_WSL_DISTRO or HOPPER_COMPOSE_PROJECT if the hopper runs in another distro or project. Run hopper doctor to check more.")
  exit 1
}
$podman = $hopper.podman
$exec = @('exec', '-i')
if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) { $exec += '-t' }
& wsl.exe @wsl -e @podman @exec $hopper.container hopper @args
exit $LASTEXITCODE
