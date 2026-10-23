// The job's own container runtime (issue #1295, design.md "Work tree" → "The job's container runtime"): a job that ran
// `podman system reset --force` with HOME and XDG_DATA_HOME moved, but XDG_RUNTIME_DIR left as it was, wiped the host's
// rootless runtime dir, and the hopper stack stopped answering. So each job runs podman in a runtime of its own: its runtime
// dir `<the user's runtime dir>/hopper-runtime-<job id>`, its storage `<scratch dir>/containers/storage`, its socket
// `<runtime dir>/podman/podman.sock`. The job's shell gets them as its environment (`env.sh`), and `podman` and `docker` on
// its PATH are guards that put them back whatever the job changed, refuse a flag that names another runtime, and refuse
// `podman system reset|migrate|renumber`. A machine with no podman, or no runtime dir of the user's, gives the job no
// runtime: DOCKER_HOST names a socket that is not there, so the host's socket is closed to it all the same. The reap
// (reap.ts) resets that runtime, never another, and removes it; the survey names each one left. Beside reap.ts, as a client
// target runs these scripts too. Imports nothing of hopper.

/** The runtime dir's name in the user's runtime dir, before the job id. */
export const RUNTIME_PREFIX = 'hopper-runtime-';
/** Where the job's runtime keeps its files in its scratch dir: the storage, its config and the guards. */
export const RUNTIME_SUBDIR = 'containers';

/**
 * The user's runtime dir as the shell sees it, `$h`: XDG_RUNTIME_DIR, else `/run/user/<uid>`; a job's runtime dir given
 * as it (a shell of a job's own) names its parent.
 */
export const HOST_RUNTIME_SH = `h=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; case \${h##*/} in ${RUNTIME_PREFIX}*) h=\${h%/*};; esac;`;

/**
 * Writes the runtime's config, `conf <runtime dir> <containers dir>`: storage under the scratch dir, everything that runs
 * under the runtime dir. Read over the user's own (CONTAINERS_CONF_OVERRIDE is read last), and the storage config in
 * place of theirs (CONTAINERS_STORAGE_CONF), its storage named twice: rootless Podman 4 reads no graphroot from a config
 * that is not the user's own, only rootless_storage_path, and so kept a job's images in the user's storage. The reap
 * writes it again before it resets, so a job that changed it cannot point the reset elsewhere. Its formats are in single
 * quotes, with no `\"`: a native Windows client gets the reap as one command line, where Git for Windows' sh reads a `\"`
 * back as `\\"` (issue #2427).
 */
export const CONF_SH = [
  'conf() {',
  `  printf '[engine]\\ntmp_dir = "%s/libpod/tmp"\\nvolume_path = "%s/storage/volumes"\\n[network]\\nnetwork_config_dir = "%s/networks"\\n' "$1" "$2" "$2" > "$2/containers.conf" &&`,
  `  printf '[storage]\\ngraphroot = "%s/storage"\\nrunroot = "%s/storage"\\nrootless_storage_path = "%s/storage"\\n' "$2" "$1" "$2" > "$2/storage.conf";`,
  '};',
].join(' ');

/**
 * The label a job's container or volume carries (issue #1120): `hopper.job=<its job id>`. Whatever a job starts in a
 * container runtime with it (the hopper's own tests do) is the job's: its reap removes it, and the sweep reaps an ended
 * job that still has one. The guards put it on everything a job makes in its own runtime (issue #1295).
 */
export const JOB_LABEL = 'hopper.job';

/**
 * What the reap asks of a job's container before it removes it (issue #975), for the job's parts list: its name, image,
 * and when it started and stopped, one line, space-separated (none of them holds a space). The times as JSON, so Podman's
 * time and Docker's string read the same; a zero time is one that never came. Docker's name starts with `/`.
 */
export const DETAILS_FORMAT = '{{.Name}} {{.Config.Image}} {{json .State.StartedAt}} {{json .State.FinishedAt}}';
/** The line the reap prints for a container it removes, before its details: `hopper-container-details <id> <details>`. */
export const DETAILS_MARK = 'hopper-container-details ';

