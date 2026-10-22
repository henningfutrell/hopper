// The reap and the survey (issues #401, #410, #1103, #1188, design.md "Work tree" → "The reap"), beside server.ts for its size:
// what runs on a job's machine when the job ends, and what the sweep asks of it: fixed POSIX sh scripts,
// run through the machine's own connection (this machine, ssh, or a client target's `/reap` and
// `/survey`), never typed into a pane where Claude may still be. They live in the client's directory because a client
// target runs them, and a client release is the files in that directory. Imports nothing of hopper but its own directory.

import { DETAILS_FORMAT, DETAILS_MARK, JOB_LABEL, REAP_RUNTIME_SH, SURVEY_RUNTIME_SH } from './job-runtime.ts';

/** A job id the scripts take: a uuid, or a test's plain name. Never a pattern, a path or an option. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const isJobId = (id: unknown): id is string => typeof id === 'string' && JOB_ID.test(id);

/** The transient user scope a job's pane shell (or a print agent's turn) runs in, when the machine has systemd. */
export const scopeUnitOf = (jobId: string): string => `hopper-job-${jobId}`;

/** The label a job's container or volume carries (issue #1120), job-runtime.ts. */
export { JOB_LABEL };

/**
 * How long a reap may take (issue #1295): a scope stop waits up to 10 s, and a job's own container runtime is reset, its
 * containers stopped, which a kind cluster makes slow.
 */
export const REAP_TIMEOUT_MS = 180000;

export const REAP_DONE = 'hopper-reaped';
export const SURVEY_DONE = 'hopper-surveyed';

/**
 * Where a job's files are in its work tree (issue #1188, src/domain/job-layout.ts, which test/domain/job-layout.test.ts
 * holds these to): `.worktrees/<name>/<job id>` its worktrees, `.worktrees/@scratch/<job id>` its scratch dir. The layout
 * before (`.hopper-scratch/<job id>`, `workspace/worktrees/<name>-<job id>`) is only found, to be removed.
 */
export const LAYOUT = { worktrees: '.worktrees', scratch: '.worktrees/@scratch', oldScratch: '.hopper-scratch', oldWorktrees: 'workspace/worktrees' } as const;

/**
 * Shell functions the reap and the leftovers listing (leftovers.ts, issue #1116) share: whether a repository holds work no
 * remote has, by one rule.
 */
export const UNPUSHED_SH: readonly string[] = [
  // Whether the work of commit $2 in repository $1 is on a remote though its commits are not (issue #1187: a rebase, a
  // re-run that made the commits again, a squash or rebase merge): the default branch or one of the newest remote
  // branches has each of its patches (`git cherry`, when it holds no merge of its own), or has every file it changed from
  // the default branch as it has it. No change from the default branch at all is on it too.
  'landed() { ld=$1; lt=$2; la=; lm=; lo=$(git -C "$ld" rev-parse -q --verify refs/remotes/origin/HEAD 2>/dev/null);',
  '  if [ -n "$lo" ] && lm=$(git -C "$ld" merge-base "$lo" "$lt" 2>/dev/null); then',
  '    git -C "$ld" diff --quiet "$lm" "$lt" -- 2>/dev/null && return 0;',
  '    la=$(git -C "$ld" diff --no-renames --name-only "$lm" "$lt" -- 2>/dev/null) || la=;',
  '  fi;',
  '  for lr in $lo $(git -C "$ld" for-each-ref --sort=-committerdate --count=30 --format="%(objectname)" refs/remotes 2>/dev/null); do',
  '    if [ -n "$la" ] && lb=$(git -C "$ld" diff --no-renames --name-only "$lr" "$lt" -- 2>/dev/null) && [ -z "$(printf "%s\\n%s\\n" "$la" "$lb" | sort | uniq -d)" ]; then return 0; fi;',
  '    [ -z "$(git -C "$ld" rev-list --merges -n 1 "$lt" --not "$lr" 2>/dev/null)" ] && lc=$(git -C "$ld" cherry "$lr" "$lt" 2>/dev/null) && ! printf "%s\\n" "$lc" | grep -q "^+" && return 0;',
  '  done; return 1; };',
  // Whether one of the commits $2 names in repository $1 holds work no remote has, by its commits and then by landed.
  'unpushed() { ut=$(git -C "$1" rev-parse $2 2>/dev/null) || return 0; for u in $ut; do',
  '  [ -n "$(git -C "$1" log --oneline -1 "$u" --not --remotes 2>/dev/null)" ] && ! landed "$1" "$u" && return 0;',
  'done; return 1; };',
  // Whether the checkout $1 holds work not pushed: a change, or a commit no remote has. A worktree (.git a file) answers for
  // its own HEAD; a clone for HEAD and every branch it has. A node_modules link to the shared dependencies (issue #410) is no
  // work of the job's.
  'held() { hd=$1; hr="HEAD --branches"; [ -f "$hd/.git" ] && hr=HEAD;',
  '  ! hs=$(git -C "$hd" status --porcelain 2>/dev/null) || [ -n "$(printf "%s\\n" "$hs" | grep -vx "?? node_modules")" ] || ! hu=$(git -C "$hd" log --oneline -1 $hr --not --remotes 2>/dev/null) || { [ -n "$hu" ] && unpushed "$hd" "$hr"; }; };',
];

