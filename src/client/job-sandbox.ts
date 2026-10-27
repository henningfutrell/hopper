// The job's sandbox (issue #1295, design.md "Each job its own container runtime" → "The sandbox"): the guards of
// job-runtime.ts stop a mistake made by name, not a job that names the user's runtime dir again, opens its sockets by path
// or signals the hopper stack's processes. So Claude, and all it runs, runs in bubblewrap: mount, PID and IPC namespaces of
// its own, where the user's runtime dir (and `/run/user/<uid>`) is an empty tmpfs that holds only the job's own runtime dir,
// with the user's bus and systemd's private socket in it masked; the user's container storage, the host's container sockets
// and herdr's sockets are masked too. The job's podman socket keeps running outside, in the job's scope (rootless podman
// cannot start inside bubblewrap), so podman in the sandbox is a remote client of it (env.sh's CONTAINER_HOST). herdr starts
// `claude` from the pane's PATH, so the sandbox's `claude` comes first there and runs the real one in it. A machine with no
// bubblewrap, or no user namespaces for it, runs Claude as before. Beside job-runtime.ts, as a client target runs these
// scripts too. Imports nothing of hopper but that.
import { HOST_RUNTIME_SH, RUNTIME_PREFIX, RUNTIME_SUBDIR } from './job-runtime.ts';

/** Where the sandbox keeps its scripts in the job's scratch dir: `run` and `bin/claude`. */
export const SANDBOX_SUBDIR = 'sandbox';

/** The trial run: bubblewrap with the namespaces the sandbox uses. */
const PROBE = 'bwrap --dev-bind / / --proc /proc --unshare-pid --unshare-ipc --die-with-parent true';

// The runner, `<scratch>/sandbox/run <command> [args]`, one line after its `#!/bin/sh`: the job's runtime from env.sh, then
// the command in bubblewrap. Inside the sandbox already (HOPPER_SANDBOXED), the command as it is. The options are put after
// the command, then the command rotated behind them, as sh has no arrays. Later mounts go over earlier ones.
const RUN = [
  `s=\${0%/${SANDBOX_SUBDIR}/run}; e=$s/${RUNTIME_SUBDIR}/env.sh; [ -r "$e" ] && . "$e";`,
  'if [ -n "${HOPPER_SANDBOXED:-}" ]; then exec "$@"; fi;',
  '[ $# -gt 0 ] || { printf "hopper: %s\\n" "sandbox: no command" >&2; exit 125; };',
  'n=$#;',
  HOST_RUNTIME_SH,
  'u=/run/user/$(id -u);',
  'set -- "$@" --unshare-pid --unshare-ipc --die-with-parent --dev-bind / / --proc /proc;',
  '[ -d /dev/shm ] && set -- "$@" --tmpfs /dev/shm;',
  // The user's runtime dir: empty, but for the job's own runtime dir, whose bus and systemd's socket are masked.
  'for x in "$h" "$u"; do [ -d "$x" ] && set -- "$@" --tmpfs "$x"; done;',
  `j=\${XDG_RUNTIME_DIR:-}; case $j in "$h"/${RUNTIME_PREFIX}*) ;; *) j=;; esac;`,
  'if [ -n "$j" ] && [ -d "$j" ] && [ ! -L "$j" ]; then',
  '  set -- "$@" --bind "$j" "$j";',
  '  [ -e "$j/bus" ] && set -- "$@" --ro-bind /dev/null "$j/bus";',
  '  [ -d "$j/systemd" ] && set -- "$@" --tmpfs "$j/systemd";',
  '  set -- "$@" --setenv CONTAINER_HOST "unix://$j/podman/podman.sock";',
  'fi;',
  // The user's container storage, the host's container sockets, herdr's sockets.
  'p=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6);',
  'for x in "${XDG_DATA_HOME:-$HOME/.local/share}/containers" "$HOME/.local/share/containers" "${p:-/nonexistent}/.local/share/containers"; do [ -d "$x" ] && [ ! -L "$x" ] && set -- "$@" --tmpfs "$x"; done;',
  '[ -S /run/docker.sock ] && set -- "$@" --ro-bind /dev/null /run/docker.sock;',
  '[ -d /run/podman ] && set -- "$@" --tmpfs /run/podman;',
  'for x in "${XDG_CONFIG_HOME:-$HOME/.config}/herdr/sessions" "${HERDR_SOCKET_PATH:+${HERDR_SOCKET_PATH%/*}}"; do [ -n "$x" ] && [ -d "$x" ] && [ ! -L "$x" ] && set -- "$@" --tmpfs "$x"; done;',
  'set -- "$@" --setenv HOPPER_SANDBOXED 1 --unsetenv DBUS_SESSION_BUS_ADDRESS --;',
  'i=0; while [ "$i" -lt "$n" ]; do a=$1; shift; set -- "$@" "$a"; i=$((i+1)); done;',
  // The job's egress (issue #2849 part 2): when its user's setting routes jobs, bubblewrap runs behind `hopper-egress`.
  '[ -n "${HOPPER_EGRESS_ROUTE:-}" ] && [ -z "${HOPPER_EGRESS_PORT:-}" ] && [ -r "${HOPPER_EGRESS:-}" ] && exec sh "$HOPPER_EGRESS" -- bwrap "$@";',
  'exec bwrap "$@"',
].map((l) => l.trim()).join(' ');

