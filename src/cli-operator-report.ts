// `hopper report …` (issue #694, design.md "Report a bug"): Report a bug from the operator CLI, by the UI's own path —
// the context the hopper adds (`POST /ui/api/bug-reports/context`), the report as it would be posted
// (`POST /ui/api/bug-reports/preview`, issue #2818), then the report (`POST /ui/api/bug-reports`), filed through the
// user's own GitHub connection or kept to send later; Your reports (`GET /api/bug-reports`) and its refresh; a job's
// report approved or discarded, and public bug reports turned on or off (issue #2818).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PUBLIC_REPORT_WARNING } from './bug-reports/context.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const REPORT_USAGE = `  Report a bug posts on the hopper's PUBLIC tracker. ${PUBLIC_REPORT_WARNING}
  hopper report context                              what every report carries: the OS and the hopper's version
  hopper report preview --title <t> (--description <text> | --description-file <f>)
                                                     the report as it would be posted: scrubbed and masked
  hopper report bug --title <t> (--description <text> | --description-file <f>) [--job <id>] [--comment-on <n>] [--force]
                                                     file a bug report on the hopper's repository, as you; similar open
                                                     reports are answered first: then --comment-on <n> or --force. Kept
                                                     and sent later when GitHub cannot take it now
  hopper report list                                 your reports, newest first: state (approval, waiting, open, closed)
  hopper report refresh                              send the kept reports now, and read the others' state on GitHub
  hopper report approve|discard <id>                 approve and send, or discard, a job's report that waits for approval
  hopper report public on|off                        turn public bug reports on or off (admin; off by default)`;

const TEXT = '--title <t> (--description <text> | --description-file <f>)';
const REPORT_BUG = `report bug ${TEXT} [--job <id>] [--comment-on <n>] [--force]`;
const REPORT_VERBS = 'report context | preview … | bug … | list | refresh | approve <id> | discard <id> | public on|off';

const readText = (flag: string, file: string): string => {
  try { return readFileSync(file, 'utf8'); } catch (e) { throw new OperatorRefusal(`--${flag} ${file}: ${(e as Error).message}`); }
};

export function reportCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    title: { type: 'string' }, description: { type: 'string' }, 'description-file': { type: 'string' }, job: { type: 'string' },
    'comment-on': { type: 'string' }, force: { type: 'boolean' },
  } });
  const [verb, ...rest] = positionals;
  const job = values.job === undefined ? {} : { jobId: values.job };
  const textFlags = ['title', 'description', 'description-file'].some((k) => values[k as keyof typeof values] !== undefined);
  const bugFlags = textFlags || ['comment-on', 'force', 'job'].some((k) => values[k as keyof typeof values] !== undefined);
  if (verb === 'approve' || verb === 'discard') {
    if (rest.length !== 1 || bugFlags) throw usage(`report ${verb} <id>`);
    return { role: 'operator', path: `/ui/api/bug-reports/${verb}`, body: async () => ({ id: rest[0] }) };
  }
  if (verb === 'public') {
    if (rest.length !== 1 || (rest[0] !== 'on' && rest[0] !== 'off') || bugFlags) throw usage('report public on|off');
    return { role: 'admin', path: '/ui/api/bug-reports/settings', body: async () => ({ on: rest[0] === 'on' }) };
  }
  if (rest.length > 0) throw usage(verb === 'bug' ? REPORT_BUG : REPORT_VERBS);
  if (verb === 'list' && !bugFlags) return { role: 'viewer', path: '/api/bug-reports' };
  if (verb === 'refresh' && !bugFlags) return { role: 'operator', path: '/ui/api/bug-reports/refresh', body: async () => ({}) };
  if (verb === 'context' && !bugFlags) return { role: 'operator', path: '/ui/api/bug-reports/context', body: async () => ({}) };
  if (verb !== 'bug' && verb !== 'preview') throw usage(REPORT_VERBS);
  const shape = verb === 'bug' ? REPORT_BUG : `report preview ${TEXT}`;
  if (values.title === undefined || (values.description === undefined) === (values['description-file'] === undefined)) throw usage(shape);
  const description = values.description ?? readText('description-file', values['description-file']!);
  if (verb === 'preview') {
    if (bugFlags !== textFlags || values.job !== undefined) throw usage(shape);
    return { role: 'operator', path: '/ui/api/bug-reports/preview', body: async () => ({ title: values.title, description }) };
  }
  const commentOn = values['comment-on'] === undefined ? undefined : Number(values['comment-on']);
  if (commentOn !== undefined && (!Number.isInteger(commentOn) || commentOn < 1)) throw new OperatorRefusal(`--comment-on is an issue number, not ${values['comment-on']}`);
  if (commentOn !== undefined && values.force) throw usage(REPORT_BUG);
  return {
    role: 'operator', path: '/ui/api/bug-reports',
    body: async () => ({ title: values.title, description, ...job, ...(commentOn !== undefined ? { commentOn } : {}), ...(values.force ? { force: true } : {}) }),
  };
}