// $1 the job id, $2 its scratch dir or empty, $3 `keep` to keep the scratch dir whatever it holds (a timed-out
// job's, issue #630: it may go on there), or `discard` to remove it whatever it holds (a person discarded the work
// it kept, issue #1010). The job's worktrees are `<work tree>/.worktrees/<name>/<job id>` (issue #1188), the work tree
// the one the scratch dir is in; they go or stay with the scratch dir. Its scratch dir and worktrees of the layout before
// are found by the same job id and go or stay with them, and once that layout holds no job's, the rest of it goes. Run
// with HOPPER_JOB_ID unset, so neither it nor what it starts matches the processes it stops.
const REAP_SCRIPT = [
  'id=$1; s=$2; k=$3;',
  // What the job's scope used (issue #2498), read from its cgroup before it is stopped: its peak memory, its CPU time and the
  // OOM kills in it, each `-` where the cgroup has none. HOPPER_CGROUP_ROOT stands in for the cgroup root in tests.
  'cr=${HOPPER_CGROUP_ROOT:-/sys/fs/cgroup}; cg=; command -v systemctl >/dev/null 2>&1 && cg=$(systemctl --user show -p ControlGroup --value "hopper-job-$id.scope" 2>/dev/null);',
  'case $cg in *..*) ;; /?*) [ -d "$cr$cg" ] && { mp=$(head -n 1 "$cr$cg/memory.peak" 2>/dev/null); cu=$(sed -n "s/^usage_usec //p" "$cr$cg/cpu.stat" 2>/dev/null);',
  '  ok=$(sed -n "s/^oom_kill //p" "$cr$cg/memory.events" 2>/dev/null); printf "hopper-used %s %s %s\\n" "${mp:--}" "${cu:--}" "${ok:--}"; };; esac;',
  // The job's scope: every process in it, whatever it did to its environment or session.
  'if command -v systemctl >/dev/null 2>&1; then systemctl --user stop "hopper-job-$id.scope" >/dev/null 2>&1; fi;',
  // Where there is no systemd, or for what left the scope: the processes carrying the job's id, and those run from its
  // scratch dir (issue #2489: a Gradle daemon of a JDK the job put there, which left the job's scope or environment).
  'pids() { { grep -lzx "HOPPER_JOB_ID=$id" /proc/[0-9]*/environ 2>/dev/null | sed -n "s|^/proc/\\([0-9]*\\)/environ\\$|\\1|p";',
  '  [ -n "$s" ] && find /proc -mindepth 2 -maxdepth 2 -path "/proc/[0-9]*/exe" -lname "$s/*" 2>/dev/null | sed -n "s|^/proc/\\([0-9]*\\)/exe\\$|\\1|p"; } | sort -u | grep -vx "$$"; };',
  'if [ -r /proc/self/environ ]; then',
  '  l=$(pids);',
  '  if [ -n "$l" ]; then',
  '    kill -TERM $l 2>/dev/null;',
  '    n=0; while [ $n -lt 30 ] && [ -n "$(pids)" ]; do sleep 0.1; n=$((n+1)); done;',
  '    l=$(pids); [ -n "$l" ] && kill -KILL $l 2>/dev/null;',
  '  fi;',
  'fi;',
  // The job's own container runtime (issue #1295, job-runtime.ts): reset and removed, its containers named as removed.
  'to=; command -v timeout >/dev/null 2>&1 && to="timeout 30";',
  REAP_RUNTIME_SH,
  // The job's containers and volumes (issue #1120): each labelled with its id, in each container runtime there, a
  // container with its anonymous volumes. Not a timed-out job's (keep): it may go on there. Only names a runtime gives
  // (never an option), each call cut off at 30 s where `timeout` is, so a runtime that hangs never holds the reap.
  'if [ "$k" != keep ]; then to=; command -v timeout >/dev/null 2>&1 && to="timeout 30"; for rt in docker podman; do',
  '  command -v "$rt" >/dev/null 2>&1 || continue;',
  `  for c in $($to "$rt" ps -aq --filter "label=${JOB_LABEL}=$id" 2>/dev/null); do case $c in -*|*[!A-Za-z0-9_.-]*) continue;; esac;`,
  `    ct=$($to "$rt" inspect --format "${DETAILS_FORMAT}" "$c" 2>/dev/null | head -n 1);`,
  `    $to "$rt" rm -f -v "$c" >/dev/null 2>&1 && printf "hopper-removed-container %s\\n" "$c" && { [ -z "$ct" ] || printf "${DETAILS_MARK}%s %s\\n" "$c" "$ct"; };`,
  '  done;',
  `  for v in $($to "$rt" volume ls -q --filter "label=${JOB_LABEL}=$id" 2>/dev/null); do case $v in -*|*[!A-Za-z0-9_.-]*) continue;; esac;`,
  '    $to "$rt" volume rm -f "$v" >/dev/null 2>&1 && printf "hopper-removed-volume %s\\n" "$v";',
  '  done;',
  'done; fi;',
  // The job's temp link /tmp/hopper-<job id> (issue #506), only while it points at this scratch dir.
  't=/tmp/hopper-$id; [ -n "$s" ] && [ -L "$t" ] && [ "$(readlink "$t")" = "$s" ] && rm -f "$t";',
  // Only ever this job's own scratch dir: <work tree>/.worktrees/@scratch/<job id>, or the layout before's.
  `case $s in */${LAYOUT.scratch}/"$id") w=\${s%/${LAYOUT.scratch}/*};; */${LAYOUT.oldScratch}/"$id") w=\${s%/${LAYOUT.oldScratch}/*};; *) printf "%s\\n" hopper-reaped; exit 0;; esac;`,
  `n=$w/${LAYOUT.scratch}/$id; o=$w/${LAYOUT.oldScratch}/$id;`,
  // The job's credentials (issue #441) go whatever else is kept: they are the hopper's, not the job's work.
  'rm -rf "$n/credentials" "$o/credentials";',
  // Removes $1, a dir of the job's: a read-only dir in it (a Go module cache, issue #1452), or one its owner cannot read (an
  // overlay work dir, issue #2490), made readable, writable and searchable first when a plain remove left it.
  'gone() { [ -e "$1" ] && [ ! -L "$1" ] || return 0; rm -rf "$1" 2>/dev/null; [ -e "$1" ] || return 0; chmod -R u+rwX "$1" 2>/dev/null; rm -rf "$1" 2>/dev/null; };',
  'dirs() { for d in "$n" "$o"; do [ -d "$d" ] && [ ! -L "$d" ] && printf "%s\\n" "$d"; done; };',
  `trees() { for t in "$w"/${LAYOUT.worktrees}/*/"$id" "$w"/${LAYOUT.oldWorktrees}/*-"$id"; do case $t in "$w"/${LAYOUT.worktrees}/@*) continue;; esac; [ -d "$t" ] && [ ! -L "$t" ] && printf "%s\\n" "$t"; done; };`,
  'repos() { { dirs | while IFS= read -r d; do find "$d" -name node_modules -prune -o -name .git -print -prune; done; trees | while IFS= read -r t; do [ -e "$t/.git" ] && printf "%s\\n" "$t/.git"; done; } 2>/dev/null; };',
  ...UNPUSHED_SH,
  // The commits of a clean checkout $1 that hold work no remote has (issue #2087): a worktree's HEAD, a clone's HEAD and
  // branches. The hopper reads a checkout whose every such commit it pushed for the job as pushed: the push says so, though
  // the checkout's remote branches may not. A checkout with a change names none.
  'tips() { td=$1; tr="HEAD --branches"; [ -f "$td/.git" ] && tr=HEAD; ts=$(git -C "$td" status --porcelain 2>/dev/null) || return 0;',
  '  [ -z "$(printf "%s\\n" "$ts" | grep -vx "?? node_modules")" ] || return 0;',
  '  for tu in $(git -C "$td" rev-parse $tr 2>/dev/null); do unpushed "$td" "$tu" && printf "hopper-kept-tip %s %s\\n" "$tu" "$td"; done; };',
  'kept=; [ "$k" = discard ] || kept=$(repos | while IFS= read -r g; do',
  '  d=${g%/.git}; held "$d" && { printf "hopper-kept %s\\n" "$d"; tips "$d"; };',
  'done);',
  // What the job pushed (issue #630): a remote branch its HEAD holds that the default branch does not.
  'pushed=$(repos | while IFS= read -r g; do',
  '  d=${g%/.git}; b=$(git -C "$d" rev-parse -q --verify refs/remotes/origin/HEAD 2>/dev/null) || continue;',
  '  [ -n "$(git -C "$d" for-each-ref --count=1 --merged HEAD --no-merged "$b" refs/remotes 2>/dev/null)" ] && printf "hopper-pushed %s\\n" "$d";',
  'done);',
  '[ -n "$pushed" ] && printf "%s\\n" "$pushed";',
  'if [ -n "$kept" ]; then printf "%s\\n" "$kept"; elif [ "$k" != keep ]; then',
  '  repos | while IFS= read -r g; do',
  '    [ -f "$g" ] || continue; d=${g%/.git};',
  '    [ -L "$d/node_modules" ] && rm -f "$d/node_modules";',
  // Never --force, but for a discard: it is clean and pushed, so git removes it and its repository keeps no entry.
  '    f=; [ "$k" = discard ] && f="--force --force";',
  '    c=$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && git --git-dir="$c" worktree remove $f "$d" 2>/dev/null;',
  '  done;',
  '  trees | while IFS= read -r t; do gone "$t"; rmdir "${t%/*}" 2>/dev/null; done;',
  '  gone "$n"; gone "$o";',
  // What is still there (issue #1452) is named: the sweep then never says it removed it.
  '  { dirs; trees; } | sed "s/^/hopper-left /";',
  'fi;',
  // The layout before issue #1188, once it holds no job's scratch dir or worktree: its scratch area (with the shared
  // dependencies and repository mirrors only its jobs used) and its worktrees dir go. Then git forgets every worktree
  // that is gone, in the work tree's repository and in its workspace's checkouts.
  'if [ "$k" != keep ]; then',
  `  x=$w/${LAYOUT.oldScratch}; y=$w/${LAYOUT.oldWorktrees};`,
  '  if [ -z "$(ls -A "$x" 2>/dev/null | grep -vx -e .gitignore -e deps -e repos)" ] && [ -z "$(ls -A "$y" 2>/dev/null | grep -vx .gitignore)" ]; then',
  '    [ -d "$x" ] && [ ! -L "$x" ] && rm -rf "$x"; [ -d "$y" ] && [ ! -L "$y" ] && rm -rf "$y";',
  '  fi;',
  '  for g in "$w/.git" "$w"/workspace/*/.git; do [ -d "$g" ] && git --git-dir="$g" worktree prune 2>/dev/null; done;',
  'fi;',
  'printf "%s\\n" hopper-reaped',
].map((l) => l.trim()).join(' ');

