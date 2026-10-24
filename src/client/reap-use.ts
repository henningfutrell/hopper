// What a job used, as its reap reads it, beside reap.ts for its size: its scope's (issue #2498), and its heap aborts (issue
// #2722, design.md "Heap aborts"). Imports nothing of hopper.

// Each report a Node process of the job wrote to its temp dir (its scratch dir, `$s`) when its heap ran out (NODE_OPTIONS,
// src/domain/heap-aborts.ts), said as `hopper-heap <ms> <heap limit> <peak RSS> <argv JSON>`,
// each number `-` where the report has none (the argv: the compact report's header, up to the field after it), at most 20;
// then removed, so a later reap of kept work does not say it again.
export const HEAP_REPORTS_SH: readonly string[] = [
  'hv() { v=$(grep -o "\\"$1\\":\\"\\{0,1\\}[0-9]*" "$hf" 2>/dev/null | head -n 1 | tr -cd 0-9); printf %s "${v:--}"; };',
  'hn=0; [ -n "$s" ] && [ -d "$s" ] && [ ! -L "$s" ] && for hf in "$s"/report.*.json; do [ -f "$hf" ] && [ ! -L "$hf" ] || continue;',
  '  grep -q "\\"trigger\\":\\"OOMError\\"" "$hf" 2>/dev/null || continue; hn=$((hn+1));',
  '  [ $hn -le 20 ] && printf "hopper-heap %s %s %s %s\\n" "$(hv dumpEventTimeStamp)" "$(hv memoryLimit)" "$(hv maxRss)" "$(sed -n "s/.*\\"commandLine\\":\\(\\[.*\\]\\),\\"nodejsVersion\\".*/\\1/p" "$hf" | head -n 1 | head -c 4000 | tr -d "\\n")";',
  '  rm -f "$hf"; done;',
];

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
