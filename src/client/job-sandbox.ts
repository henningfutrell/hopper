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
/** The trial run of a network namespace, for a job its user's setting confines (issue #2849 part 4). */
const NET_PROBE = 'bwrap --dev-bind / / --unshare-net --die-with-parent true';
/** The file in the sandbox's dir that holds the job's egress as the setup found it: routed or confined. */
const EGRESS_FILE = 'egress';

/** The job's environment scope (issue #2849 part 5), in the job's credentials dir: src/sandbox/env-scope.ts `ENV_SCOPE_FILE`. */
const ENV_SCOPE = 'credentials/hopper/env-scope';

// The runner, `<scratch>/sandbox/run <command> [args]`, one line after its `#!/bin/sh`: the job's environment scope first
// (issue #2849 part 5: with it on, the file runs the runner again with only the variables kept), the job's runtime from
// env.sh, then the command in bubblewrap. Inside the sandbox already (HOPPER_SANDBOXED), the command as it is. The options
// are put after the command, then the command rotated behind them, as sh has no arrays. Later mounts go over earlier ones.
const RUN = [
  `s=\${0%/${SANDBOX_SUBDIR}/run}; e=$s/${ENV_SCOPE}; [ -z "\${HOPPER_ENV_SCOPED:-}" ] && [ -r "$e" ] && . "$e";`,
  `e=$s/${RUNTIME_SUBDIR}/env.sh; [ -r "$e" ] && . "$e";`,
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
  'set -- "$@" --setenv HOPPER_SANDBOXED 1 --unsetenv DBUS_SESSION_BUS_ADDRESS;',
  // The job's egress (issue #2849), as the setup found it: routed, bubblewrap runs behind `hopper-egress` (part 2);
  // confined (part 4), also with a network namespace of its own, whose one way out is the proxy's Unix socket, joined to a
  // port in it by `hopper-egress --from`, which then runs the command.
  `e=; [ -z "\${HOPPER_EGRESS_PORT:-}" ] && [ -r "$s/${SANDBOX_SUBDIR}/${EGRESS_FILE}" ] && read -r e < "$s/${SANDBOX_SUBDIR}/${EGRESS_FILE}";`,
  'case $e in confined) k=${TMPDIR:-/tmp}/hopper-egress-$$.sock; set -- "$@" --unshare-net -- sh "$HOPPER_EGRESS" --from "$k" --;; *) set -- "$@" --;; esac;',
  'i=0; while [ "$i" -lt "$n" ]; do a=$1; shift; set -- "$@" "$a"; i=$((i+1)); done;',
  'case $e in confined) exec sh "$HOPPER_EGRESS" --socket "$k" -- bwrap "$@";; routed) exec sh "$HOPPER_EGRESS" -- bwrap "$@";; esac;',
  'exec bwrap "$@"',
].map((l) => l.trim()).join(' ');

// The sandbox's `claude`, one line after its `#!/bin/sh`: the real claude further on PATH, run by the runner beside it.
const CLAUDE = [
  'r=; o=$IFS; IFS=:; for p in $PATH; do [ -n "$p" ] && [ -x "$p/claude" ] && ! [ "$p/claude" -ef "$0" ] && { r=$p/claude; break; }; done; IFS=$o;',
  '[ -n "$r" ] || { printf "hopper: %s\\n" "claude: not found" >&2; exit 127; };',
  `exec "\${0%/bin/claude}/run" "$r" "$@"`,
].map((l) => l.trim()).join(' ');

// $1 the scratch dir, $2 the runner, $3 the sandbox's claude. Prints one word: on, none (no bubblewrap that runs here: the
// sandbox's scripts removed, so a run again does not find them) or failed; when the job's setting routes it (issue #2849),
// on and none are followed by its egress outcome.
const SETUP_SCRIPT = [
  `d=$1/${SANDBOX_SUBDIR};`,
  `if ! command -v bwrap >/dev/null 2>&1 || ! ${PROBE} >/dev/null 2>&1; then rm -rf "$d"; echo none \${HOPPER_EGRESS_ROUTE:+unrouted}; exit 0; fi;`,
  'mkdir -p "$d/bin" || { echo failed; exit 0; };',
  '{ printf "#!/bin/sh\\n%s\\n" "$2" > "$d/run" && chmod 755 "$d/run"; } || { echo failed; exit 0; };',
  '{ printf "#!/bin/sh\\n%s\\n" "$3" > "$d/bin/claude" && chmod 755 "$d/bin/claude"; } || { echo failed; exit 0; };',
  // The job's egress (issue #2849), when its user's setting routes it: unrouted with no hopper-egress or no node to run it;
  // confined when the setting asks it and a network namespace holds here (part 4); else routed.
  `rm -f "$d/${EGRESS_FILE}"; e=; if [ -n "\${HOPPER_EGRESS_ROUTE:-}" ]; then e=unrouted; if [ -r "\${HOPPER_EGRESS:-}" ] && command -v node >/dev/null 2>&1; then`,
  `e=routed; [ -n "\${HOPPER_EGRESS_CONFINE:-}" ] && ${NET_PROBE} >/dev/null 2>&1 && e=confined; echo $e > "$d/${EGRESS_FILE}"; fi; fi;`,
  'echo on $e',
].map((l) => l.trim()).join(' ');