// $@ the work trees whose scratch dirs to list. What it prints, one per line: the jobs with a scope, the
// jobs with a process carrying their id, the jobs with a container or a volume labelled with their id (issue #1120), each
// work tree whose `.worktrees` is there (issue #1120), each scratch dir with its age in seconds, and each job worktree with
// its age (issue #1188), of either layout. And the hopper's own disk use (issue #1120): for each work tree it names, the
// KiB its `.worktrees` holds, what the layout before left, and each repository checkout in its workspace
// (`workspace/<name>` with a `.git`, part 5): one `du -skx` per work tree, so a link, such as a worktree's node_modules,
// counts as a link, and one in the workspace is not measured. Only where `timeout` is: the measure is cut off at 20 s, so
// a slow disk never holds the survey up; a place not measured by then says nothing.
const SURVEY_SCRIPT = [
  'if command -v systemctl >/dev/null 2>&1; then',
  '  systemctl --user list-units --type=scope --plain --no-legend "hopper-job-*" 2>/dev/null | sed -n "s/^hopper-job-\\([^ ]*\\)\\.scope .*/hopper-scope \\1/p";',
  'fi;',
  'if [ -r /proc/self/environ ]; then',
  '  for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" 2>/dev/null < "$f" | sed -n "s/^HOPPER_JOB_ID=//p"; done | sort -u | sed "s/^/hopper-proc /";',
  'fi;',
  'now=$(date +%s); to=; command -v timeout >/dev/null 2>&1 && to="timeout 20";',
  'for rt in docker podman; do command -v "$rt" >/dev/null 2>&1 || continue;',
  `  c=$($to "$rt" ps -aq --filter label=${JOB_LABEL} 2>/dev/null); [ -n "$c" ] && $to "$rt" inspect --format '{{index .Config.Labels "${JOB_LABEL}"}}' $c 2>/dev/null | sed "s/^/hopper-container /";`,
  `  v=$($to "$rt" volume ls -q --filter label=${JOB_LABEL} 2>/dev/null); [ -n "$v" ] && $to "$rt" volume inspect --format '{{index .Labels "${JOB_LABEL}"}}' $v 2>/dev/null | sed "s/^/hopper-container /";`,
  'done;',
  // Each job's own container runtime left (issue #1295, job-runtime.ts), as a job with a container left.
  SURVEY_RUNTIME_SH,
  `measure() { set --; for p in "$r/${LAYOUT.worktrees}" "$r/${LAYOUT.oldScratch}" "$r"/workspace/*; do`,
  `    [ -d "$p" ] && [ ! -L "$p" ] || continue; case $p in "$r/${LAYOUT.worktrees}"|"$r/${LAYOUT.oldScratch}"|"$r/${LAYOUT.oldWorktrees}") ;; *) [ -e "$p/.git" ] || continue;; esac;`,
  '    set -- "$@" "$p";',
  '  done; [ $# -gt 0 ] || return 0;',
  `  $to du -skx "$@" 2>/dev/null | awk -F '\t' '$1 ~ /^[0-9]+$/ { k = $1; sub(/^[^\t]*\t/, ""); print "hopper-du " k " " $0 }'; };`,
  `for r in "$@"; do if [ -d "$r/${LAYOUT.worktrees}" ] || [ -d "$r/${LAYOUT.oldScratch}" ]; then printf "hopper-root %s\\n" "$r";`,
  '  [ -n "$to" ] && measure;',
  `fi; for d in "$r"/${LAYOUT.scratch}/* "$r"/${LAYOUT.oldScratch}/*; do`,
  '  [ -d "$d" ] && [ ! -L "$d" ] || continue;',
  '  m=$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d" 2>/dev/null) || continue;',
  '  printf "hopper-dir %s %s\\n" "$((now - m))" "$d";',
  `done; for d in "$r"/${LAYOUT.worktrees}/*/* "$r"/${LAYOUT.oldWorktrees}/*; do`,
  `  case $d in "$r"/${LAYOUT.worktrees}/@*) continue;; esac; [ -d "$d" ] && [ ! -L "$d" ] || continue;`,
  '  m=$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d" 2>/dev/null) || continue;',
  '  printf "hopper-tree %s %s\\n" "$((now - m))" "$d";',
  'done; done;',
  'printf "%s\\n" hopper-surveyed',
].map((l) => l.trim()).join(' ');

