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

/**
 * How long a survey may take (issue #2494): each work tree's measure, the caches' two and each container runtime's
 * `system df`, each cut off at 20 s.
 */
export const SURVEY_TIMEOUT_MS = 120000;

export const REAP_DONE = 'hopper-reaped';
export const SURVEY_DONE = 'hopper-surveyed';

/**
 * Where a job's files are in its work tree (issue #1188, src/domain/job-layout.ts, which test/domain/job-layout.test.ts
 * holds these to): `.worktrees/<name>/<job id>` its worktrees, `.worktrees/@scratch/<job id>` its scratch dir. The layout
 * before (`.hopper-scratch/<job id>`, `workspace/worktrees/<name>-<job id>`) is only found, to be removed.
 */
/** How long an entry of no job in the scratch area stays unchanged before a reap there removes it (issue #2715). */
export const LOOSE_GRACE_DAYS = 7;
/** A job id as the hopper makes one (a UUID, `randomUUID`), as a shell glob. */
const UUID_GLOB = [8, 4, 4, 4, 12].map((n) => '[0-9a-f]'.repeat(n)).join('-');

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
  '  ! hs=$(git -C "$hd" status --porcelain 2>/dev/null) || [ -n "$(printf "%s\\n" "$hs" | grep -vx "?? node_modules")" ] || ! hu=$(git -C "$hd" log --oneline -1 $hr --not --remotes 2>/dev/null) || { [ -n "$hu" ] && unpushed "$hd" "$hr"; } || stashed "$hd"; };',
  // Whether the checkout $1 holds a stash (issue #2494): a clone any entry of its own, a worktree (.git a file, the stash
  // its repository's) one made on its own HEAD. Another worktree at the same commit keeps it too: never one too few.
  'stashed() { [ -f "$1/.git" ] || { [ -n "$(git -C "$1" stash list 2>/dev/null)" ]; return; };',
  '  sb=$(git -C "$1" rev-parse -q --verify HEAD 2>/dev/null) || return 1;',
  '  git -C "$1" log -g --format=%P refs/stash 2>/dev/null | cut -d " " -f 1 | grep -qx "$sb"; };',
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
  // The job's scratch dir, when that leaves it: removed in the user's own user namespace (issue #2685), as files of the job's
  // (a test database's data dir, a storage's layers) belong to its sub-UIDs, whether the job's runtime dir is there or not.
  // Under no-new-privileges (the client's service) podman cannot make that namespace, so it runs in the user's systemd.
  'gone() { [ -e "$1" ] && [ ! -L "$1" ] || return 0; rm -rf "$1" 2>/dev/null; [ -e "$1" ] || return 0; chmod -R u+rwX "$1" 2>/dev/null; rm -rf "$1" 2>/dev/null;',
  '  [ -e "$1" ] && { [ "$1" = "$n" ] || [ "$1" = "$o" ]; } && pp=$(command -v podman 2>/dev/null) || return 0; nt=; command -v timeout >/dev/null 2>&1 && nt="timeout 300";',
  '  $nt env -u CONTAINER_HOST -u CONTAINER_CONNECTION ${h:+"XDG_RUNTIME_DIR=$h"} "$pp" unshare rm -rf -- "$1" >/dev/null 2>&1; [ -e "$1" ] || return 0;',
  '  grep -q "^NoNewPrivs:[[:space:]]*1" /proc/self/status 2>/dev/null && command -v systemd-run >/dev/null 2>&1'
    + ' && $nt systemd-run --user --quiet --wait --collect env -u CONTAINER_HOST -u CONTAINER_CONNECTION "$pp" unshare rm -rf -- "$1" >/dev/null 2>&1; };',
  // Why $1 is still there after gone() (issue #2715): a file system mounted in it, a process that runs in it, files of
  // another user (the job's user namespace) in it, else a permission the hopper's user does not have.
  // The kernel names a dir by its path with no link in it: $1 resolved, as `lp`.
  'whyleft() { lp=$(cd "$1" 2>/dev/null && pwd -P) || lp=$1;',
  '  if awk -v p="$lp" \'$5 == p || index($5, p "/") == 1 { f = 1 } END { exit !f }\' /proc/self/mountinfo 2>/dev/null; then echo mount;',
  '  elif find /proc -mindepth 2 -maxdepth 2 -path "/proc/[0-9]*" \\( -name cwd -o -name exe -o -name root \\) \\( -lname "$lp" -o -lname "$lp/*" \\) -print 2>/dev/null | grep -q .; then echo process;',
  '  elif [ -n "$(find "$1" ! -user "$(id -u)" -print 2>/dev/null | head -n 1)" ]; then echo userns; else echo permission; fi; };',
  'dirs() { for d in "$n" "$o"; do [ -d "$d" ] && [ ! -L "$d" ] && printf "%s\\n" "$d"; done; };',
  `trees() { for t in "$w"/${LAYOUT.worktrees}/*/"$id" "$w"/${LAYOUT.oldWorktrees}/*-"$id"; do case $t in "$w"/${LAYOUT.worktrees}/@*) continue;; esac; [ -d "$t" ] && [ ! -L "$t" ] && printf "%s\\n" "$t"; done; };`,
  // The disk the job's scratch dir and worktrees hold (issue #2498 part 4), read before the reap removes or keeps them: one
  // `du -skx` per dir, so a link in it (a worktree's node_modules) counts no more than the link.
  '{ dirs; trees; } | while IFS= read -r d; do $to du -skx "$d" 2>/dev/null; done | awk \'$1 ~ /^[0-9]+$/ { k += $1; n = 1 } END { if (n) print "hopper-disk " k }\';',
  'repos() { { dirs | while IFS= read -r d; do find "$d" -name node_modules -prune -o -name .git -print -prune; done; trees | while IFS= read -r t; do [ -e "$t/.git" ] && printf "%s\\n" "$t/.git"; done; } 2>/dev/null; };',
  ...UNPUSHED_SH,
  // The commits of a clean checkout $1 that hold work no remote has (issue #2087): a worktree's HEAD, a clone's HEAD and
  // branches. The hopper reads a checkout whose every such commit it pushed for the job as pushed: the push says so, though
  // the checkout's remote branches may not. A checkout with a change or a stash (issue #2494) names none.
  'tips() { td=$1; tr="HEAD --branches"; [ -f "$td/.git" ] && tr=HEAD; ts=$(git -C "$td" status --porcelain 2>/dev/null) || return 0;',
  '  [ -z "$(printf "%s\\n" "$ts" | grep -vx "?? node_modules")" ] || return 0; ! stashed "$td" || return 0;',
  '  for tu in $(git -C "$td" rev-parse $tr 2>/dev/null); do unpushed "$td" "$tu" && printf "hopper-kept-tip %s %s\\n" "$tu" "$td"; done; };',
  // Why the reap keeps the checkout $1 (issue #2494): each of a change, a stash and commits no remote has that it holds.
  'why() { wd=$1; wr="HEAD --branches"; [ -f "$wd/.git" ] && wr=HEAD;',
  '  ws=$(git -C "$wd" status --porcelain 2>/dev/null) && [ -n "$(printf "%s\\n" "$ws" | grep -vx "?? node_modules")" ] && printf "hopper-kept-why dirty %s\\n" "$wd";',
  '  stashed "$wd" && printf "hopper-kept-why stash %s\\n" "$wd";',
  '  wu=$(git -C "$wd" log --oneline -1 $wr --not --remotes 2>/dev/null) && [ -n "$wu" ] && unpushed "$wd" "$wr" && printf "hopper-kept-why unpushed %s\\n" "$wd"; };',
  'kept=; [ "$k" = discard ] || kept=$(repos | while IFS= read -r g; do',
  '  d=${g%/.git}; held "$d" && { printf "hopper-kept %s\\n" "$d"; why "$d"; tips "$d"; };',
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
  '  { dirs; trees; } | while IFS= read -r d; do printf "hopper-left %s\\n" "$d"; printf "hopper-left-why %s %s\\n" "$(whyleft "$d")" "$d"; done;',
  'fi;',
  // The layout before issue #1188, once it holds no job's scratch dir or worktree: its scratch area (with the shared
  // dependencies and repository mirrors only its jobs used) and its worktrees dir go. Then git forgets every worktree
  // that is gone, in the work tree's repository and in its workspace's checkouts.
  'if [ "$k" != keep ]; then',
  `  x=$w/${LAYOUT.oldScratch}; y=$w/${LAYOUT.oldWorktrees};`,
  '  if [ -z "$(ls -A "$x" 2>/dev/null | grep -vx -e .gitignore -e deps -e repos)" ] && [ -z "$(ls -A "$y" 2>/dev/null | grep -vx .gitignore)" ]; then',
  '    [ -d "$x" ] && [ ! -L "$x" ] && rm -rf "$x"; [ -d "$y" ] && [ ! -L "$y" ] && rm -rf "$y";',
  '  fi;',
  // What else is in the scratch area (issue #2715): a file or a dir of no job — not named as a job's (a UUID), the jobs' own
  // judged by the sweep —, gone once nothing in it changed for LOOSE_GRACE_DAYS. Each one removed is named.
  `  x=$w/${LAYOUT.scratch}; [ -d "$x" ] && [ ! -L "$x" ] && for p in "$x"/* "$x"/.[!.]* "$x"/..?*; do { [ -e "$p" ] || [ -L "$p" ]; } && [ "$p" != "$n" ] || continue;`,
  `    case \${p##*/} in ${UUID_GLOB}|.gitignore) continue;; esac; [ -n "$(find "$p" -mtime -${LOOSE_GRACE_DAYS} -print 2>/dev/null | head -n 1)" ] && continue;`,
  '    if [ -L "$p" ] || [ ! -d "$p" ]; then rm -f "$p"; else gone "$p"; fi; [ -e "$p" ] || [ -L "$p" ] || printf "hopper-loose-removed %s\\n" "$p"; done;',
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
/**
 * The caches the tools keep in a machine's home (issue #2494), by kind, relative to `$HOME`: the survey measures each one
 * there and nothing else of the home. `cache` is `~/.cache` whole, measured apart, so the hopper counts its rest.
 */
