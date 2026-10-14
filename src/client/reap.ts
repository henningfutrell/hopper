// The reap and the survey (issues #401, #410, #1103, design.md "Work tree" → "The reap"), beside server.ts for its size:
// what runs on a job's machine when the job ends, and what the sweep asks of it: fixed POSIX sh scripts,
// run through the machine's own connection (this machine, ssh, or a client target's `/reap` and
// `/survey`), never typed into a pane where Claude may still be. They live in the client's directory because a client
// target runs them, and a client release is the files in that directory. Imports nothing of hopper but its own directory.

/** A job id the scripts take: a uuid, or a test's plain name. Never a pattern, a path or an option. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const isJobId = (id: unknown): id is string => typeof id === 'string' && JOB_ID.test(id);

/** The transient user scope a job's pane shell (or a print agent's turn) runs in, when the machine has systemd. */
export const scopeUnitOf = (jobId: string): string => `hopper-job-${jobId}`;

export const REAP_DONE = 'hopper-reaped';
export const SURVEY_DONE = 'hopper-surveyed';

// $1 the job id, $2 its scratch dir or empty, $3 `keep` to keep the scratch dir whatever it holds (a timed-out
// job's, issue #630: it may go on there), or `discard` to remove it whatever it holds (a person discarded the work
// it kept, issue #1010). The job's worktrees are in its work tree's workspace, `<work tree>/workspace/worktrees/<name>-<job
// id>` (issue #1103), the work tree the one the scratch dir is in; they go or stay with the scratch dir. Job ids are
// UUIDs, so no other job's worktree ends in this one's. Run with HOPPER_JOB_ID unset, so neither it nor what it starts
// matches the processes it stops.
const REAP_SCRIPT = [
  'id=$1; s=$2; k=$3;',
  // The job's scope: every process in it, whatever it did to its environment or session.
  'if command -v systemctl >/dev/null 2>&1; then systemctl --user stop "hopper-job-$id.scope" >/dev/null 2>&1; fi;',
  // Where there is no systemd, or for what left the scope: the processes carrying the job's id.
  'pids() { grep -lzx "HOPPER_JOB_ID=$id" /proc/[0-9]*/environ 2>/dev/null | sed -n "s|^/proc/\\([0-9]*\\)/environ\\$|\\1|p" | grep -vx "$$"; };',
  'if [ -r /proc/self/environ ]; then',
  '  l=$(pids);',
  '  if [ -n "$l" ]; then',
  '    kill -TERM $l 2>/dev/null;',
  '    n=0; while [ $n -lt 30 ] && [ -n "$(pids)" ]; do sleep 0.1; n=$((n+1)); done;',
  '    l=$(pids); [ -n "$l" ] && kill -KILL $l 2>/dev/null;',
  '  fi;',
  'fi;',
  // The job's temp link /tmp/hopper-<job id> (issue #506), only while it points at this scratch dir.
  't=/tmp/hopper-$id; [ -n "$s" ] && [ -L "$t" ] && [ "$(readlink "$t")" = "$s" ] && rm -f "$t";',
  // Only ever this job's own scratch dir: <work tree>/.hopper-scratch/<job id>.
  'case $s in */.hopper-scratch/"$id") ;; *) printf "%s\\n" hopper-reaped; exit 0;; esac;',
  // The job's credentials (issue #441) go whatever else is kept: they are the hopper's, not the job's work.
  'rm -rf "$s/credentials";',
  'w=${s%/.hopper-scratch/*};',
  'trees() { for t in "$w"/workspace/worktrees/*-"$id"; do [ -d "$t" ] && [ ! -L "$t" ] && printf "%s\\n" "$t"; done; };',
  'repos() { { find "$s" -name node_modules -prune -o -name .git -print -prune; trees | while IFS= read -r t; do [ -e "$t/.git" ] && printf "%s\\n" "$t/.git"; done; } 2>/dev/null; };',
  // A worktree (.git a file) answers for its own HEAD; a clone for HEAD and every branch it has. A
  // node_modules link to the shared dependencies (issue #410) is no work of the job's.
  'kept=; [ "$k" = discard ] || kept=$(repos | while IFS= read -r g; do',
  '  d=${g%/.git}; r="HEAD --branches"; [ -f "$g" ] && r=HEAD;',
  '  if ! st=$(git -C "$d" status --porcelain 2>/dev/null) || [ -n "$(printf "%s\\n" "$st" | grep -vx "?? node_modules")" ] || ! un=$(git -C "$d" log --oneline -1 $r --not --remotes 2>/dev/null) || [ -n "$un" ]; then',
  '    printf "hopper-kept %s\\n" "$d";',
  '  fi;',
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
  '  trees | while IFS= read -r t; do rm -rf "$t"; done;',
  '  rm -rf "$s";',
  'fi;',
  // A repository mirror an older release made in the scratch dirs (issue #1103: no job is made of one now) goes once no
  // worktree is made of it; one a kept worktree is of stays.
  'if [ "$k" != keep ]; then for m in "$w"/.hopper-scratch/repos/*/*.git; do',
  '  [ -d "$m" ] && [ ! -L "$m" ] || continue; git --git-dir="$m" worktree prune 2>/dev/null || continue;',
  '  [ "$(git --git-dir="$m" worktree list --porcelain 2>/dev/null | grep -c "^worktree ")" -le 1 ] && rm -rf "$m" && rmdir "${m%/*}" "$w/.hopper-scratch/repos" 2>/dev/null;',
  'done; fi;',
  'printf "%s\\n" hopper-reaped',
].map((l) => l.trim()).join(' ');