/**
 * The argv that reaps a job on the machine it runs on: its scope and processes stopped, its scratch dir (when given)
 * removed unless it holds work — or kept whatever it holds (`keep`, issue #630), or removed whatever it holds
 * (`discard`, issue #1010).
 */
export const reapArgv = (jobId: string, scratch = '', keep = false, discard = false): string[] =>
  ['env', '-u', 'HOPPER_JOB_ID', 'sh', '-c', REAP_SCRIPT, 'sh', jobId, scratch, ...(keep ? ['keep'] : discard ? ['discard'] : [])];

/** The argv that lists what jobs left on the machine: scopes, processes, and the scratch dirs under `roots`. */
export const surveyArgv = (roots: readonly string[]): string[] => ['env', '-u', 'HOPPER_JOB_ID', 'sh', '-c', SURVEY_SCRIPT, 'sh', ...roots];

/** One container the reap removed, as it said it before (issue #975): its name, image, and when it started and stopped. */
export interface ContainerDetails { id: string; name: string; image: string; startedAt?: string; stoppedAt?: string }

/** A time the runtime gave as JSON, as an ISO time; undefined for a zero time (Go's year 1: it never came) or no time. */
function timeOf(json: string | undefined): string | undefined {
  try {
    const t = typeof json === 'string' ? JSON.parse(json) as unknown : undefined;
    const ms = typeof t === 'string' ? Date.parse(t) : NaN;
    return Number.isFinite(ms) && new Date(ms).getUTCFullYear() > 1 ? new Date(ms).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

/** A details line of the reap's, `<id> <name> <image> <started> <stopped>`; undefined when it is not one. */
function detailsOf(line: string): ContainerDetails | undefined {
  const [id, name, image, started, stopped, ...rest] = line.split(' ');
  if (!id || !name || !image || rest.length) return undefined;
  const startedAt = timeOf(started);
  const stoppedAt = startedAt ? timeOf(stopped) : undefined;
  return { id, name: name.replace(/^\//, ''), image, ...(startedAt ? { startedAt } : {}), ...(stoppedAt ? { stoppedAt } : {}) };
}

/**
 * What a finished reap said: the repositories it kept, those whose branch was pushed (issue #630), the dirs of the job it
 * could not remove (issue #1452), and the containers and volumes of the job it removed (issue #1120), with what it said of
 * each container (issue #975; none from a client older than that). Undefined when it did not finish.
 */
export function readReap(stdout: string): { kept: string[]; tips?: Record<string, string[]>; pushed?: string[]; left?: string[]; removed?: { containers: string[]; volumes: string[]; details?: ContainerDetails[] }; used?: ResourceUse } | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(REAP_DONE)) return undefined;
  const named = (prefix: string): string[] => [...new Set(lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)))];
  const pushed = named('hopper-pushed ');
  const containers = named('hopper-removed-container ');
  const volumes = named('hopper-removed-volume ');
  const left = named('hopper-left ');
  const kept = named('hopper-kept ');
  const tips: Record<string, string[]> = {};
  for (const l of lines) {
    const t = /^hopper-kept-tip ([0-9a-f]{40,64}) (\/.*)$/.exec(l);
    if (t && kept.includes(t[2]!) && !tips[t[2]!]?.includes(t[1]!)) (tips[t[2]!] ??= []).push(t[1]!);
  }
  const details = [...new Map(named(DETAILS_MARK).map(detailsOf).filter((d) => d !== undefined && containers.includes(d.id)).map((d) => [d!.id, d!])).values()];
  return {
    kept, ...(Object.keys(tips).length ? { tips } : {}), ...(pushed.length ? { pushed } : {}), ...(left.length ? { left } : {}),
    ...(containers.length || volumes.length ? { removed: { containers, volumes, ...(details.length ? { details } : {}) } } : {}),
    ...usedOf(lines),
  };
}

