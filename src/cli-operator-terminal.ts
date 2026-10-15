// The terminals from the command line (issue #1128, design.md "The job's terminal", "The machine's terminal"): `hopper terminal`
// makes the calls the Terminal of a job and of a machine make. A read prints the screen as the route answers it; `type` writes the
// text on stdin, never an argument, so what a person types stays out of the shell's history; `keys` presses herdr's named keys.
// The daemon checks the keys, the limits, the role and Access: one owner of each rule.
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const TERMINAL_USAGE = `  hopper terminal job <job> [--lines <n>]            the job's herdr pane as it shows now, with the scrollback (operator)
  hopper terminal job <job> type                     type the text on stdin into the job's pane, as it is (one end of line dropped)
  hopper terminal job <job> keys <key>...            press keys in the job's pane: enter, esc, tab, backspace, up, down, left, right, ctrl+c, ctrl+d
  hopper terminal machine <machine>                  the panes of the hopper's herdr session on the machine, and the job that holds each (admin)
  hopper terminal machine <machine> <pane> [--lines <n>]   that pane as it shows now
  hopper terminal machine <machine> <pane> type      type the text on stdin into that pane
  hopper terminal machine <machine> <pane> keys <key>...   press keys in that pane`;

const LINE = 'terminal job <job> [--lines <n>] | terminal job <job> type | terminal job <job> keys <key>... | terminal machine <machine> [<pane> [--lines <n>] | <pane> type | <pane> keys <key>...]';

/** The text to type: stdin, less one end of line (a here-string or `echo` adds it; press enter with `keys enter`). */
function typed(stdin: () => string): string {
  const text = stdin().replace(/\r?\n$/, '');
  if (!text) throw new OperatorRefusal('no text on stdin: pipe it in, e.g. hopper terminal … type < text-file');
  return text;
}

function linesOf(raw: string | undefined): { lines?: number } {
  if (raw === undefined) return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new OperatorRefusal(`--lines ${raw}: write a whole number of lines, 1 or more`);
  return { lines: n };
}

export function terminalCall(args: string[], stdin: () => string): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { lines: { type: 'string' } } });
  const [on, id, ...rest] = positionals;
  if ((on !== 'job' && on !== 'machine') || !id) throw usage(LINE);
  const lines = linesOf(values.lines);
  if (on === 'job') {
    const at = `/ui/api/jobs/${encodeURIComponent(id)}/terminal`;
    return action(at, {}, rest, lines, 'operator', stdin);
  }
  const at = `/ui/api/machines/${encodeURIComponent(id)}/terminal`;
  if (rest.length === 0) {
    if (values.lines !== undefined) throw usage(LINE);
    return { role: 'admin', path: `${at}/panes`, body: async () => ({}) };
  }
  const [paneId, ...more] = rest;
  return action(at, { paneId: paneId! }, more, lines, 'admin', stdin);
}

/** A read, `type` or `keys` on the terminal at `at`; `pane` names the pane on a machine. */
function action(at: string, pane: { paneId?: string }, rest: string[], lines: { lines?: number }, role: Call['role'], stdin: () => string): Call {
  const [verb, ...keys] = rest;
  if (verb === undefined) return { role, path: `${at}/screen`, body: async () => ({ ...pane, ...lines }) };
  if (lines.lines !== undefined) throw usage(LINE);
  if (verb === 'type' && keys.length === 0) {
    const text = typed(stdin);
    return { role, path: `${at}/input`, body: async () => ({ ...pane, text }) };
  }
  if (verb === 'keys' && keys.length > 0) return { role, path: `${at}/input`, body: async () => ({ ...pane, keys }) };
  throw usage(LINE);
}
