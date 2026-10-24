// Core dumps and OOM kills of a job's processes (issue #2722 part 3, design.md "Core dumps and OOM kills"): a process in a
// job's scope that a signal ended with a core dump (systemd-coredump took it), or that the kernel's OOM killer ended, was
// told to the agent only as an exit code. The reap reads each from the journal (src/client/reap-use.ts) and the job records
// it (`job.core_dumped`, `job.oom_killed`): the command and when. A heap abort's own core dump is the heap abort's
// (`job.heap_aborted`, heap-aborts.ts). Pure.
import { heapCommandOf } from './heap-aborts.ts';
import type { BomPart } from './job-bom.ts';
import type { DomainEvent } from './types.ts';

/** One core dump the reap read (src/client/reap-use.ts `CoreDump`): each field absent where the journal did not say it. */
export interface CoreDump { pid?: number; signal?: number; commandLine?: string; dumpedAtMs?: number }
/** One OOM kill the reap read (`OomKill`): the killed process's name (the kernel's `task`), its pid and when. */
export interface OomKill { pid?: number; task?: string; killedAtMs?: number }

/** A core dump as `job.core_dumped` records it: the command, never a path, the signal by its name, and when. */
export type CoreDumped = { command: string; signal: string; dumpedAt?: string };
/** An OOM kill as `job.oom_killed` records it: the killed process's name, and when. */
export type OomKilled = { command: string; killedAt?: string };

const NO_COMMAND = 'a process';

const SIGNALS: Readonly<Record<number, string>> = {
  3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 11: 'SIGSEGV', 24: 'SIGXCPU', 25: 'SIGXFSZ', 31: 'SIGSYS',
};

/** A signal that dumps core, by its name; `signal <n>` for another, `a signal` for none. */
export const signalName = (signal: number | undefined): string =>
  signal === undefined ? 'a signal' : SIGNALS[signal] ?? `signal ${signal}`;

/**
 * The words of a command line as the journal gives it (`COREDUMP_CMDLINE`: each word quoted as the shell would, `'…'`,
 * `$'…'` or `"…"`, where it needs it). Escapes in `$'…'` are kept as they are: the command is for a person to read.
 */
function wordsOf(text: string): string[] {
  const words: string[] = [];
  let word: string | undefined, quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === ' ') {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (ch === '$' && text[i + 1] === "'") {
      word ??= ''; quote = "'"; i++;
    } else if (ch === "'" || ch === '"') {
      word ??= ''; quote = ch;
    } else word = (word ?? '') + ch;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** The command of a core dump, for a person, as heapCommandOf says one; `a process` when the journal gave none. */
export function crashCommandOf(commandLine: string | undefined): string {
  const words = wordsOf(commandLine ?? '');
  return words.length ? heapCommandOf(words) : NO_COMMAND;
}

const isoOf = (ms: number | undefined): string | undefined => (ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

/** What `job.core_dumped` records of one core dump. */
export function coreDumpedOf(c: CoreDump): CoreDumped {
  const at = isoOf(c.dumpedAtMs);
  return { command: crashCommandOf(c.commandLine), signal: signalName(c.signal), ...(at ? { dumpedAt: at } : {}) };
}

/** What `job.oom_killed` records of one OOM kill. */
export function oomKilledOf(o: OomKill): OomKilled {
  const at = isoOf(o.killedAtMs);
  return { command: o.task?.trim() || NO_COMMAND, ...(at ? { killedAt: at } : {}) };
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** One failed part for each core dump and OOM kill, under machines: what dumped core or was killed, how, and its machine. */
export function processCrashes(events: readonly DomainEvent[]): BomPart[] {
  return events.flatMap((e): BomPart[] => {
    const d = e.data as Record<string, unknown>;
    const command = text(d.command) ?? NO_COMMAND, on = e.machineId ? `, on ${e.machineId}` : '';
    if (e.type === 'job.core_dumped') {
      const at = text(d.dumpedAt) ?? e.at;
      return [{
        id: `core-dump:${e.seq}`, group: 'machines', kind: 'core_dump', label: `${command.split(' ')[0]} dumped core (${text(d.signal) ?? 'a signal'})`, status: 'failed',
        ...(at ? { at } : {}), detail: `${command}: ${text(d.signal) ?? 'a signal'} ended it${on}`, href: '#machines',
      }];
    }
    if (e.type === 'job.oom_killed') {
      const at = text(d.killedAt) ?? e.at;
      return [{
        id: `oom-kill:${e.seq}`, group: 'machines', kind: 'oom_kill', label: `${command} was killed: out of memory`, status: 'failed',
        ...(at ? { at } : {}), detail: `${command}: the kernel's OOM killer ended it${on}`, href: '#machines',
      }];
    }
    return [];
  });
}