/** What a job's scope used (issue #2498), as `job.resources_used` records it: each field absent where its cgroup had none. */
export interface ResourceUse { memoryPeakBytes?: number; cpuSeconds?: number; oomKills?: number }

/** The reap's `hopper-used <peak bytes> <CPU µs> <OOM kills>` line, each `-` when unread; nothing when no field was read. */
function usedOf(lines: readonly string[]): { used?: ResourceUse } {
  const m = lines.map((l) => /^hopper-used (\S+) (\S+) (\S+)$/.exec(l)).find((x) => x !== null);
  const n = (v: string | undefined): number | undefined => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const peak = n(m?.[1]), usec = n(m?.[2]), oom = n(m?.[3]);
  const used: ResourceUse = { ...(peak !== undefined ? { memoryPeakBytes: peak } : {}), ...(usec !== undefined ? { cpuSeconds: usec / 1e6 } : {}), ...(oom !== undefined ? { oomKills: oom } : {}) };
  return Object.keys(used).length ? { used } : {};
}

/** One scratch dir the survey found: its job, path and age. */
export interface SurveyedDir { jobId: string; path: string; ageMs: number }
/** One job worktree the survey found (issue #1188): its path and age; its job is known by its name. */
export interface SurveyedTree { path: string; ageMs: number }
/**
 * One place of the hopper's in a work tree the survey measured (issue #1120): its `.worktrees`, what the layout before
 * left, or a repository checkout in its workspace (part 5).
 */
