// Direct jobs from the command line (issue #901, design.md "Direct jobs"): `hopper job submit` submits a job straight to the
// hopper, with no GitHub issue, as `POST /ui/api/direct-jobs` does; `hopper job direct [<id>]` reads the direct jobs back,
// each with its job's status, result and open questions.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const DIRECT_USAGE = `  hopper job submit --title <t> (--brief <text> | --brief-file <f>) [--label <l>]... [--authorize <a>]... [--repo <owner/repo>] [--executor <e>] [--priority <0-100>]
                                                     submit a job straight to the hopper, with no GitHub issue; its brief and results stay in the hopper
  hopper job direct [<id>]                           the direct jobs, or one: its job's status, result and open questions`;

const SUBMIT = 'job submit --title <t> (--brief <text> | --brief-file <f>) [--label <l>]... [--authorize <a>]... [--repo <owner/repo>] [--executor <e>] [--priority <0-100>]';

const readText = (file: string): string => {
  try { return readFileSync(file, 'utf8'); } catch (e) { throw new OperatorRefusal(`--brief-file ${file}: ${(e as Error).message}`); }
};

/** `hopper job submit|direct …`; undefined for any other verb. */
export function directCall(verb: string | undefined, args: string[]): Call | undefined {
  if (verb === 'direct') {
    if (args.length > 1) throw usage('job direct [<id>]');
    return { role: 'viewer', path: args[0] === undefined ? '/api/direct-jobs' : `/api/direct-jobs/${encodeURIComponent(args[0])}` };
  }
  if (verb !== 'submit') return undefined;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    title: { type: 'string' }, brief: { type: 'string' }, 'brief-file': { type: 'string' }, label: { type: 'string', multiple: true },
    authorize: { type: 'string', multiple: true }, repo: { type: 'string' }, executor: { type: 'string' }, priority: { type: 'string' },
  } });
  if (positionals.length > 0 || !values.title || (values.brief === undefined) === (values['brief-file'] === undefined)) throw usage(SUBMIT);
  const priority = values.priority === undefined ? undefined : Number(values.priority);
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 100)) throw new OperatorRefusal(`--priority must be a whole number from 0 to 100, not ${values.priority}`);
  const brief = values.brief ?? readText(values['brief-file']!);
  return { role: 'operator', path: '/ui/api/direct-jobs', body: async () => ({
    title: values.title, brief, labels: values.label ?? [], authorizations: values.authorize ?? [],
    ...(values.repo ? { repo: values.repo } : {}), ...(values.executor ? { executor: values.executor } : {}), ...(priority !== undefined ? { priority } : {}),
  }) };
}