// The guard, one line after its `#!/bin/sh`, named podman or docker: the job's runtime from env.sh beside its directory,
// whatever the caller changed (HOME, XDG_*, DOCKER_HOST, a context), then the real command of that name further on PATH.
// Refused, exit 126: a global flag that names another runtime or its storage, `podman system reset|migrate|renumber`, and
// an argument that names the host's runtime dir, its storage or a host container socket (a mount of it, a URL). Only the
// options before the command are read as flags; a value-taking global option skips its value. What makes a container,
// pod, volume or network gets the job's label (`k`: the argument it goes after); the job is the scratch dir's name.
const GUARD = [
  'e="${0%/*}/../env.sh"; if [ -r "$e" ]; then . "$e"; else printf "hopper: %s\\n" "the job container runtime is not set up" >&2; exit 125; fi;',
  'n=${0##*/}; deny() { printf "hopper: %s %s: %s\\n" "$n" "$1" "$2" >&2; exit 126; };',
  `jid=\${0%/${RUNTIME_SUBDIR}/bin/*}; jid=\${jid##*/}; case $jid in ""|*[!A-Za-z0-9-]*) jid=;; esac;`,
  HOST_RUNTIME_SH,
  'u=/run/user/$(id -u); for a in "$@"; do case $a in',
  '  *"$h/podman"*|*"$h/containers"*|*"$h/libpod"*|*"$h/docker.sock"*|*"$u/podman"*|*"$u/containers"*|*"$u/libpod"*|*"$u/docker.sock"*'
    + '|*/run/docker.sock*|*/run/podman/podman.sock*|*/.local/share/containers*)',
  '    deny "$a" "names the host\'s container runtime, which a job never reaches";;',
  'esac; done;',
  'w=; v=; i=0; k=0; for a in "$@"; do i=$((i+1));',
  '  if [ -n "$v" ]; then v=; continue; fi;',
  '  if [ -z "$w" ]; then case $n:$a in',
  '    podman:--url|podman:--url=*|podman:--connection|podman:--connection=*|podman:-c|podman:-c?*|podman:--remote|podman:--remote=*|podman:-r'
    + '|podman:--root|podman:--root=*|podman:--runroot|podman:--runroot=*|podman:--tmpdir|podman:--tmpdir=*|podman:--imagestore|podman:--imagestore=*'
    + '|podman:--volumepath|podman:--volumepath=*|podman:--network-config-dir|podman:--network-config-dir=*|podman:--config|podman:--config=*'
    + '|docker:-H|docker:-H?*|docker:--host|docker:--host=*|docker:-c|docker:-c?*|docker:--context|docker:--context=*|docker:--config|docker:--config=*)',
  '      deny "$a" "a job uses only its own container runtime";;',
  '    *:--log-level|*:-l|*:--cgroup-manager|*:--events-backend|*:--hooks-dir|*:--module|*:--network-cmd-path|*:--out|*:--runtime|*:--runtime-flag'
    + '|*:--ssh|*:--identity|*:--storage-driver|*:--storage-opt|*:--cdi-spec-dir|*:--tlscacert|*:--tlscert|*:--tlskey) v=1;;',
  '    *:-*) ;;',
  '    *) w=$a; case $a in run|create) k=$i;; esac;;',
  '  esac; continue; fi;',
  '  case $a in -*) continue;; esac;',
  '  case $n:$w:$a in',
  '    podman:system:reset|podman:system:migrate|podman:system:renumber) deny "system $a" "refused in a job";;',
  '    *:container:run|*:container:create|*:pod:create|*:volume:create|*:network:create) k=$i;;',
  '  esac; break;',
  'done;',
  `if [ "$k" -gt 0 ] && [ -n "$jid" ]; then i=0; for a in "$@"; do i=$((i+1)); shift; set -- "$@" "$a"; [ "$i" -eq "$k" ] && set -- "$@" --label "${JOB_LABEL}=$jid"; done; fi;`,
  'r=; o=$IFS; IFS=:; for p in $PATH; do [ -n "$p" ] && [ -x "$p/$n" ] && ! [ "$p/$n" -ef "$0" ] && { r=$p/$n; break; }; done; IFS=$o;',
  '[ -n "$r" ] || { printf "hopper: %s: not found\\n" "$n" >&2; exit 127; };',
  // An image build is a heavy step (issue #2622 part 3): it runs through the job's gate, as the heavy shims' commands do.
  'case $w in build|buildx) [ -z "${HOPPER_HEAVY_HELD:-}" ] && [ -r "${HOPPER_HEAVY:-}" ] && exec sh "$HOPPER_HEAVY" "$r" "$@";; esac;',
  'exec "$r" "$@"',
].map((l) => l.trim()).join(' ');