export const CACHE_DIRS = [
  ['nuget', '.nuget/packages'], ['gradle', '.gradle/caches'], ['gradle', '.gradle/wrapper/dists'], ['go', 'go/pkg/mod'], ['go', '.cache/go-build'],
  ['npm', '.npm'], ['pnpm', '.local/share/pnpm/store'], ['yarn', '.cache/yarn'], ['yarn', '.yarn/berry/cache'], ['pip', '.cache/pip'],
] as const;
export type CacheDirKind = typeof CACHE_DIRS[number][0] | 'cache';

// `du -skx` of the dirs of $1 (`cache` or `dirs`) under the home that are there and no link, as `hopper-cache <KiB> <path>`.
const CACHES_SH = [
  `cachedu() { set --; for c in ${CACHE_DIRS.map(([, rel]) => rel).join(' ')}; do p=$HOME/$c; [ -d "$p" ] && [ ! -L "$p" ] && set -- "$@" "$p"; done;`,
  '  [ $# -gt 0 ] && $to du -skx "$@" 2>/dev/null | awk -F \'\t\' \'$1 ~ /^[0-9]+$/ { k = $1; sub(/^[^\t]*\t/, ""); print "hopper-cache " k " " $0 }\';',
  '  p=$HOME/.cache; [ -d "$p" ] && [ ! -L "$p" ] && $to du -skx "$p" 2>/dev/null | awk -F \'\t\' \'$1 ~ /^[0-9]+$/ { k = $1; sub(/^[^\t]*\t/, ""); print "hopper-cache " k " " $0 }\'; };',
  // Each runtime's storage as its `system df` says it, `hopper-df|<runtime>|<type>|<size>|<reclaimable>`.
  'storage() { for rt in docker podman; do command -v "$rt" >/dev/null 2>&1 || continue;',
  '  $to "$rt" system df --format "{{.Type}}|{{.Size}}|{{.Reclaimable}}" 2>/dev/null | sed "s/^/hopper-df|$rt|/"; done; };',
];

