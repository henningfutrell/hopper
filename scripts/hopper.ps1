# The hopper CLI on Windows, for a hopper that runs in WSL with Podman (issue #712, docs/deploy.md "The hopper CLI
# from Windows"). It runs `hopper` with your arguments in the hopper's container, through wsl.exe and podman exec.
# The CLI uses the credentials it already has in the container: Windows keeps none.
#
#   HOPPER_WSL_DISTRO       the WSL distro the hopper runs in (unset: WSL's default distro)
#   HOPPER_COMPOSE_PROJECT  the compose project of the hopper (unset: hopper, the name in compose.yaml)
#
# Put this file in a folder on PATH, then run, for example: hopper help
$ErrorActionPreference = 'Stop'
$project = if ($env:HOPPER_COMPOSE_PROJECT) { $env:HOPPER_COMPOSE_PROJECT } else { 'hopper' }
$wsl = @()
if ($env:HOPPER_WSL_DISTRO) { $wsl = @('-d', $env:HOPPER_WSL_DISTRO) }
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
