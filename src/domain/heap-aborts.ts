// Heap aborts (issue #2722, design.md "Heap aborts"): a Node process in a job that V8 ended because its heap reached its
// limit — tsc in a job scope whose MemoryMax shrank Node's default heap (issue #2721) — is told to the agent only as an exit
// code. Every job's Node processes write a report on a fatal error (NODE_OPTIONS, here), into the job's temp dir; the reap
// reads each one whose heap ran out (src/client/reap.ts) and the job records it (`job.heap_aborted`): the command, the heap
// limit and the process's peak memory. Pure.
import type { BomPart } from './job-bom.ts';
import type { DomainEvent } from './types.ts';

/** Node's options for the report: on a fatal error only (a heap that runs out is one), one line, into `dir`. */
export const nodeReportOptions = (dir: string): string => `--report-on-fatalerror --report-compact --report-directory=${dir}`;

/**
 * NODE_OPTIONS for a job's tools: the report options into `dir` (the job's temp link, which has no space in it), then the
 * payload's own (`env`), which win.
 */
export const nodeReportEnv = (dir: string, env: Readonly<Record<string, string>> = {}): { NODE_OPTIONS: string } => ({
  NODE_OPTIONS: [nodeReportOptions(dir), env.NODE_OPTIONS].filter((o) => o).join(' '),
});

/** One report the reap read (src/client/reap.ts `HeapReport`): each field absent where the report did not say it. */
export interface HeapReport { abortedAtMs?: number; heapLimitBytes?: number; rssPeakBytes?: number; commandLine?: string[] }

/** A heap abort as `job.heap_aborted` records it: the command, never a path, and what the report said. */
export type HeapAborted = { command: string; heapLimitBytes?: number; rssPeakBytes?: number; abortedAt?: string };

const COMMAND_MAX = 120;
const nameOf = (arg: string): string => (arg.startsWith('/') ? arg.slice(arg.lastIndexOf('/') + 1) : arg);
const isNode = (program: string): boolean => /^(node|nodejs)(\.exe)?$/.test(nameOf(program));

/**
 * The command a report names, for a person: the script node ran (`tsc`, not node), with its arguments; node's own options
 * left out; each absolute path only by its file's name, so it names no home directory; cut at 120 characters. `node`
 * when it ran no script (`node -e`).
 */
export function heapCommandOf(argv: readonly string[]): string {
  let rest = argv;
  if (rest.length === 0 || isNode(rest[0]!)) {
    rest = rest.slice(1);
    const script = rest.findIndex((a) => !a.startsWith('-'));
    // `-e`, `-p` and the like take the code as their argument: no script then.
    rest = script < 0 || rest.slice(0, script).some((a) => /^(-e|--eval|-p|--print|-r|--require|--import)$/.test(a)) ? [] : rest.slice(script);
    if (rest.length === 0) return 'node';
  }
  const text = rest.map(nameOf).join(' ');
  return text.length > COMMAND_MAX ? `${text.slice(0, COMMAND_MAX - 1)}…` : text;
}

/** What `job.heap_aborted` records of one report. */
export function heapAbortedOf(r: HeapReport): HeapAborted {
  return {
    command: heapCommandOf(r.commandLine ?? []),
    ...(r.heapLimitBytes !== undefined ? { heapLimitBytes: r.heapLimitBytes } : {}), ...(r.rssPeakBytes !== undefined ? { rssPeakBytes: r.rssPeakBytes } : {}),
    ...(r.abortedAtMs !== undefined && Number.isFinite(r.abortedAtMs) ? { abortedAt: new Date(r.abortedAtMs).toISOString() } : {}),
  };
}

const gib = (bytes: number): string => `${Math.round((bytes / 1024 ** 3) * 10) / 10} GiB`;

/** One failed part for each heap abort, under machines: what ran out of heap, its heap limit, its peak, its machine. */
export function heapAborts(events: readonly DomainEvent[]): BomPart[] {
  return events.filter((e) => e.type === 'job.heap_aborted').map((e) => {
    const d = e.data as Partial<HeapAborted>;
    const command = typeof d.command === 'string' && d.command ? d.command : 'node';
    const said = [d.heapLimitBytes !== undefined ? `heap limit ${gib(d.heapLimitBytes)}` : undefined, d.rssPeakBytes !== undefined ? `peak ${gib(d.rssPeakBytes)}` : undefined, e.machineId ? `on ${e.machineId}` : undefined].filter(Boolean).join(', ');
    const at = d.abortedAt ?? e.at;
    return {
      id: `heap-abort:${e.seq}`, group: 'machines', kind: 'heap_abort', label: `${command.split(' ')[0]} ran out of heap`, status: 'failed',
      ...(at ? { at } : {}), detail: `${command}${said ? `: ${said}` : ''}`, href: '#machines',
    };
  });
}
