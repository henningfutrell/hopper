// The storage prune (issue #2494, design.md "Hopper's own disk use" → "Part 8"): what runs on a machine to free its
// container storage. A fixed POSIX sh script, run through the machine's own connection (this machine, ssh, or a client
// target's `/prune`), as the reap and the survey are (reap.ts). Imports nothing of hopper but its own directory.

import { JOB_LABEL } from './job-runtime.ts';

/** How long a prune may take: each runtime call is cut off at 60 s, and an image prune may remove many. */
export const PRUNE_TIMEOUT_MS = 300000;
export const PRUNE_DONE = 'hopper-prune-done';

/**
 * Label keys whose container or volume the prune never removes (src/domain/storage-prune.ts holds the same, which
 * test/domain/storage-prune.test.ts checks): the stack's, a kind node's, a job's; and every `io.hopper.` key, the boxes'.
 */
export const KEEP_LABELS = ['com.docker.compose.project', 'io.podman.compose.project', 'io.x-k8s.kind.cluster', JOB_LABEL] as const;
/** The hopper's own images (scripts/update.sh keeps the one it runs and the one before): never pruned. */
export const HOPPER_IMAGE_LABEL = 'org.opencontainers.image.title=hopper';

// $1 the age in days, $2… the exited containers the hopper chose, each `<runtime>:<full id>`. Each runtime call is cut off
// at 60 s where `timeout` is. Nothing is forced: the runtime keeps what a container uses or what runs. It prints one line
// per removal, `hopper-pruned|<runtime>|<container|volume|image>|<id>|<size or empty>`.
const PRUNE_SCRIPT = [
  'd=$1; shift; case $d in ""|*[!0-9]*) exit 2;; esac; to=; command -v timeout >/dev/null 2>&1 && to="timeout 60";',
  `keep() { for kk in $1; do case $kk in io.hopper.*|${KEEP_LABELS.join('|')}) return 0;; esac; done; return 1; };`,
  // Each container: still exited, still with no label it keeps, its writable layer's size read, then removed with its
  // anonymous volumes. A named volume (a seat's home, the stack's) stays.
  'for c do rt=${c%%:*}; id=${c#*:}; case $rt in docker|podman) ;; *) continue;; esac; case $id in ""|*[!0-9a-f]*) continue;; esac;',
  '  command -v "$rt" >/dev/null 2>&1 || continue;',
  `  st=$($to "$rt" container inspect --format '{{.State.Status}}|{{range $k, $v := .Config.Labels}}{{$k}} {{end}}' "$id" 2>/dev/null | head -n 1);`,
  '  [ "${st%%|*}" = exited ] || continue; keep "${st#*|}" && continue;',
  `  sz=$($to "$rt" container inspect --size --format '{{.SizeRw}}' "$id" 2>/dev/null | head -n 1); case $sz in ""|*[!0-9]*) sz=;; *) sz=\${sz}B;; esac;`,
  '  $to "$rt" rm -v "$id" >/dev/null 2>&1 && printf "hopper-pruned|%s|container|%s|%s\\n" "$rt" "$id" "$sz";',
  'done;',
  'for rt in docker podman; do command -v "$rt" >/dev/null 2>&1 || continue;',
  // Each volume no container uses that is anonymous (a 64-hex name, and podman says so or docker labels it so), with no
  // label it keeps: its size read where its mount point can be read, then removed.
  `  vf='{{.Anonymous}}|{{range $k, $v := .Labels}}{{$k}} {{end}}|{{.Mountpoint}}'; [ "$rt" = docker ] && vf='-|{{range $k, $v := .Labels}}{{$k}} {{end}}|{{.Mountpoint}}';`,
  '  for v in $($to "$rt" volume ls -q --filter dangling=true 2>/dev/null); do case $v in *[!0-9a-f]*) continue;; esac; [ ${#v} -eq 64 ] || continue;',
  '    vi=$($to "$rt" volume inspect --format "$vf" "$v" 2>/dev/null | head -n 1); [ -n "$vi" ] || continue; an=${vi%%|*}; vr=${vi#*|}; vk=${vr%%|*}; mp=${vr#*|};',
  '    case " $vk " in *" com.docker.volume.anonymous "*) an=true;; esac; [ "$an" = true ] || continue; keep "$vk" && continue;',
  '    vs=; if [ -d "$mp" ]; then k=$($to du -sk "$mp" 2>/dev/null | cut -f 1); case $k in ""|*[!0-9]*) ;; *) vs=$((k * 1024))B;; esac; fi;',
  '    $to "$rt" volume rm "$v" >/dev/null 2>&1 && printf "hopper-pruned|%s|volume|%s|%s\\n" "$rt" "$v" "$vs";',
  '  done;',
  // The images no container uses, built more than the age ago, by the runtime's own prune, never the hopper's own; each
  // one's size as the list before it said.
  `  il=$($to "$rt" image ls -a --no-trunc --format '{{.ID}}|{{.Size}}' 2>/dev/null);`,
  `  for i in $($to "$rt" image prune -a -f --filter "until=$((d * 24))h" --filter "label!=${HOPPER_IMAGE_LABEL}" 2>/dev/null | sed -n -e 's/^[Dd]eleted: //' -e 's/^sha256://' -e '/^[0-9a-f]\\{64\\}$/p'); do`,
  '    is=$(printf "%s\\n" "$il" | sed -n "s/^\\(sha256:\\)\\{0,1\\}$i|//p" | head -n 1); printf "hopper-pruned|%s|image|%s|%s\\n" "$rt" "$i" "$is";',
  '  done;',
  'done;',
  `printf "%s\\n" ${PRUNE_DONE}`,
].map((l) => l.trim()).join(' ');