// The sandbox's `claude`, one line after its `#!/bin/sh`: the real claude further on PATH, run by the runner beside it.
const CLAUDE = [
  'r=; o=$IFS; IFS=:; for p in $PATH; do [ -n "$p" ] && [ -x "$p/claude" ] && ! [ "$p/claude" -ef "$0" ] && { r=$p/claude; break; }; done; IFS=$o;',
  '[ -n "$r" ] || { printf "hopper: %s\\n" "claude: not found" >&2; exit 127; };',
  `exec "\${0%/bin/claude}/run" "$r" "$@"`,
].map((l) => l.trim()).join(' ');

// $1 the scratch dir, $2 the runner, $3 the sandbox's claude. Prints one word: on, none (no bubblewrap that runs here: the
// sandbox's scripts removed, so a run again does not find them) or failed.
const SETUP_SCRIPT = [
  `d=$1/${SANDBOX_SUBDIR};`,
  `if ! command -v bwrap >/dev/null 2>&1 || ! ${PROBE} >/dev/null 2>&1; then rm -rf "$d"; echo none; exit 0; fi;`,
  'mkdir -p "$d/bin" || { echo failed; exit 0; };',
  '{ printf "#!/bin/sh\\n%s\\n" "$2" > "$d/run" && chmod 755 "$d/run"; } || { echo failed; exit 0; };',
  '{ printf "#!/bin/sh\\n%s\\n" "$3" > "$d/bin/claude" && chmod 755 "$d/bin/claude"; } || { echo failed; exit 0; };',
  'echo on',
].map((l) => l.trim()).join(' ');

/** What the sandbox command prints, followed by its outcome. */
export const SANDBOX_MARK = 'hopper-sandbox-';
/** on: Claude runs in the sandbox; none: no bubblewrap that runs here, Claude runs as before; failed. */
export type SandboxOutcome = 'on' | 'none' | 'failed';
const OUTCOMES: readonly SandboxOutcome[] = ['on', 'none', 'failed'];

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The command that sets the job's sandbox up and, when it is on, puts its `claude` first on the shell's PATH, then prints
 * its outcome as two words, so the command's own echo never reads as it. Run after the job's runtime: the runner reads its
 * env.sh.
 */
export function sandboxCommand(scratch: string): string {
  const bin = shq(`${scratch}/${SANDBOX_SUBDIR}/bin`);
  return `o=$(sh -c ${shq(SETUP_SCRIPT)} hopper-sandbox ${shq(scratch)} ${shq(RUN)} ${shq(CLAUDE)}); `
    + `if [ "$o" = on ]; then case :$PATH: in *:${bin}:*) ;; *) PATH=${bin}:$PATH; export PATH;; esac; fi; `
    + `printf 'hopper-sandbox-%s\\n' "\${o:-failed}"`;
}

/** The argv that runs the setup script outside a shell's own environment, for a test. */
export const sandboxSetupArgv = (scratch: string): string[] => ['sh', '-c', SETUP_SCRIPT, 'hopper-sandbox', scratch, RUN, CLAUDE];

/** The last sandbox outcome on the screen, if any. */
export function sandboxOutcome(screen: string): SandboxOutcome | undefined {
  const last = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(SANDBOX_MARK)).at(-1)?.slice(SANDBOX_MARK.length);
  return (OUTCOMES as readonly string[]).includes(last ?? '') ? last as SandboxOutcome : undefined;
}