// The job's `systemd-run`, one line after its `#!/bin/sh`: podman starts each health check as a systemd timer whose
// podman runs with the user manager's environment, so it took the user's runtime dir, joined the user's namespace and never
// found the job's container — testcontainers then waits on a health check that never passes. For podman's `healthcheck
// run` it adds the job's runtime variables (env.sh); every other call goes to the real systemd-run as it was.
const SYSTEMD_RUN = [
  'r=; o=$IFS; IFS=:; for p in $PATH; do [ -n "$p" ] && [ -x "$p/systemd-run" ] && ! [ "$p/systemd-run" -ef "$0" ] && { r=$p/systemd-run; break; }; done; IFS=$o;',
  '[ -n "$r" ] || { printf "hopper: %s\\n" "systemd-run: not found" >&2; exit 127; };',
  'case " $* " in *" healthcheck run "*)',
  '  e="${0%/*}/../env.sh"; [ -r "$e" ] && . "$e";',
  '  set -- --setenv=XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" --setenv=CONTAINERS_CONF_OVERRIDE="$CONTAINERS_CONF_OVERRIDE"'
    + ' --setenv=CONTAINERS_STORAGE_CONF="$CONTAINERS_STORAGE_CONF" ${DBUS_SESSION_BUS_ADDRESS:+"--setenv=DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"} "$@";;',
  'esac;',
  'exec "$r" "$@"',
].map((l) => l.trim()).join(' ');

// $1 the job's scratch dir, $2 the guard: the guards podman and docker written in its containers dir; $3 a heavy step's
// shim and $4 the names it is written as, beside them (issue #2622 part 3), when given. Prints written or failed. A step of
// its own, typed before the setup (issue #2234): with the guard in it, the setup did not fit a terminal line.
const GUARDS_SCRIPT = [
  'c=$1/' + RUNTIME_SUBDIR + ';',
  `mkdir -p "$c/bin" || { echo failed; exit 0; };`,
  'for n in podman docker; do { printf "#!/bin/sh\\n%s\\n" "$2" > "$c/bin/$n" && chmod 755 "$c/bin/$n"; } || { echo failed; exit 0; }; done;',
  'if [ -n "$3" ]; then for n in $4; do { printf "#!/bin/sh\\n%s\\n" "$3" > "$c/bin/$n" && chmod 755 "$c/bin/$n"; } || { echo failed; exit 0; }; done; fi;',
  'echo written',
].map((l) => l.trim()).join(' ');