/** The argv that prunes the machine's container storage: `days` its age, `containers` the exited ones chosen. */
export const pruneArgv = (days: number, containers: readonly string[]): string[] => ['sh', '-c', PRUNE_SCRIPT, 'sh', String(days), ...containers];

/** One thing a prune removed, with its size when the runtime said it. */
export interface PrunedItem { runtime: 'docker' | 'podman'; kind: 'container' | 'volume' | 'image'; id: string; bytes?: number }

const UNITS: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };
/** A size as a runtime prints it (`1.5GB`, `20 MB`, `4096B`, decimal units), in bytes; undefined when it is not one. */
function sizeOf(text: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([kKMGTP]?)B$/.exec(text?.trim() ?? '');
  return m ? Math.round(Number(m[1]) * UNITS[m[2]!]!) : undefined;
}

/** What a finished prune removed. Undefined when it did not finish. */
export function readPrune(stdout: string): { removed: PrunedItem[] } | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(PRUNE_DONE)) return undefined;
  const removed: PrunedItem[] = [];
  for (const l of lines) {
    const [mark, runtime, kind, id, size] = l.split('|');
    if (mark !== 'hopper-pruned' || (runtime !== 'docker' && runtime !== 'podman') || (kind !== 'container' && kind !== 'volume' && kind !== 'image') || !/^[0-9a-f]{12,64}$/.test(id ?? '')) continue;
    const bytes = sizeOf(size);
    removed.push({ runtime, kind, id: id!, ...(bytes !== undefined ? { bytes } : {}) });
  }
  return { removed };
}

/** A container a prune may take: `<runtime>:<hex id>`, never an option or a name. */
const CONTAINER = /^(docker|podman):[0-9a-f]{12,64}$/;

/** The argv a `/prune` body asks for; else why it is refused. */
export function pruneArgvOf(body: unknown): string[] | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { days?: unknown; containers?: unknown };
  if (typeof b.days !== 'number' || !Number.isInteger(b.days) || b.days < 1 || b.days > 3650) return 'days must be a whole number of days from 1 to 3650';
  if (!Array.isArray(b.containers) || b.containers.length > 256 || !b.containers.every((c) => typeof c === 'string' && CONTAINER.test(c))) {
    return 'containers must be at most 256 of <docker|podman>:<hex id>';
  }
  return pruneArgv(b.days, b.containers as string[]);
}
