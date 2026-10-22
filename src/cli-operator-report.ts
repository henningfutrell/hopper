// `hopper report …` (issue #694, design.md "Report a bug"): Report a bug from the operator CLI, by the UI's own path —
// the context the hopper fills in and masks (`POST /ui/api/bug-reports/context`), then the report
// (`POST /ui/api/bug-reports`), filed through the user's own GitHub connection or kept to send later; Your reports
// (`GET /api/bug-reports`) and its refresh.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const REPORT_USAGE = `  hopper report context                              the context a report carries, masked: read it before you send
  hopper report bug --title <t> (--happened <text> | --happened-file <f>) [--expected <text>] [--job <id>]
                    [--context-file <f>] [--comment-on <n>] [--force]
                                                     file a bug report on the hopper's repository, as you, with the
                                                     hopper's context (or the file's); similar open reports are answered
                                                     first: then --comment-on <n> or --force. Kept and sent later when
                                                     GitHub cannot take it now
  hopper report list                                 your reports, newest first: state (waiting, open, closed) and link
  hopper report refresh                              send the kept reports now, and read the others' state on GitHub`;

const REPORT_BUG = 'report bug --title <t> (--happened <text> | --happened-file <f>) [--expected <text>] [--job <id>] [--context-file <f>] [--comment-on <n>] [--force]';
const REPORT_VERBS = 'report context | bug … | list | refresh';

const readText = (flag: string, file: string): string => {
  try { return readFileSync(file, 'utf8'); } catch (e) { throw new OperatorRefusal(`--${flag} ${file}: ${(e as Error).message}`); }
};

export function reportCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    title: { type: 'string' }, happened: { type: 'string' }, 'happened-file': { type: 'string' }, expected: { type: 'string' }, job: { type: 'string' },
    'context-file': { type: 'string' }, 'comment-on': { type: 'string' }, force: { type: 'boolean' },
  } });
  const [verb, ...rest] = positionals;
  const job = values.job === undefined ? {} : { jobId: values.job };
  const bugFlags = ['title', 'happened', 'happened-file', 'expected', 'context-file', 'comment-on', 'force'].some((k) => values[k as keyof typeof values] !== undefined);
  if (rest.length > 0) throw usage(verb === 'bug' ? REPORT_BUG : REPORT_VERBS);
  if (verb === 'list' && !bugFlags && values.job === undefined) return { role: 'viewer', path: '/api/bug-reports' };
  if (verb === 'refresh' && !bugFlags && values.job === undefined) return { role: 'operator', path: '/ui/api/bug-reports/refresh', body: async () => ({}) };
  if (verb === 'context' && !bugFlags && values.job === undefined) return { role: 'operator', path: '/ui/api/bug-reports/context', body: async () => ({}) };
  if (verb !== 'bug') throw usage(REPORT_VERBS);
  if (values.title === undefined || (values.happened === undefined) === (values['happened-file'] === undefined)) throw usage(REPORT_BUG);
  const commentOn = values['comment-on'] === undefined ? undefined : Number(values['comment-on']);
  if (commentOn !== undefined && (!Number.isInteger(commentOn) || commentOn < 1)) throw new OperatorRefusal(`--comment-on is an issue number, not ${values['comment-on']}`);
  if (commentOn !== undefined && values.force) throw usage(REPORT_BUG);
  const happened = values.happened ?? readText('happened-file', values['happened-file']!);
  const contextFile = values['context-file'];
  return {
    role: 'operator', path: '/ui/api/bug-reports',
    body: async (send) => ({
      title: values.title, happened, expected: values.expected ?? '', ...job,
      // The hopper's context, masked, unless the person gives their own (read with `report context`, then edited).
      context: contextFile !== undefined ? readText('context-file', contextFile) : ((await send('/ui/api/bug-reports/context', {})) as { context: string }).context,
      ...(commentOn !== undefined ? { commentOn } : {}), ...(values.force ? { force: true } : {}),
    }),
  };
}
