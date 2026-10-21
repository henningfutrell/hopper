// A job's checkpoint (issue #921, design.md "Checkpoints and resume elsewhere"): the fixed script the hopper's
// `checkpoint` runs on the job's machine — this machine, over ssh, or as a client target's `POST /checkpoint` —, never
// typed into a pane, where the agent works. It reads the job's worktree and copies nothing into it: the patch from a
// commit on the remote to the work tree as it is (uncommitted and untracked files too, through an index of its own, so
// the job's own index is never locked; a node_modules link to shared dependencies left out), the commits not pushed, and the agent session's file
// (with its subagents' logs, for the token ledger only, issue #2302). It prints them, gzip and
// base64, between two marks. Imports nothing of hopper but its own directory: it is installed as plain files.

/** The most a checkpoint may hold, its patch and session compressed: printed as base64, it stays under 16 MiB of output. */
export const CHECKPOINT_MAX_BYTES = 10 * 1024 * 1024;
/** How long the script may take: `git add` of a large work tree, and the compression. */
export const CHECKPOINT_TIMEOUT_MS = 120000;

export const CHECKPOINT_BEGIN = 'hopper-checkpoint-begin';
export const CHECKPOINT_END = 'hopper-checkpoint-end';

// $1 the job id, $2 its worktree (`<work tree>/.worktrees/<name>/<job id>`, issue #1188; or in its own scratch
// dir; or, for a job that started before issue #1188 and still runs, `<work tree>/.hopper-scratch/<job id>/<name>` or
// `<work tree>/workspace/worktrees/<name>-<job id>`, issue #1353), $3 its agent session id, $4 the most bytes. Prints
// `hopper-checkpoint none <why>`, or the checkpoint between the begin and end marks. The base: the job's branch as pushed
// when its HEAD holds it, else where HEAD left the default branch, else HEAD. Git never prompts and never fetches.
const SCRIPT = [
  'id=$1; w=$2; s=$3; max=$4;',
  'no() { echo "not the job\'s worktree: $w" >&2; exit 2; };',
  'case $w in */../*|*/..) no;; /*/.hopper-scratch/"$id"/*|/*/workspace/worktrees/*-"$id") ;; /*/.worktrees/@*/*) case $w in /*/.worktrees/@scratch/"$id"/*) ;; *) no;; esac;; /*/.worktrees/*/"$id") ;; *) no;; esac;',
  'case $s in ""|*[!0-9A-Za-z-]*) echo "not a session id: $s" >&2; exit 2;; esac;',
  'none() { echo "hopper-checkpoint none $*"; exit 0; };',
  'cd "$w" 2>/dev/null || none "the worktree $w is not there";',
  'export GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 GIT_OPTIONAL_LOCKS=0;',
  'head=$(git rev-parse --verify -q HEAD) || none "the worktree has no commit";',
  't=$(mktemp -d) || none "no temp dir";',
  'trap \'rm -rf "$t"\' EXIT;',
  'b=$(git symbolic-ref --short -q HEAD); base=;',
  'if [ -n "$b" ]; then u=$(git rev-parse --verify -q "refs/remotes/origin/$b") && git merge-base --is-ancestor "$u" HEAD && base=$u; fi;',
  '[ -n "$base" ] || base=$(git merge-base HEAD refs/remotes/origin/HEAD 2>/dev/null) || base=;',
  '[ -n "$base" ] || base=$head;',
  'GIT_INDEX_FILE="$t/index" git read-tree HEAD && GIT_INDEX_FILE="$t/index" git add -A -- . ":(exclude)node_modules" && tree=$(GIT_INDEX_FILE="$t/index" git write-tree) || none "git could not read the work tree";',
  'git diff --binary --no-color --no-ext-diff --no-renames "$base" "$tree" > "$t/p" || none "git could not make the patch";',
  'gzip -c < "$t/p" > "$t/p.gz" || none "gzip failed";',
  'f=; for c in "${CLAUDE_CONFIG_DIR:-}" "$HOME/.claude"; do [ -n "$c" ] || continue; for g in "$c"/projects/*/"$s".jsonl; do [ -f "$g" ] && f=$g; done; done;',
  'if [ -n "$f" ]; then gzip -c < "$f" > "$t/s.gz" || none "gzip failed"; fi;',
  'n=$(cat "$t"/*.gz | wc -c | tr -d " ");',
  '[ "$n" -le "$max" ] || none "too large: $n bytes compressed, more than $max";',
  // The session's subagent logs (issue #2302): counted only, never kept, so they are left out when they do not fit.
  'if [ -n "$f" ] && [ -d "${f%.jsonl}/subagents" ]; then for g in "${f%.jsonl}"/subagents/*.jsonl; do [ -f "$g" ] && { cat "$g"; echo; }; done | gzip -c > "$t/a.z" || rm -f "$t/a.z";',
  '[ -s "$t/a.z" ] && [ $((n + $(wc -c < "$t/a.z"))) -le "$max" ] || rm -f "$t/a.z"; fi;',
  'echo hopper-checkpoint-begin; echo "branch $b"; echo "base $base"; echo "head $head";',
  'git log -n 50 --format="commit %h %s" "$base..HEAD";',
  'printf "patch "; base64 < "$t/p.gz" | tr -d "\\n"; echo;',
  'if [ -f "$t/s.gz" ]; then printf "session "; base64 < "$t/s.gz" | tr -d "\\n"; echo; fi;',
  'if [ -f "$t/a.z" ]; then printf "subagents "; base64 < "$t/a.z" | tr -d "\\n"; echo; fi;',
  'echo hopper-checkpoint-end',
].join(' ');