const SURVEY_SCRIPT = [
  'if command -v systemctl >/dev/null 2>&1; then',
  '  systemctl --user list-units --type=scope --plain --no-legend "hopper-job-*" 2>/dev/null | sed -n "s/^hopper-job-\\([^ ]*\\)\\.scope .*/hopper-scope \\1/p";',
  'fi;',
  'if [ -r /proc/self/environ ]; then',
  '  cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n" | sed -n "s/^HOPPER_JOB_ID=//p" | sort -u | sed "s/^/hopper-proc /";',
  'fi;',
  'now=$(date +%s); to=; command -v timeout >/dev/null 2>&1 && to="timeout 20";',
  // GNU stat (Linux, MSYS) or BSD stat (macOS): `<mtime> <path>` for each path.
  'if stat -c %Y / >/dev/null 2>&1; then mtimes() { stat -c "%Y %n" "$@"; }; else mtimes() { stat -f "%m %N" "$@"; }; fi;',
  'for rt in docker podman; do command -v "$rt" >/dev/null 2>&1 || continue;',
  `  c=$($to "$rt" ps -aq --filter label=${JOB_LABEL} 2>/dev/null); [ -n "$c" ] && $to "$rt" inspect --format '{{index .Config.Labels "${JOB_LABEL}"}}' $c 2>/dev/null | sed "s/^/hopper-container /";`,
  `  v=$($to "$rt" volume ls -q --filter label=${JOB_LABEL} 2>/dev/null); [ -n "$v" ] && $to "$rt" volume inspect --format '{{index .Labels "${JOB_LABEL}"}}' $v 2>/dev/null | sed "s/^/hopper-container /";`,
  // Each exited container (issue #2494), for the storage prune: `hopper-exited|<runtime>|<id>|<stopped at>|<label keys>`.
  `  x=$($to "$rt" ps -aq --filter status=exited 2>/dev/null); [ -n "$x" ] && $to "$rt" container inspect --format '{{.Id}}|{{.State.FinishedAt}}|{{range $k, $v := .Config.Labels}}{{$k}} {{end}}' $x 2>/dev/null | sed "s/^/hopper-exited|$rt|/";`,
  'done;',
  // Each job's own container runtime left (issue #1295, job-runtime.ts), as a job with a container left.
  SURVEY_RUNTIME_SH,
  `measure() { set --; for p in "$r/${LAYOUT.worktrees}" "$r/${LAYOUT.oldScratch}" "$r"/workspace/*; do`,
  `    [ -d "$p" ] && [ ! -L "$p" ] || continue; case $p in "$r/${LAYOUT.worktrees}"|"$r/${LAYOUT.oldScratch}"|"$r/${LAYOUT.oldWorktrees}") ;; *) [ -e "$p/.git" ] || continue;; esac;`,
  '    set -- "$@" "$p";',
  '  done; [ $# -gt 0 ] || return 0;',
  `  $to du -skx "$@" 2>/dev/null | awk -F '\t' '$1 ~ /^[0-9]+$/ { k = $1; sub(/^[^\t]*\t/, ""); print "hopper-du " k " " $0 }'; };`,
  // Each job's scratch dir and job worktree on its own (issue #2494), `hopper-jobdu <KiB> <path>`; no `@` dir but the scratch area.
  `jobdu() { set --; for d in "$r"/${LAYOUT.worktrees}/*/*; do [ -d "$d" ] && [ ! -L "$d" ] || continue;`,
  `    case $d in "$r"/${LAYOUT.scratch}/*) ;; "$r"/${LAYOUT.worktrees}/@*) continue;; esac; set -- "$@" "$d"; done; [ $# -gt 0 ] || return 0;`,
  `  $to du -skx "$@" 2>/dev/null | awk -F '\t' '$1 ~ /^[0-9]+$/ { k = $1; sub(/^[^\t]*\t/, ""); print "hopper-jobdu " k " " $0 }'; };`,
  // `ages <dir|tree> <paths>`: the dirs of the paths, with their ages, by one `stat` (issue #2490: a start per dir was too
  // slow under MSYS). `for` takes its list once, so each pass shifts its path off and puts a dir back at the end.
  'ages() { k=$1; shift; for d do shift; [ -d "$d" ] && [ ! -L "$d" ] || continue;',
  `  [ "$k" = tree ] && case $d in "$r"/${LAYOUT.worktrees}/@*) continue;; esac; set -- "$@" "$d"; done; [ $# -gt 0 ] || return 0;`,
  `  mtimes "$@" 2>/dev/null | awk -v now="$now" -v k="$k" '$1 ~ /^[0-9]+$/ { m = $1; sub(/^[^ ]* /, ""); print "hopper-" k " " (now - m) " " $0 }'; };`,
  `for r in "$@"; do if [ -d "$r/${LAYOUT.worktrees}" ] || [ -d "$r/${LAYOUT.oldScratch}" ]; then printf "hopper-root %s\\n" "$r";`,
  '  [ -n "$to" ] && { measure; jobdu; };',
  `fi; ages dir "$r"/${LAYOUT.scratch}/* "$r"/${LAYOUT.oldScratch}/*; ages tree "$r"/${LAYOUT.worktrees}/*/* "$r"/${LAYOUT.oldWorktrees}/*;`,
  'done;',
  // The machine's caches and container storage (issue #2494), once per survey, only where `timeout` cuts each call off.
  ...CACHES_SH,
  'if [ -n "$to" ] && [ -n "$HOME" ] && [ -d "$HOME" ]; then cachedu; fi; [ -n "$to" ] && storage;',
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

/** Why the reap kept a checkout (issue #2494): a change not committed, a stash, commits no remote has. */
export const KEPT_REASONS = ['dirty', 'stash', 'unpushed'] as const;
/** Why a dir the reap set out to remove is still there (issue #2715). */
export const LEFT_CAUSES = ['mount', 'process', 'userns', 'permission'] as const;
export type LeftCause = typeof LEFT_CAUSES[number];
export type KeptReason = typeof KEPT_REASONS[number];

/**
 * What a finished reap said: the repositories it kept, those whose branch was pushed (issue #630), the dirs of the job it
 * could not remove (issue #1452), why it kept each it kept (`reasons`, issue #2494; none from a client older than that), and the containers and volumes of the job it removed (issue #1120), with what it said of
 * each container (issue #975; none from a client older than that). Undefined when it did not finish.
 */
export function readReap(stdout: string): { kept: string[]; tips?: Record<string, string[]>; reasons?: Record<string, KeptReason[]>; pushed?: string[]; left?: string[]; leftWhy?: Record<string, LeftCause>; loose?: string[]; removed?: { containers: string[]; volumes: string[]; details?: ContainerDetails[] }; used?: ResourceUse } | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(REAP_DONE)) return undefined;
  const named = (prefix: string): string[] => [...new Set(lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)))];
  const pushed = named('hopper-pushed ');
  const containers = named('hopper-removed-container ');
  const volumes = named('hopper-removed-volume ');
  const left = named('hopper-left '), loose = named('hopper-loose-removed ');
  const kept = named('hopper-kept ');
  const tips: Record<string, string[]> = {};
  for (const l of lines) {
    const t = /^hopper-kept-tip ([0-9a-f]{40,64}) (\/.*)$/.exec(l);
    if (t && kept.includes(t[2]!) && !tips[t[2]!]?.includes(t[1]!)) (tips[t[2]!] ??= []).push(t[1]!);
  }
  const reasons: Record<string, KeptReason[]> = {};
  for (const l of lines) {
    const w = /^hopper-kept-why (\S+) (\/.*)$/.exec(l);
    if (w && kept.includes(w[2]!) && (KEPT_REASONS as readonly string[]).includes(w[1]!) && !reasons[w[2]!]?.includes(w[1] as KeptReason)) (reasons[w[2]!] ??= []).push(w[1] as KeptReason);
  }
  const leftWhy: Record<string, LeftCause> = {};
  for (const l of lines) {
    const w = /^hopper-left-why (\S+) (\/.*)$/.exec(l);
    if (w && left.includes(w[2]!) && (LEFT_CAUSES as readonly string[]).includes(w[1]!)) leftWhy[w[2]!] = w[1] as LeftCause;
  }
  const details = [...new Map(named(DETAILS_MARK).map(detailsOf).filter((d) => d !== undefined && containers.includes(d.id)).map((d) => [d!.id, d!])).values()];
  return {
    kept, ...(Object.keys(tips).length ? { tips } : {}), ...(Object.keys(reasons).length ? { reasons } : {}), ...(pushed.length ? { pushed } : {}), ...(left.length ? { left } : {}), ...(Object.keys(leftWhy).length ? { leftWhy } : {}), ...(loose.length ? { loose } : {}),
    ...(containers.length || volumes.length ? { removed: { containers, volumes, ...(details.length ? { details } : {}) } } : {}),
    ...usedOf(lines),
  };
}

