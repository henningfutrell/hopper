// The reap (issue #401, design.md "Work tree" → "The reap"): what a job's pane shell runs when the job
// ends, after Claude has exited, so on whichever machine the job ran. It stops every process still
// carrying the job's HOPPER_JOB_ID (dev servers, watchers, anything started with `&` or `setsid`) and
// removes the job's scratch dir, unless a repository in it holds uncommitted or unpushed work: then the
// dir stays and each such repository is named. POSIX sh; stopping processes needs Linux's /proc.
import { shellQuote } from '../ssh.ts';

/** What the reap prints last, so the hopper knows the shell ran it to the end. */
export const REAP_DONE = 'hopper-reaped';
/** The line naming a repository the reap kept, then its path. */
const KEPT = 'hopper-kept';

// $1 the job id, $2 its scratch dir. The pane's shell ($PPID) carries the id too and is spared; this
// script runs with the id unset, so neither it nor what it starts matches. Printed markers are split
// (`hopper-%s`), so the command as the shell echoes it never reads as output.
const SCRIPT = [
  'id=$1; s=$2; me=$PPID;',
  'pids() { grep -lzx "HOPPER_JOB_ID=$id" /proc/[0-9]*/environ 2>/dev/null | sed -n "s|^/proc/\\([0-9]*\\)/environ\\$|\\1|p" | grep -vx "$me"; };',
  'if [ -r /proc/self/environ ]; then',
  '  l=$(pids);',
  '  if [ -n "$l" ]; then',
  '    kill -TERM $l 2>/dev/null;',
  '    n=0; while [ $n -lt 30 ] && [ -n "$(pids)" ]; do sleep 0.1; n=$((n+1)); done;',
  '    l=$(pids); [ -n "$l" ] && kill -KILL $l 2>/dev/null;',
  '  fi;',
  'fi;',
  // Only ever this job's own scratch dir: <work tree>/.hopper-scratch/<job id>.
  'case $s in */.hopper-scratch/"$id") ;; *) printf "hopper-%s\\n" reaped; exit 0;; esac;',
  'repos() { find "$s" -name node_modules -prune -o -name .git -print -prune 2>/dev/null; };',
  // A worktree (.git a file) answers for its own HEAD; a clone for HEAD and every branch it has.
  'kept=$(repos | while IFS= read -r g; do',
  '  d=${g%/.git}; r="HEAD --branches"; [ -f "$g" ] && r=HEAD;',
  '  if ! st=$(git -C "$d" status --porcelain 2>/dev/null) || [ -n "$st" ] || ! un=$(git -C "$d" log --oneline -1 $r --not --remotes 2>/dev/null) || [ -n "$un" ]; then',
  '    printf "hopper-%s %s\\n" kept "$d";',
  '  fi;',
  'done);',
  'if [ -n "$kept" ]; then printf "%s\\n" "$kept"; elif [ -d "$s" ]; then',
  '  repos | while IFS= read -r g; do',
  '    [ -f "$g" ] || continue;',
  '    c=$(git -C "${g%/.git}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && git --git-dir="$c" worktree remove --force "${g%/.git}" 2>/dev/null;',
  '  done;',
  '  rm -rf "$s";',
  'fi;',
  'printf "hopper-%s\\n" reaped',
].map((l) => l.trim()).join(' ');

/** The command typed into the pane's shell: any shell, since it hands the script to sh. */
export const reapCommand = (jobId: string, scratch: string): string =>
  `env -u HOPPER_JOB_ID sh -c ${shellQuote(SCRIPT)} sh ${shellQuote(jobId)} ${shellQuote(scratch)}`;

/** What a finished reap said: the repositories it kept. Undefined until its last line shows. */
export function readReap(screen: string): { kept: string[] } | undefined {
  const lines = screen.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(REAP_DONE)) return undefined;
  return { kept: lines.filter((l) => l.startsWith(`${KEPT} `)).map((l) => l.slice(KEPT.length + 1)) };
}