const JOB_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** A session id as Claude's `--session-id` takes it: a UUID. */
export const isSessionId = (s: unknown): s is string => typeof s === 'string' && /^[0-9A-Za-z-]{8,64}$/.test(s);
/**
 * A worktree the checkpoint may read: absolute, one line, the job's own — `…/.worktrees/<name>/<job id>` (issue #1188), or
 * in its own scratch dir `…/.worktrees/@scratch/<job id>/…`; or, for a job that started before issue #1188 and still
 * runs, its place in the layout before: `…/.hopper-scratch/<job id>/…` or `…/workspace/worktrees/<name>-<job id>` (issue
 * #1353).
 */
export const isJobWorktreeOf = (path: unknown, jobId: string): path is string =>
  typeof path === 'string' && path.startsWith('/') && !/[\n\0]/.test(path) && !path.split('/').includes('..')
  && (path.includes(`/.worktrees/@scratch/${jobId}/`) || new RegExp(`/\\.worktrees/[^/@][^/]*/${jobId}$`).test(path)
    || path.includes(`/.hopper-scratch/${jobId}/`) || new RegExp(`/workspace/worktrees/[^/]+-${jobId}$`).test(path));

/** The argv that takes a job's checkpoint. */
export const checkpointArgv = (jobId: string, worktree: string, session: string, maxBytes = CHECKPOINT_MAX_BYTES): string[] =>
  ['sh', '-c', SCRIPT, 'sh', jobId, worktree, session, String(maxBytes)];

/** The argv a client's `POST /checkpoint {jobId, worktree, session}` asks for; else why it is refused. */
export function checkpointOf(body: unknown): string[] | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { jobId?: unknown; worktree?: unknown; session?: unknown };
  if (typeof b.jobId !== 'string' || !JOB_ID.test(b.jobId)) return 'jobId must be a job id';
  if (!isJobWorktreeOf(b.worktree, b.jobId)) return 'worktree must be the job\'s own worktree, in its work tree\'s workspace or its scratch dir';
  if (!isSessionId(b.session)) return 'session must be a session id';
  return checkpointArgv(b.jobId, b.worktree, b.session);
}

/** What the script printed. */
export type ReadCheckpoint =
  | { taken: { branch?: string; base: string; head: string; commits: string[]; patch: Buffer; session?: Buffer; subagents?: Buffer } }
  | { none: string };

/** The checkpoint the script printed, or why it took none; undefined when it printed neither (it did not finish). */
export function readCheckpoint(stdout: string): ReadCheckpoint | undefined {
  const lines = stdout.split('\n');
  const none = lines.find((l) => l.startsWith('hopper-checkpoint none '));
  if (none) return { none: none.slice('hopper-checkpoint none '.length).trim() };
  const from = lines.indexOf(CHECKPOINT_BEGIN);
  const to = lines.indexOf(CHECKPOINT_END, from + 1);
  if (from < 0 || to < 0) return undefined;
  const got: { branch?: string; base?: string; head?: string; commits: string[]; patch?: Buffer; session?: Buffer; subagents?: Buffer } = { commits: [] };
  for (const line of lines.slice(from + 1, to)) {
    const at = line.indexOf(' ');
    const [key, value] = at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)];
    if (key === 'branch' && value) got.branch = value;
    else if (key === 'base' && /^[0-9a-f]{40,64}$/.test(value)) got.base = value;
    else if (key === 'head' && /^[0-9a-f]{40,64}$/.test(value)) got.head = value;
    else if (key === 'commit') got.commits.push(value);
    else if (key === 'patch') got.patch = Buffer.from(value, 'base64');
    else if (key === 'session' && value) got.session = Buffer.from(value, 'base64');
    else if (key === 'subagents' && value) got.subagents = Buffer.from(value, 'base64');
  }
  if (!got.base || !got.head || !got.patch) return undefined;
  return { taken: { ...(got.branch ? { branch: got.branch } : {}), base: got.base, head: got.head, commits: got.commits, patch: got.patch, ...(got.session ? { session: got.session } : {}), ...(got.subagents ? { subagents: got.subagents } : {}) } };
}

// ---- Restore: typed into the new pane's shell, in the job's new worktree, before its agent resumes -----------------