/**
 * What a job used (issue #2498), as `job.resources_used` records it: its scope's, each field absent where its cgroup had
 * none, and the disk its scratch dir and worktrees held (part 4), absent where it had neither.
 */
export interface ResourceUse { memoryPeakBytes?: number; cpuSeconds?: number; oomKills?: number; diskBytes?: number }

/**
 * The reap's `hopper-used <peak bytes> <CPU µs> <OOM kills>` line, each `-` when unread, and its `hopper-disk <KiB>` line;
 * nothing when no field was read.
 */
function usedOf(lines: readonly string[]): { used?: ResourceUse } {
  const m = lines.map((l) => /^hopper-used (\S+) (\S+) (\S+)$/.exec(l)).find((x) => x !== null);
  const n = (v: string | undefined): number | undefined => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const peak = n(m?.[1]), usec = n(m?.[2]), oom = n(m?.[3]);
  const kib = n(lines.map((l) => /^hopper-disk (\d+)$/.exec(l)?.[1]).find((x) => x !== undefined));
  const used: ResourceUse = {
    ...(peak !== undefined ? { memoryPeakBytes: peak } : {}), ...(usec !== undefined ? { cpuSeconds: usec / 1e6 } : {}), ...(oom !== undefined ? { oomKills: oom } : {}),
    ...(kib !== undefined ? { diskBytes: kib * 1024 } : {}),
  };
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
/** One cache place the survey measured (issue #2494): its kind by where it is, see CACHE_DIRS. */
export interface SurveyedCache { kind: CacheDirKind; path: string; bytes: number }
/** What one container runtime's storage of one kind takes, as its `system df` said (issue #2494). */
export interface SurveyedStorage { runtime: 'docker' | 'podman'; kind: 'images' | 'containers' | 'volumes' | 'build-cache'; bytes: number; reclaimableBytes: number }
/** One exited container the survey found (issue #2494), for the storage prune: its full id, when it stopped as the runtime said, its label keys. */
export interface SurveyedExited { runtime: 'docker' | 'podman'; id: string; finishedAt: string; labels: string[] }
/** One job's scratch dir or job worktree the survey measured on its own (issue #2494). */
export interface SurveyedJobDisk { jobId: string; kind: 'scratch' | 'tree'; path: string; bytes: number }
/** What a finished survey found. Undefined when it did not finish. */
export interface Survey { scopes: string[]; processes: string[]; scratch: SurveyedDir[]; trees?: SurveyedTree[]; roots?: string[]; usage?: SurveyedUsage[]; containers?: string[]; caches?: SurveyedCache[]; storage?: SurveyedStorage[]; exited?: SurveyedExited[]; jobs?: SurveyedJobDisk[] }

const STORAGE_KINDS: Record<string, SurveyedStorage['kind']> = { 'Images': 'images', 'Containers': 'containers', 'Local Volumes': 'volumes', 'Build Cache': 'build-cache' };
const UNITS: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };
/** A size as a runtime prints it (`2.5GB`, `512kB`, `0B`, decimal units), in bytes; undefined when it is not one. */
function sizeOf(text: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([kKMGTP]?)B\b/.exec(text?.trim() ?? '');
  return m ? Math.round(Number(m[1]) * UNITS[m[2]!]!) : undefined;
}
/** The kind of a cache place by its path, see CACHE_DIRS; undefined when it is none of them. */
function cacheKindOf(path: string): CacheDirKind | undefined {
  if (path.endsWith('/.cache')) return 'cache';
  return CACHE_DIRS.find(([, rel]) => path.endsWith(`/${rel}`))?.[0];
}

