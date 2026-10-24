// What a job used, as its reap reads it, beside reap.ts for its size: its scope's (issue #2498), its heap aborts (issue
// #2722, design.md "Heap aborts"), the core dumps and OOM kills of its processes (part 3, "Core dumps and OOM kills"),
// and the stop of its scope, said when it did not go through (part 6). Imports nothing of hopper.

// Each report a Node process of the job wrote to its temp dir (its scratch dir, `$s`) when its heap ran out (NODE_OPTIONS,
// src/domain/heap-aborts.ts), said as `hopper-heap <ms> <heap limit> <peak RSS> <argv JSON>`,
// each number `-` where the report has none (the argv: the compact report's header, up to the field after it), at most 20,
// and `hopper-heap-pid <pid>` (part 3: its core dump is the heap abort's); then removed, so a later reap of kept work does not say it again.
export const HEAP_REPORTS_SH: readonly string[] = [
  // No `\"` here (issue #2427): the double quote of a JSON pattern is `$q`.
  'q=\'"\'; hv() { v=$(grep -o "$q$1$q:$q\\{0,1\\}[0-9]*" "$hf" 2>/dev/null | head -n 1 | tr -cd 0-9); printf %s "${v:--}"; };',
  'hn=0; [ -n "$s" ] && [ -d "$s" ] && [ ! -L "$s" ] && for hf in "$s"/report.*.json; do [ -f "$hf" ] && [ ! -L "$hf" ] || continue;',
  '  grep -q "${q}trigger$q:${q}OOMError$q" "$hf" 2>/dev/null || continue; hn=$((hn+1));',
  '  [ $hn -le 20 ] && printf "hopper-heap %s %s %s %s\\n" "$(hv dumpEventTimeStamp)" "$(hv memoryLimit)" "$(hv maxRss)" "$(sed -n "s/.*${q}commandLine$q:\\(\\[.*\\]\\),${q}nodejsVersion$q.*/\\1/p" "$hf" | head -n 1 | head -c 4000 | tr -d "\\n")";',
  '  printf "hopper-heap-pid %s\\n" "$(hv processId)"; rm -f "$hf"; done;',
];

// The core dumps of the job's scope (part 3): systemd-coredump's journal entries of the scope's unit, each said as
// `hopper-core <JSON>` (at most 50, cut at 4000 characters); and, only when the scope counted OOM kills (`$ok`), the kernel's
// `oom-kill:` lines that name the scope, each as `hopper-oom <ms> <pid> <process name>` (at most 20). Read before the
// scope stops; nothing where there is no journal, or the reap's user cannot read it. `$cg` and `$ok` are the scope's
// cgroup and OOM kills, read before (reap.ts).
const COREDUMP_MESSAGE_ID = 'fc2e22bc6ee647b6b90729ab34a250b1';
export const CRASHES_SH: readonly string[] = [
  'jt=; command -v timeout >/dev/null 2>&1 && jt="timeout 20";',
  'if [ -n "$cg" ] && command -v journalctl >/dev/null 2>&1; then',
  `  $jt journalctl --no-pager -q -o json --output-fields=COREDUMP_PID,COREDUMP_SIGNAL,COREDUMP_CMDLINE,COREDUMP_TIMESTAMP MESSAGE_ID=${COREDUMP_MESSAGE_ID} "COREDUMP_USER_UNIT=hopper-job-$id.scope" 2>/dev/null | head -n 50 | cut -c 1-4000 | sed "s/^/hopper-core /";`,
  '  case $ok in ""|0|*[!0-9]*) ;; *) $jt journalctl --no-pager -q -k -b -o short-unix "--grep=oom-kill:.*hopper-job-$id\\.scope" 2>/dev/null | head -n 20 |',
  '    sed -n "s/^\\([0-9][0-9]*\\)\\.\\([0-9][0-9][0-9]\\)[0-9]* .*[ ,]task=\\([^,]*\\),pid=\\([0-9][0-9]*\\),.*/hopper-oom \\1\\2 \\4 \\3/p";; esac;',
  'fi;',
];

// The job's scope, stopped: every process in it, whatever it did to its environment or session. A stop that did not go
// through (part 6: a process that writes its core dump cannot be killed until it is written, so the stop times out) is said
// as `hopper-scope-left <state> <processes>`, the scope's state and the processes still in its cgroup (`-` unread); a
// failed scope is reset, so it does not stay listed. `$cr` and `$cg` are the cgroup root and the scope's cgroup (reap.ts).
export const SCOPE_STOP_SH: readonly string[] = [
  'if command -v systemctl >/dev/null 2>&1; then systemctl --user stop "hopper-job-$id.scope" >/dev/null 2>&1 || {',
  '  st=$(systemctl --user show -p ActiveState --value "hopper-job-$id.scope" 2>/dev/null); np=-;',
  '  case $cg in *..*) ;; /?*) [ -r "$cr$cg/cgroup.procs" ] && np=$(grep -c . "$cr$cg/cgroup.procs" 2>/dev/null);; esac;',
  '  case $st in ""|inactive) ;; *[!a-z-]*) ;; *) printf "hopper-scope-left %s %s\\n" "$st" "${np:--}"; [ "$st" = failed ] && systemctl --user reset-failed "hopper-job-$id.scope" >/dev/null 2>&1;; esac; }; fi;',
];