// $1 the job id, $2 its scratch dir, $3 the job's systemd-run, $4 `service` to start the runtime's socket (a pane's job:
// it lives in the job's scope until the reap stops it), after the guards (GUARDS_SCRIPT). Prints one word: own, none or
// failed. The user's bus and systemd's private socket are hard links in the runtime dir: podman's rootless network
// namespace sees a /run of its own, with only the runtime dir in it, and aardvark-dns reaches systemd through them.
const SETUP_SCRIPT = [
  'i=$1; s=$2; c=$s/' + RUNTIME_SUBDIR + ';',
  CONF_SH,
  '[ -x "$c/bin/podman" ] && [ -x "$c/bin/docker" ] || { echo failed; exit 0; };',
  HOST_RUNTIME_SH,
  `j=$h/${RUNTIME_PREFIX}$i;`,
  'if command -v podman >/dev/null 2>&1 && [ -d "$h" ] && [ ! -L "$h" ] && [ -w "$h" ] && mkdir -p "$j" && [ ! -L "$j" ] && chmod 700 "$j"; then',
  '  mkdir -p "$j/systemd" "$j/podman" || { echo failed; exit 0; };',
  '  [ -S "$h/bus" ] && ln -f "$h/bus" "$j/bus" 2>/dev/null;',
  '  [ -S "$h/systemd/private" ] && ln -f "$h/systemd/private" "$j/systemd/private" 2>/dev/null;',
  '  printf "%s\\n" "$s" > "$j/scratch" && conf "$j" "$c" || { echo failed; exit 0; };',
  '  { printf "#!/bin/sh\\n%s\\n" "$3" > "$c/bin/systemd-run" && chmod 755 "$c/bin/systemd-run"; } || { echo failed; exit 0; };',
  '  { printf "export XDG_RUNTIME_DIR=\\"%s\\" CONTAINERS_CONF_OVERRIDE=\\"%s/containers.conf\\" CONTAINERS_STORAGE_CONF=\\"%s/storage.conf\\" DOCKER_HOST=\\"unix://%s/podman/podman.sock\\" KIND_EXPERIMENTAL_PROVIDER=podman\\n" "$j" "$c" "$c" "$j";',
  '    if [ -S "$j/bus" ]; then printf "export DBUS_SESSION_BUS_ADDRESS=\\"unix:path=%s/bus\\"\\n" "$j"; fi; } > "$c/env.sh" || { echo failed; exit 0; };',
  // In the sandbox (job-sandbox.ts) podman cannot start a runtime of its own: there it is a client of the job's socket.
  '  printf "if [ -n \\"\\${HOPPER_SANDBOXED:-}\\" ]; then export CONTAINER_HOST=\\"unix://%s/podman/podman.sock\\"; else unset CONTAINER_HOST; fi\\n" "$j" >> "$c/env.sh" || { echo failed; exit 0; };',
  '  how=own;',
  'else',
  '  printf "export DOCKER_HOST=\\"unix://%s/no-container-runtime.sock\\"\\n" "$c" > "$c/env.sh" || { echo failed; exit 0; };',
  '  how=none;',
  '  printf "unset CONTAINER_HOST\\n" >> "$c/env.sh" || { echo failed; exit 0; };',
  'fi;',
  '{ printf "unset CONTAINER_CONNECTION DOCKER_CONTEXT\\n";',
  '  printf "case :\\$PATH: in *:%s/bin:*) ;; *) PATH=\\"%s/bin:\\$PATH\\"; export PATH;; esac\\n" "$c" "$c"; } >> "$c/env.sh" || { echo failed; exit 0; };',
  'if [ "$how" = own ] && [ "$4" = service ]; then',
  '  ( . "$c/env.sh"; nohup "$c/bin/podman" system service --time=0 "unix://$j/podman/podman.sock" </dev/null >/dev/null 2>&1 & );',
  'fi;',
  'echo "$how"',
].map((l) => l.trim()).join(' ');

/**
 * A print-agent turn's socket (issue #1295), after the runtime command in the same shell: the job's runtime socket started
 * in the turn's scope, its pid kept in the shell's `sp` (never in a file the job can write), when the shell has the job's
 * own runtime; `sp` empty otherwise. `kill "$sp"` and `wait "$sp"` stop it when the turn ends: nothing of a turn outlives it.
 */
export const turnServiceCommand = (jobId: string, scratch: string): string =>
  `sp=; case \${XDG_RUNTIME_DIR:-} in */${RUNTIME_PREFIX}${jobId}) ${shq(`${scratch}/${RUNTIME_SUBDIR}/bin/podman`)} system service --time=0 `
  + `"unix://$XDG_RUNTIME_DIR/podman/podman.sock" </dev/null >/dev/null 2>&1 & sp=$!;; esac;`;

/** What the runtime command prints, followed by its outcome. */
export const RUNTIME_MARK = 'hopper-runtime-';
/** own: the job has a runtime of its own; none: no podman or runtime dir here, the host's socket closed all the same; failed. */
export type RuntimeOutcome = 'own' | 'none' | 'failed';
const OUTCOMES: readonly RuntimeOutcome[] = ['own', 'none', 'failed'];
/** What the guards command prints, followed by its outcome: written or failed. */
export const GUARDS_MARK = 'hopper-guards-';
export type GuardsOutcome = 'written' | 'failed';

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The job's `env.sh`, in its scratch dir. */
export const runtimeEnvOf = (scratch: string): string => `${scratch}/${RUNTIME_SUBDIR}/env.sh`;

/**
 * The command that writes the job's guards, podman and docker, in its scratch dir, then prints its outcome as two words,
 * so the command's own echo never reads as it. The first of the two steps a pane's shell is given (issue #2234): each one
 * fits a terminal line.
 */