export function readSurvey(stdout: string): Survey | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(SURVEY_DONE)) return undefined;
  const ids = (prefix: string): string[] => [...new Set(lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)).filter(isJobId))];
  const scratch: SurveyedDir[] = [];
  const trees: SurveyedTree[] = [];
  const roots: string[] = [];
  const usage: SurveyedUsage[] = [];
  const caches: SurveyedCache[] = [];
  const storage: SurveyedStorage[] = [];
  const exited: SurveyedExited[] = [];
  const jobs: SurveyedJobDisk[] = [];
  for (const l of lines) {
    const j = /^hopper-jobdu (\d+) (\/.*\/\.worktrees\/(@scratch|[^/@][^/]*)\/([^/]+))$/.exec(l);
    if (j && isJobId(j[4])) jobs.push({ jobId: j[4]!, kind: j[3] === '@scratch' ? 'scratch' : 'tree', path: j[2]!, bytes: Number(j[1]) * 1024 });
    const ca = /^hopper-cache (\d+) (\/.*)$/.exec(l);
    const kind = ca ? cacheKindOf(ca[2]!) : undefined;
    if (ca && kind) caches.push({ kind, path: ca[2]!, bytes: Number(ca[1]) * 1024 });
    const [mark, runtime, type, size, reclaimable] = l.split('|');
    const bytes = sizeOf(size);
    if (mark === 'hopper-df' && (runtime === 'docker' || runtime === 'podman') && type && Object.hasOwn(STORAGE_KINDS, type) && bytes !== undefined) {
      storage.push({ runtime, kind: STORAGE_KINDS[type]!, bytes, reclaimableBytes: sizeOf(reclaimable) ?? 0 });
    }
    if (mark === 'hopper-exited' && (runtime === 'docker' || runtime === 'podman') && type && /^[0-9a-f]{64}$/.test(type) && size) {
      exited.push({ runtime, id: type, finishedAt: size, labels: (reclaimable ?? '').split(' ').filter(Boolean) });
    }
    const u = /^hopper-du (\d+) (\/.*\/(?:\.worktrees|\.hopper-scratch|workspace\/[^/]+))$/.exec(l);
    if (u) usage.push({ path: u[2]!, bytes: Number(u[1]) * 1024 });
    const r = /^hopper-root (\/.*)$/.exec(l);
    if (r) roots.push(r[1]!);
    const m = /^hopper-dir (\d+) (\/.*\/(?:\.worktrees\/@scratch|\.hopper-scratch)\/([^/]+))$/.exec(l);
    if (m && isJobId(m[3])) scratch.push({ jobId: m[3]!, path: m[2]!, ageMs: Number(m[1]) * 1000 });
    const t = /^hopper-tree (\d+) (\/.*\/(?:\.worktrees\/[^/@][^/]*\/[^/]+|workspace\/worktrees\/[^/]+))$/.exec(l);
    if (t) trees.push({ path: t[2]!, ageMs: Number(t[1]) * 1000 });
  }
  return { scopes: ids('hopper-scope '), processes: ids('hopper-proc '), scratch, trees, roots, usage, containers: ids('hopper-container '), caches, storage, ...(exited.length ? { exited } : {}), ...(jobs.length ? { jobs } : {}) };
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