export interface SurveyedUsage { path: string; bytes: number }
/** What a finished survey found. Undefined when it did not finish. */
export interface Survey { scopes: string[]; processes: string[]; scratch: SurveyedDir[]; trees?: SurveyedTree[]; roots?: string[]; usage?: SurveyedUsage[]; containers?: string[] }

export function readSurvey(stdout: string): Survey | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(SURVEY_DONE)) return undefined;
  const ids = (prefix: string): string[] => [...new Set(lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)).filter(isJobId))];
  const scratch: SurveyedDir[] = [];
  const trees: SurveyedTree[] = [];
  const roots: string[] = [];
  const usage: SurveyedUsage[] = [];
  for (const l of lines) {
    const u = /^hopper-du (\d+) (\/.*\/(?:\.worktrees|\.hopper-scratch|workspace\/[^/]+))$/.exec(l);
    if (u) usage.push({ path: u[2]!, bytes: Number(u[1]) * 1024 });
    const r = /^hopper-root (\/.*)$/.exec(l);
    if (r) roots.push(r[1]!);
    const m = /^hopper-dir (\d+) (\/.*\/(?:\.worktrees\/@scratch|\.hopper-scratch)\/([^/]+))$/.exec(l);
    if (m && isJobId(m[3])) scratch.push({ jobId: m[3]!, path: m[2]!, ageMs: Number(m[1]) * 1000 });
    const t = /^hopper-tree (\d+) (\/.*\/(?:\.worktrees\/[^/@][^/]*\/[^/]+|workspace\/worktrees\/[^/]+))$/.exec(l);
    if (t) trees.push({ path: t[2]!, ageMs: Number(t[1]) * 1000 });
  }
  return { scopes: ids('hopper-scope '), processes: ids('hopper-proc '), scratch, trees, roots, usage, containers: ids('hopper-container ') };
}