export function guardsCommand(scratch: string, heavy?: HeavyShims): string {
  const shims = heavy ? ` ${shq(heavy.shim)} ${shq(heavy.names.join(' '))}` : '';
  return `o=$(sh -c ${shq(GUARDS_SCRIPT)} hopper-guards ${shq(scratch)} ${shq(GUARD)}${shims}); printf 'hopper-guards-%s\\n' "\${o:-failed}"`;
}

/** A heavy step's shim and the command names it is written as (issue #2622 part 3, src/domain/heavy-steps.ts `HEAVY_SHIMS`). */
export interface HeavyShims { shim: string; names: readonly string[] }

/**
 * The command that sets the job's runtime up and puts it in the shell's environment, then prints its outcome as two words,
 * so the command's own echo never reads as it. Any POSIX shell: the script runs in sh, the shell only sources env.sh.
 * After the guards command. `service`: start the runtime's socket too (a pane's job, in its scope).
 */
export function setupCommand(jobId: string, scratch: string, service: boolean): string {
  const env = shq(runtimeEnvOf(scratch));
  return `o=$(sh -c ${shq(SETUP_SCRIPT)} hopper-runtime ${shq(jobId)} ${shq(scratch)} ${shq(SYSTEMD_RUN)}${service ? ' service' : ''}); `
    + `[ -r ${env} ] && . ${env}; printf 'hopper-runtime-%s\\n' "\${o:-failed}"`;
}

/** Both steps in one, for a shell that runs a script rather than lines typed into a terminal (a print-agent turn). */
export const runtimeCommand = (jobId: string, scratch: string, service: boolean, heavy?: HeavyShims): string =>
  `${guardsCommand(scratch, heavy)} >/dev/null; ${setupCommand(jobId, scratch, service)}`;

/** The argv that runs both steps outside a shell's own environment, for a test. */
export const runtimeSetupArgv = (jobId: string, scratch: string, service: boolean): string[] =>
  ['sh', '-c', `sh -c ${shq(GUARDS_SCRIPT)} hopper-guards ${shq(scratch)} ${shq(GUARD)} >/dev/null; exec sh -c ${shq(SETUP_SCRIPT)} hopper-runtime "$@"`,
    'hopper-runtime', jobId, scratch, SYSTEMD_RUN, ...(service ? ['service'] : [])];

/** The last guards outcome on the screen, if any. */
export function guardsOutcome(screen: string): GuardsOutcome | undefined {
  const last = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(GUARDS_MARK)).at(-1)?.slice(GUARDS_MARK.length);
  return last === 'written' || last === 'failed' ? last : undefined;
}

/** The last runtime outcome on the screen, if any. */
export function runtimeOutcome(screen: string): RuntimeOutcome | undefined {
  const last = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(RUNTIME_MARK)).at(-1)?.slice(RUNTIME_MARK.length);
  return (OUTCOMES as readonly string[]).includes(last ?? '') ? last as RuntimeOutcome : undefined;
}

/**
 * The reap's part (reap.ts), with `id` the job id, `s` its scratch dir or empty, `to` the timeout prefix, `k` keep/discard:
 * the job's runtime dir, when there is one, has its containers listed, then removed with everything else in it by a
 * reset — through the config written again here, with the job's storage and runtime dir named on the command line, so
 * nothing the job changed can point it at another runtime (its run state only in that config: Podman 4 refuses a
 * `--runroot` longer than 50 characters, and the runtime dir's is) —, then every process still started from it stopped, and the
 * dir removed. The scratch dir is the one given, else the one the runtime dir names, and only ever the job's own; a runtime dir
 * that is gone while the given scratch dir holds its storage is made again for this (issue #1452). Not a
 * timed-out job's (keep): it may go on there.
 */