/** What the restore command prints, followed by its outcome. */
export const RESTORE_MARK = 'hopper-restore-';
export type RestoreOutcome = 'restored' | 'kept' | 'failed';

/** The line the restore prints when the pane has no way to the hopper (issue #2316): the job cannot go on on that machine, another may (issue #2355). Never in the script's text, which the pane's screen echoes. */
export const RESTORE_NO_WAY = 'hopper: the job has no way to the hopper';

// Run by `sh` in the job's worktree, with the job's variables (HOPPER_URL, HOPPER_TOKEN_FILE; git reaches GitHub through
// the hopper; a token file not readable yet is waited for a few seconds, issue #2316): $1 the base, $2 the branch (empty: none), $3 the session id, $4 1 when the checkpoint holds the session.
// It gets the checkpoint's parts from the hopper first, then checks out the base (fetched when it is not here), applies
// the patch as uncommitted changes, and puts the session where the agent finds it for this directory. A worktree that
// holds changes already is the job's own work, never overwritten: `kept` (only a missing session file is put).
// Prints its outcome last.
const RESTORE_SCRIPT = [
  'base=$1 b=$2 s=$3 hs=$4;',
  'export GIT_TERMINAL_PROMPT=0;',
  'no() { echo "hopper: $*" >&2; echo failed; exit 0; };',
  'k=0; while [ -n "$HOPPER_URL" ] && [ -n "$HOPPER_TOKEN_FILE" ] && [ ! -r "$HOPPER_TOKEN_FILE" ] && [ $k -lt 5 ]; do sleep 1; k=$((k+1)); done;',
  '[ -n "$HOPPER_URL" ] || no "the job has no way to the hopper: HOPPER_URL is not set";',
  '[ -r "$HOPPER_TOKEN_FILE" ] || no "the job has no way to the hopper: HOPPER_TOKEN_FILE is not readable";',
  't=$(mktemp -d) || no "no temp dir";',
  'get() { printf "authorization: Bearer %s\\n" "$(cat "$HOPPER_TOKEN_FILE")" | curl -sS --fail -H @- -o "$2" "$HOPPER_URL/job/checkpoint/$1"; };',
  'get patch "$t/p" || no "could not get the checkpoint\'s patch";',
  'if [ "$hs" = 1 ]; then get session "$t/s" || no "could not get the checkpoint\'s session"; fi;',
  'd="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(pwd -P | sed "s/[^A-Za-z0-9]/-/g")";',
  'place() { [ "$hs" = 1 ] || return 0; [ -f "$d/$s.jsonl" ] && return 0; mkdir -p "$d" && cp "$t/s" "$d/$s.jsonl"; };',
  'if [ -n "$(git status --porcelain -- . ":(exclude)node_modules" 2>/dev/null)" ]; then place || no "could not put the session"; rm -rf "$t"; echo kept; exit 0; fi;',
  'git cat-file -e "$base^{commit}" 2>/dev/null || git fetch --quiet origin "$base" 2>/dev/null || { [ -n "$b" ] && git fetch --quiet origin "$b"; };',
  'git cat-file -e "$base^{commit}" 2>/dev/null || no "the checkpoint\'s base $base is not on the remote";',
  'if [ -n "$b" ]; then git checkout --quiet -B "$b" "$base" 2>/dev/null || git checkout --quiet --detach "$base"; else git checkout --quiet --detach "$base"; fi || no "could not check out $base";',
  '[ ! -s "$t/p" ] || git apply --binary --whitespace=nowarn "$t/p" || no "the patch did not apply";',
  'place || no "could not put the session";',
  'rm -rf "$t"; echo restored',
].join(' ');

const shq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/** The one-line restore command for the pane's shell, in the job's worktree: it says its outcome as two printf words. */
export function restoreCommand(o: { base: string; branch?: string; session: string; hasSession: boolean }): string {
  const args = [o.base, o.branch ?? '', o.session, o.hasSession ? '1' : '0'].map(shq).join(' ');
  return `o=$(sh -c ${shq(RESTORE_SCRIPT)} hopper-restore ${args} | tail -n 1); printf 'hopper-restore-%s\\n' "\${o:-failed}"`;
}

const OUTCOME = /hopper-restore-(restored|kept|failed)\b/g;

/** The outcome the restore command printed on the screen, if it has. */
export function restoreOutcome(screen: string): RestoreOutcome | undefined {
  return [...screen.matchAll(OUTCOME)].at(-1)?.[1] as RestoreOutcome | undefined;
}

/** The argv that runs the restore script outside a pane, for a test: as the pane's shell runs it. */
export const restoreArgv = (o: { base: string; branch?: string; session: string; hasSession: boolean }): string[] =>
  ['sh', '-c', RESTORE_SCRIPT, 'hopper-restore', o.base, o.branch ?? '', o.session, o.hasSession ? '1' : '0'];