// $@ the work trees whose scratch dirs to list. What it prints, one per line: the jobs with a scope, the
// jobs with a process carrying their id, each work tree whose scratch area is there (issue #1120), each scratch dir with
// its age in seconds, and each job worktree in the work tree's workspace with its age (issue #1103).
const SURVEY_SCRIPT = [
  'if command -v systemctl >/dev/null 2>&1; then',
  '  systemctl --user list-units --type=scope --plain --no-legend "hopper-job-*" 2>/dev/null | sed -n "s/^hopper-job-\\([^ ]*\\)\\.scope .*/hopper-scope \\1/p";',
  'fi;',
  'if [ -r /proc/self/environ ]; then',
  '  for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" 2>/dev/null < "$f" | sed -n "s/^HOPPER_JOB_ID=//p"; done | sort -u | sed "s/^/hopper-proc /";',
  'fi;',
  'now=$(date +%s);',
  'for r in "$@"; do [ -d "$r/.hopper-scratch" ] && printf "hopper-root %s\\n" "$r"; for d in "$r"/.hopper-scratch/*; do',
  '  [ -d "$d" ] && [ ! -L "$d" ] || continue;',
  '  m=$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d" 2>/dev/null) || continue;',
  '  printf "hopper-dir %s %s\\n" "$((now - m))" "$d";',
  'done; for d in "$r"/workspace/worktrees/*; do',
  '  [ -d "$d" ] && [ ! -L "$d" ] || continue;',
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

/** What a finished reap said: the repositories it kept, and those whose branch was pushed (issue #630). Undefined when it did not finish. */
export function readReap(stdout: string): { kept: string[]; pushed?: string[] } | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(REAP_DONE)) return undefined;
  const named = (prefix: string): string[] => [...new Set(lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)))];
  const pushed = named('hopper-pushed ');
  return { kept: named('hopper-kept '), ...(pushed.length ? { pushed } : {}) };
}

/** One scratch dir the survey found: its job, path and age. */
export interface SurveyedDir { jobId: string; path: string; ageMs: number }
/** One job worktree the survey found in a work tree's workspace (issue #1103): its path and age; its job is known by its name. */
export interface SurveyedTree { path: string; ageMs: number }
/** What a finished survey found. Undefined when it did not finish. */
export interface Survey { scopes: string[]; processes: string[]; scratch: SurveyedDir[]; trees?: SurveyedTree[]; roots?: string[] }

export function readSurvey(stdout: string): Survey | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(SURVEY_DONE)) return undefined;
  const ids = (prefix: string): string[] => [...new Set(lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)).filter(isJobId))];
  const scratch: SurveyedDir[] = [];
  const trees: SurveyedTree[] = [];
  const roots: string[] = [];
  for (const l of lines) {
    const r = /^hopper-root (\/.*)$/.exec(l);
    if (r) roots.push(r[1]!);
    const m = /^hopper-dir (\d+) (\/.*\/\.hopper-scratch\/([^/]+))$/.exec(l);
    if (m && isJobId(m[3])) scratch.push({ jobId: m[3]!, path: m[2]!, ageMs: Number(m[1]) * 1000 });
    const t = /^hopper-tree (\d+) (\/.*\/workspace\/worktrees\/[^/]+)$/.exec(l);
    if (t) trees.push({ path: t[2]!, ageMs: Number(t[1]) * 1000 });
  }
  return { scopes: ids('hopper-scope '), processes: ids('hopper-proc '), scratch, trees, roots };
}

/** A scratch dir a reap may name: absolute, one line, and the job's own. */
export const isScratchOf = (path: unknown, jobId: string): path is string =>
  typeof path === 'string' && path.startsWith('/') && !/[\n\0]/.test(path) && path.endsWith(`/.hopper-scratch/${jobId}`);

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