/** A job's scope its reap could not stop (part 6): its state then (`failed`, `deactivating`), the processes still in it. */
export interface ScopeNotStopped { state: string; processes?: number }

/** The reap's `hopper-scope-left` line; nothing when the stop went through. */
export function scopeLeftOf(lines: readonly string[]): { scopeNotStopped?: ScopeNotStopped } {
  const m = lines.map((l) => /^hopper-scope-left ([a-z-]+) (\S+)$/.exec(l)).find((x) => x !== null);
  return m ? { scopeNotStopped: { state: m[1]!, ...(/^\d+$/.test(m[2]!) ? { processes: Number(m[2]) } : {}) } } : {};
}

/**
 * One report of a job's Node process whose heap ran out (issue #2722), as the reap read it: when it aborted (ms since the
 * epoch), V8's heap limit, the process's peak memory (its max RSS) and its command line; each absent where the report did
 * not say it, or said it so the reap could not read it.
 */
export interface HeapReport { abortedAtMs?: number; heapLimitBytes?: number; rssPeakBytes?: number; commandLine?: string[] }

/** The reap's `hopper-heap` lines; nothing when there were none. */
export function heapOf(lines: readonly string[]): { heap?: HeapReport[] } {
  const heap = lines.flatMap((l) => {
    const m = /^hopper-heap (\S+) (\S+) (\S+) ?(.*)$/.exec(l);
    if (!m) return [];
    const n = (v: string): number | undefined => (/^\d+$/.test(v) ? Number(v) : undefined);
    const at = n(m[1]!), limit = n(m[2]!), rss = n(m[3]!), argv = argvOf(m[4]!);
    return [{ ...(at !== undefined ? { abortedAtMs: at } : {}), ...(limit !== undefined ? { heapLimitBytes: limit } : {}), ...(rss !== undefined ? { rssPeakBytes: rss } : {}), ...(argv ? { commandLine: argv } : {}) }];
  });
  return heap.length ? { heap } : {};
}

const argvOf = (text: string): string[] | undefined => {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) && v.every((a) => typeof a === 'string') ? v : undefined;
  } catch { return undefined; }
};

/** One core dump in the job's scope (part 3), as the reap read its journal entry: each field absent where it said none. */
export interface CoreDump { pid?: number; signal?: number; commandLine?: string; dumpedAtMs?: number }
/** One OOM kill in the job's scope (part 3), as the reap read the kernel's line: the process's name, its pid and when. */
export interface OomKill { pid?: number; task?: string; killedAtMs?: number }

/** How long after a heap abort's core dump a parent's core dump of the same signal is that abort said again. */
const RERAISED_MS = 10000;

/**
 * The reap's `hopper-core` and `hopper-oom` lines; nothing when there were none. A core dump of a heap abort's process
 * (`hopper-heap-pid`) is the heap abort's, and so is one of the same signal at most 10 s after it (the journal says whole seconds): a parent that raised its
 * child's signal again (`npm exec` does). At most 20 of each.
 */
export function crashesOf(lines: readonly string[]): { cores?: CoreDump[]; oomKilled?: OomKill[] } {
  const n = (v: unknown): number | undefined => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
  const all = lines.flatMap((l): CoreDump[] => {
    if (!l.startsWith('hopper-core ')) return [];
    try {
      const j = JSON.parse(l.slice('hopper-core '.length)) as Record<string, unknown>;
      const pid = n(j.COREDUMP_PID), signal = n(j.COREDUMP_SIGNAL), us = n(j.COREDUMP_TIMESTAMP) ?? n(j.__REALTIME_TIMESTAMP);
      const commandLine = typeof j.COREDUMP_CMDLINE === 'string' ? j.COREDUMP_CMDLINE : undefined;
      return [{ ...(pid !== undefined ? { pid } : {}), ...(signal !== undefined ? { signal } : {}), ...(commandLine !== undefined ? { commandLine } : {}), ...(us !== undefined ? { dumpedAtMs: Math.floor(us / 1000) } : {}) }];
    } catch { return []; }
  });
  const heapPids = new Set(lines.flatMap((l) => /^hopper-heap-pid (\d+)$/.exec(l)?.[1] ?? []).map(Number));
  const ofHeap = all.filter((c) => c.pid !== undefined && heapPids.has(c.pid));
  const cores = all.filter((c) => !ofHeap.includes(c) && !ofHeap.some((h) => h.signal === c.signal && h.dumpedAtMs !== undefined && c.dumpedAtMs !== undefined
    && c.dumpedAtMs >= h.dumpedAtMs && c.dumpedAtMs - h.dumpedAtMs <= RERAISED_MS)).slice(0, 20);
  const oomKilled = lines.flatMap((l): OomKill[] => {
    const m = /^hopper-oom (\d+) (\d+) (.+)$/.exec(l);
    return m ? [{ pid: Number(m[2]), task: m[3]!, killedAtMs: Number(m[1]) }] : [];
  }).slice(0, 20);
  return { ...(cores.length ? { cores } : {}), ...(oomKilled.length ? { oomKilled } : {}) };
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
export function usedOf(lines: readonly string[]): { used?: ResourceUse } {
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
