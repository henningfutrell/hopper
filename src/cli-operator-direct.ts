// Direct jobs from the command line (issue #901, design.md "Direct jobs"): `hopper job submit` submits a job straight to the
// hopper, with no GitHub issue, as `POST /ui/api/direct-jobs` does; `hopper job direct [<id>]` reads the direct jobs back,
// each with its job's status, result and open questions.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';
import { parseRequirements, type PushRequirement } from './domain/push-requirements.ts';

export const DIRECT_USAGE = `  hopper job submit --title <t> (--brief <text> | --brief-file <f>) [--label <l>]... [--authorize <a>]... [--repo <owner/repo>] [--executor <e>] [--priority <0-100>] [--promote-when-done] [--push-requirements <f>]
                                                     submit a job straight to the hopper, with no GitHub issue; its brief and results stay in the hopper;
                                                     --push-requirements: its own, a file as .hopper/requirements.yaml
  hopper job direct [<id>]                           the direct jobs, or one: its job's status, result and open questions`;

const SUBMIT = 'job submit --title <t> (--brief <text> | --brief-file <f>) [--label <l>]... [--authorize <a>]... [--repo <owner/repo>] [--executor <e>] [--priority <0-100>] [--promote-when-done] [--push-requirements <f>]';

const readText = (file: string, option = '--brief-file'): string => {
  try { return readFileSync(file, 'utf8'); } catch (e) { throw new OperatorRefusal(`${option} ${file}: ${(e as Error).message}`); }
};

/** The job's own push requirements (issue #2555 part 3), read as the hopper reads a repository's requirements file. */
const requirementsOf = (file: string): PushRequirement[] => {
  const read = parseRequirements(readText(file, '--push-requirements'));
  if (!read.ok) throw new OperatorRefusal(`--push-requirements ${file}: ${read.problem}`);
  return read.requirements;
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
    authorize: { type: 'string', multiple: true }, repo: { type: 'string' }, executor: { type: 'string' }, priority: { type: 'string' }, 'promote-when-done': { type: 'boolean' },
    'push-requirements': { type: 'string' },
  } });
  if (positionals.length > 0 || !values.title || (values.brief === undefined) === (values['brief-file'] === undefined)) throw usage(SUBMIT);
  const priority = values.priority === undefined ? undefined : Number(values.priority);
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 100)) throw new OperatorRefusal(`--priority must be a whole number from 0 to 100, not ${values.priority}`);
  const brief = values.brief ?? readText(values['brief-file']!);
  const pushRequirements = values['push-requirements'] === undefined ? undefined : requirementsOf(values['push-requirements']);
  return { role: 'operator', path: '/ui/api/direct-jobs', body: async () => ({
    title: values.title, brief, labels: values.label ?? [], authorizations: values.authorize ?? [],
    ...(values.repo ? { repo: values.repo } : {}), ...(values.executor ? { executor: values.executor } : {}), ...(priority !== undefined ? { priority } : {}),
    ...(values['promote-when-done'] ? { promoteWhenDone: true } : {}), ...(pushRequirements ? { pushRequirements } : {}),
  }) };
}