// The bare runner (issue #2849 part 6): a machine where bubblewrap cannot run — a lane pod, a box in a container, macOS —
// has no sandbox runner, so the job's egress route and environment scope held nowhere there. When the job's setting routes
// or scopes it, a second step, after the sandbox's, writes a runner with no sandbox in the same place: the job's environment
// scope first, the job's runtime from env.sh, then the command behind `hopper-egress` when the setup found it routed, or
// contained (the machine's own network reaches only the hopper: HOPPER_EGRESS_CONTAINED, set by whoever runs the machine,
// for example the chart's lane pods with lanes.egress.confine). One line after its `#!/bin/sh`, as the sandbox's.
const BARE_RUN = [
  `s=\${0%/${SANDBOX_SUBDIR}/run}; e=$s/${ENV_SCOPE}; [ -z "\${HOPPER_ENV_SCOPED:-}" ] && [ -r "$e" ] && . "$e";`,
  `e=$s/${RUNTIME_SUBDIR}/env.sh; [ -r "$e" ] && . "$e";`,
  '[ $# -gt 0 ] || { printf "hopper: %s\\n" "runner: no command" >&2; exit 125; };',
  `e=; [ -z "\${HOPPER_EGRESS_PORT:-}" ] && [ -r "$s/${SANDBOX_SUBDIR}/${EGRESS_FILE}" ] && read -r e < "$s/${SANDBOX_SUBDIR}/${EGRESS_FILE}";`,
  'case $e in routed|contained) exec sh "$HOPPER_EGRESS" -- "$@";; esac;',
  'exec "$@"',
].join(' ');

// $1 the scratch dir, $2 the bare runner, $3 the sandbox's claude. Prints one word: on, none (the job's setting neither
// routes nor scopes it, or Git for Windows, where herdr does not start a sh script as claude) or failed; when the setting
// routes it, on is followed by its egress outcome: unrouted with no hopper-egress or no node, contained, else routed.
const BARE_SETUP = [
  `d=$1/${SANDBOX_SUBDIR};`,
  'case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) echo none; exit 0;; esac;',
  '[ -n "${HOPPER_EGRESS_ROUTE:-}${HOPPER_ENV_SCOPE:-}" ] || { echo none; exit 0; };',
  'mkdir -p "$d/bin" || { echo failed; exit 0; };',
  '{ printf "#!/bin/sh\\n%s\\n" "$2" > "$d/run" && chmod 755 "$d/run"; } || { echo failed; exit 0; };',
  '{ printf "#!/bin/sh\\n%s\\n" "$3" > "$d/bin/claude" && chmod 755 "$d/bin/claude"; } || { echo failed; exit 0; };',
  `rm -f "$d/${EGRESS_FILE}"; e=; if [ -n "\${HOPPER_EGRESS_ROUTE:-}" ]; then e=unrouted; if [ -r "\${HOPPER_EGRESS:-}" ] && command -v node >/dev/null 2>&1; then`,
  `e=routed; [ -n "\${HOPPER_EGRESS_CONTAINED:-}" ] && e=contained; echo $e > "$d/${EGRESS_FILE}"; fi; fi;`,
  'echo on $e',
].join(' ');

/** What the sandbox command prints, followed by its outcome. */
export const SANDBOX_MARK = 'hopper-sandbox-';
/** on: Claude runs in the sandbox; none: no bubblewrap that runs here, Claude runs as before; failed. */
export type SandboxOutcome = 'on' | 'none' | 'failed';
const OUTCOMES: readonly SandboxOutcome[] = ['on', 'none', 'failed'];