export const REAP_RUNTIME_SH = [
  'if [ "$k" != keep ]; then',
  HOST_RUNTIME_SH,
  `  j=$h/${RUNTIME_PREFIX}$id;`,
  // Its runtime dir gone (a reboot clears the user's), its storage still in the scratch dir given (issue #1452): the
  // runtime dir made again, so the storage is reset and removed as below. Else its files of the job's user namespace stay.
  `  case $s in /*/.worktrees/@scratch/"$id"|/*/.hopper-scratch/"$id") [ ! -e "$j" ] && [ -d "$h" ] && [ -d "$s/${RUNTIME_SUBDIR}/storage" ] && [ ! -L "$s/${RUNTIME_SUBDIR}" ] && [ ! -L "$s/${RUNTIME_SUBDIR}/storage" ] && command -v podman >/dev/null 2>&1 && mkdir -m 700 "$j" 2>/dev/null;; esac;`,
  '  if [ -d "$j" ] && [ ! -L "$j" ]; then',
  '    js=$s; [ -n "$js" ] || js=$(head -n 1 "$j/scratch" 2>/dev/null);',
  '    case $js in /*/.worktrees/@scratch/"$id"|/*/.hopper-scratch/"$id") ;; *) js=;; esac;',
  `    c=$js/${RUNTIME_SUBDIR};`,
  '    if [ -n "$js" ] && command -v podman >/dev/null 2>&1 && [ -d "$c" ] && [ ! -L "$c" ] && { [ ! -e "$c/storage" ] || { [ -d "$c/storage" ] && [ ! -L "$c/storage" ]; }; }; then',
  `      ${CONF_SH}`,
  '      if conf "$j" "$c"; then',
  '        pm() { pt=$1; shift; $pt env -u CONTAINER_HOST -u CONTAINER_CONNECTION XDG_RUNTIME_DIR="$j" CONTAINERS_CONF_OVERRIDE="$c/containers.conf" CONTAINERS_STORAGE_CONF="$c/storage.conf" podman --root "$c/storage" --tmpdir "$j/libpod/tmp" "$@"; };',
  '        ids=; for x in $(pm "$to" ps -aq 2>/dev/null); do case $x in -*|*[!A-Za-z0-9_.-]*) continue;; esac; printf "hopper-removed-container %s\\n" "$x"; ids="$ids $x";',
  `          xd=$(pm "$to" inspect --format "${DETAILS_FORMAT}" "$x" 2>/dev/null | head -n 1); [ -n "$xd" ] && printf "${DETAILS_MARK}%s %s\\n" "$x" "$xd";`,
  '        done;',
  '        for x in $(pm "$to" volume ls -q 2>/dev/null); do case $x in -*|*[!A-Za-z0-9_.-]*) continue;; esac; printf "hopper-removed-volume %s\\n" "$x"; done;',
  '        tr=; command -v timeout >/dev/null 2>&1 && tr="timeout 120";',
  '        pm "$tr" system reset --force >/dev/null 2>&1;',
  '        [ -e "$c/storage" ] && pm "$tr" unshare rm -rf "$c/storage" >/dev/null 2>&1;',
  // What of a container the reset could not stop, in the user's systemd: its health check timer (`<id>-<n>.timer`) stopped,
  // its scope and its conmon's scope killed (a stop waits out the scope's own timeout).
  '        if [ -n "$ids" ] && command -v systemctl >/dev/null 2>&1; then',
  '          set --; for x in $ids; do set -- "$@" "$x*.timer" "$x*.service"; done; $to systemctl --user stop "$@" >/dev/null 2>&1;',
  '          set --; for x in $ids; do set -- "$@" "libpod-$x*.scope" "libpod-conmon-$x*.scope"; done; $to systemctl --user kill -s KILL "$@" >/dev/null 2>&1;',
  '        fi;',
  '      fi;',
  '    fi;',
  // Whatever still runs from the job's runtime dir: its pause process, a network helper. Never this script.
  '    if [ -r /proc/self/environ ]; then',
  '      rp() { grep -lzxF "XDG_RUNTIME_DIR=$j" /proc/[0-9]*/environ 2>/dev/null | sed -n "s|^/proc/\\([0-9]*\\)/environ\\$|\\1|p" | grep -vx "$$"; };',
  '      l=$(rp); [ -n "$l" ] && kill -KILL $l 2>/dev/null;',
  '    fi;',
  '    rm -rf "$j";',
  '  fi;',
  'fi;',
].map((l) => l.trim()).join(' ');

/** The survey's part (reap.ts): each job whose runtime dir is still there, as a job with a container left. */
export const SURVEY_RUNTIME_SH = [
  HOST_RUNTIME_SH,
  `for d in "$h"/${RUNTIME_PREFIX}*; do [ -d "$d" ] && [ ! -L "$d" ] || continue; printf "hopper-container %s\\n" "\${d##*/${RUNTIME_PREFIX}}"; done;`,
].join(' ');