/** A scratch dir a reap may name: absolute, one line, and the job's own, of either layout. */
export const isScratchOf = (path: unknown, jobId: string): path is string =>
  typeof path === 'string' && path.startsWith('/') && !/[\n\0]/.test(path)
  && (path.endsWith(`/${LAYOUT.scratch}/${jobId}`) || path.endsWith(`/${LAYOUT.oldScratch}/${jobId}`));

/** A work tree a survey may list under: absolute and one line. */
const isRoot = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && !/[\n\0]/.test(path) && path.length <= 4096;

/** The argv a `/reap` or `/survey` body asks for; else why it is refused. */
export function scriptArgvOf(path: '/reap' | '/survey', body: unknown): string[] | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { jobId?: unknown; scratch?: unknown; roots?: unknown; keep?: unknown; discard?: unknown };
  if (path === '/survey') {
    if (!Array.isArray(b.roots) || b.roots.length > 256 || !b.roots.every(isRoot)) return 'roots must be at most 256 absolute paths';
    return surveyArgv(b.roots);
  }
  if (!isJobId(b.jobId)) return 'jobId must be a job id';
  if (b.scratch !== undefined && !isScratchOf(b.scratch, b.jobId)) return 'scratch must be the job\'s own scratch dir';
  if (b.keep !== undefined && typeof b.keep !== 'boolean') return 'keep must be true or false';
  if (b.discard !== undefined && typeof b.discard !== 'boolean') return 'discard must be true or false';
  if (b.keep === true && b.discard === true) return 'keep and discard cannot both be true';
  return reapArgv(b.jobId, b.scratch, b.keep === true, b.discard === true);
}
