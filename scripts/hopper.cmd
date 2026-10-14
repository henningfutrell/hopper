@echo off
rem The hopper CLI on Windows, for a hopper that runs in WSL with Podman (issue #712, docs/deploy.md "The hopper CLI
rem from Windows"). It runs `hopper` with your arguments in the hopper's container, through wsl.exe and podman exec.
rem The CLI uses the credentials it already has in the container: Windows keeps none.
rem
rem hopper autostart on|off|status runs hopper.ps1 from the same folder, which does the work (docs/deploy.md "Keep it
rem running on Windows"). Put hopper.ps1 beside this file for it.
rem
rem   HOPPER_WSL_DISTRO       the WSL distro the hopper runs in (unset: WSL's default distro)
rem   HOPPER_COMPOSE_PROJECT  the compose project of the hopper (unset: hopper, the name in compose.yaml)
rem
rem Put this file in a folder on PATH, then run, for example: hopper help
setlocal
if /i "%~1"=="autostart" goto autostart
set "HOPPER_PROJECT=%HOPPER_COMPOSE_PROJECT%"
if not defined HOPPER_PROJECT set "HOPPER_PROJECT=hopper"
set "HOPPER_WSL="
if defined HOPPER_WSL_DISTRO set "HOPPER_WSL=-d %HOPPER_WSL_DISTRO%"
rem The container's name changes with the compose project, so find it by its compose labels.
set "HOPPER_CONTAINER="
for /f "usebackq delims=" %%c in (`wsl.exe %HOPPER_WSL% -e podman ps -q --filter label^=com.docker.compose.project^=%HOPPER_PROJECT% --filter label^=com.docker.compose.service^=hopper`) do if not defined HOPPER_CONTAINER set "HOPPER_CONTAINER=%%c"
if not defined HOPPER_CONTAINER goto none
wsl.exe %HOPPER_WSL% -e podman exec -i %HOPPER_CONTAINER% hopper %*
exit /b %ERRORLEVEL%

:none
echo hopper: no hopper container of the compose project '%HOPPER_PROJECT%' runs in WSL. In WSL, run podman compose up -d in the hopper's folder. Set HOPPER_WSL_DISTRO or HOPPER_COMPOSE_PROJECT if the hopper runs in another distro or project. 1>&2
exit /b 1

:autostart
if not exist "%~dp0hopper.ps1" goto noscript
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0hopper.ps1" %*
exit /b %ERRORLEVEL%

:noscript
echo hopper: autostart needs hopper.ps1 in the folder of hopper.cmd. Download https://henningfutrell.github.io/hopper/hopper.ps1 into %~dp0 1>&2
exit /b 1