/** What the sandbox command prints before its outcome when the job's setting routes it (issue #2849), then the egress's. */
export const EGRESS_MARK = 'hopper-egress-';
/**
 * confined: its sandbox has a network namespace of its own, whose one way out is `hopper-egress` (part 4); contained: its
 * bare runner runs it behind `hopper-egress` on a machine whose own network reaches only the hopper (part 6); routed:
 * behind `hopper-egress`, but a tool that ignores HTTPS_PROXY still goes out directly; unrouted: no runner or no node here,
 * so not even routed.
 */
export type EgressOutcome = 'confined' | 'contained' | 'routed' | 'unrouted';
const EGRESS_OUTCOMES: readonly EgressOutcome[] = ['confined', 'contained', 'routed', 'unrouted'];

/** What the bare runner's command prints, followed by its outcome (issue #2849 part 6). */
export const BARE_MARK = 'hopper-bare-';
/** on: the agent runs through the bare runner; none: the job needs none, or Git for Windows; failed. */
export type BareOutcome = 'on' | 'none' | 'failed';

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The command that sets the job's sandbox up and, when it is on, puts its `claude` first on the shell's PATH, then prints
 * its egress outcome (only when the job's setting routes it, issue #2849) and its outcome, each as two words, so the
 * command's own echo never reads as them. Run after the job's runtime: the runner reads its
 * env.sh.
 */
export function sandboxCommand(scratch: string): string {
  const bin = shq(`${scratch}/${SANDBOX_SUBDIR}/bin`);
  return `o=$(sh -c ${shq(SETUP_SCRIPT)} hopper-sandbox ${shq(scratch)} ${shq(RUN)} ${shq(CLAUDE)}); e=\${o#* }; o=\${o%% *}; `
    + `if [ "$o" = on ]; then case :$PATH: in *:${bin}:*) ;; *) PATH=${bin}:$PATH; export PATH;; esac; fi; `
    + `{ [ "$e" = "$o" ] || printf 'hopper-egress-%s\\n' "$e"; printf 'hopper-sandbox-%s\\n' "\${o:-failed}"; }`;
}

/**
 * The command that writes the job's bare runner (issue #2849 part 6), run after the sandbox's when that found no
 * bubblewrap: when it is on, the runner's `claude` first on the shell's PATH; then its egress outcome (only when the job's
 * setting routes it) and its outcome, as `sandboxCommand` prints them. Its own line, as the sandbox's is near the limit.
 */
export function bareCommand(scratch: string): string {
  const bin = shq(`${scratch}/${SANDBOX_SUBDIR}/bin`);
  return `o=$(sh -c ${shq(BARE_SETUP)} hopper-bare ${shq(scratch)} ${shq(BARE_RUN)} ${shq(CLAUDE)}); e=\${o#* }; o=\${o%% *}; `
    + `if [ "$o" = on ]; then case :$PATH: in *:${bin}:*) ;; *) PATH=${bin}:$PATH; export PATH;; esac; fi; `
    + `{ [ "$e" = "$o" ] || printf 'hopper-egress-%s\\n' "$e"; printf 'hopper-bare-%s\\n' "\${o:-failed}"; }`;
}

/** The last bare runner outcome on the screen, if any. */
export function bareOutcome(screen: string): BareOutcome | undefined {
  const last = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(BARE_MARK)).at(-1)?.slice(BARE_MARK.length);
  return (['on', 'none', 'failed'] as readonly string[]).includes(last ?? '') ? last as BareOutcome : undefined;
}

/** The argv that runs the setup script outside a shell's own environment, for a test. */
export const sandboxSetupArgv = (scratch: string): string[] => ['sh', '-c', SETUP_SCRIPT, 'hopper-sandbox', scratch, RUN, CLAUDE];

/** The last egress outcome on the screen, if any: none when the job's setting does not route it. */
export function egressOutcome(screen: string): EgressOutcome | undefined {
  const last = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(EGRESS_MARK)).at(-1)?.slice(EGRESS_MARK.length);
  return (EGRESS_OUTCOMES as readonly string[]).includes(last ?? '') ? last as EgressOutcome : undefined;
}

/** The last sandbox outcome on the screen, if any. */
export function sandboxOutcome(screen: string): SandboxOutcome | undefined {
  const last = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(SANDBOX_MARK)).at(-1)?.slice(SANDBOX_MARK.length);
  return (OUTCOMES as readonly string[]).includes(last ?? '') ? last as SandboxOutcome : undefined;
}
