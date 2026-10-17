@echo off
rem The hopper CLI on Windows, for a hopper that runs in WSL with Podman (issue #712, docs/deploy.md "The hopper CLI
rem from Windows"). It runs `hopper` with your arguments in the hopper's container, through wsl.exe and podman exec.
rem The CLI uses the credentials it already has in the container: Windows keeps none.
rem
rem hopper autostart on|off|status and hopper doctor run hopper.ps1 from the same folder, which does the work
rem (docs/deploy.md "Keep it running on Windows", "Check it from Windows"). Put hopper.ps1 beside this file for them.
rem
rem   HOPPER_WSL_DISTRO       the WSL distro the hopper runs in (unset: WSL's default distro)
rem   HOPPER_COMPOSE_PROJECT  the compose project of the hopper (unset: hopper, the name in compose.yaml)
rem
rem Put this file in a folder on PATH, then run, for example: hopper help
setlocal
if /i "%~1"=="autostart" goto ps1
if /i "%~1"=="doctor" goto ps1
set "HOPPER_PROJECT=%HOPPER_COMPOSE_PROJECT%"
if not defined HOPPER_PROJECT set "HOPPER_PROJECT=hopper"
set "HOPPER_WSL="
if defined HOPPER_WSL_DISTRO set "HOPPER_WSL=-d %HOPPER_WSL_DISTRO%"
rem The container's name changes with the compose project, so find it by its compose labels. wsl.exe -e reads no shell
rem profile, so podman can get another runtime dir than in a WSL terminal and see no container run (issue #1512): try
rem podman as wsl.exe starts it, then with the runtime dir of the systemd user session, /run/user/<uid>.
set "HOPPER_CONTAINER="
set "HOPPER_RUNTIME="
call :find
if defined HOPPER_CONTAINER goto run
set "HOPPER_UID="
for /f "usebackq delims=" %%u in (`wsl.exe %HOPPER_WSL% -e id -u`) do if not defined HOPPER_UID set "HOPPER_UID=%%u"
if not defined HOPPER_UID goto none
set "HOPPER_RUNTIME=env XDG_RUNTIME_DIR=/run/user/%HOPPER_UID%"
call :find
if not defined HOPPER_CONTAINER goto none
:run
wsl.exe %HOPPER_WSL% -e %HOPPER_RUNTIME% podman exec -i %HOPPER_CONTAINER% hopper %*
exit /b %ERRORLEVEL%

:find
for /f "usebackq delims=" %%c in (`wsl.exe %HOPPER_WSL% -e %HOPPER_RUNTIME% podman ps -q --filter label^=com.docker.compose.project^=%HOPPER_PROJECT% --filter label^=com.docker.compose.service^=hopper 2^>nul`) do if not defined HOPPER_CONTAINER set "HOPPER_CONTAINER=%%c"
exit /b 0

:none
echo hopper: no hopper container of the compose project '%HOPPER_PROJECT%' runs in WSL. In WSL, run podman compose up -d in the hopper's folder. Set HOPPER_WSL_DISTRO or HOPPER_COMPOSE_PROJECT if the hopper runs in another distro or project. Run hopper doctor to check more. 1>&2
exit /b 1

:ps1
if not exist "%~dp0hopper.ps1" goto noscript
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0hopper.ps1" %*
exit /b %ERRORLEVEL%

:noscript
echo hopper: %~1 needs hopper.ps1 in the folder of hopper.cmd. Download https://henningfutrell.github.io/hopper/hopper.ps1 into %~dp0 1>&2
exit /b 1
