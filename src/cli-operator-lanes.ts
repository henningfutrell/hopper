// Lane tuning from the command line (issue #688, design.md "Lane tuning"): every machine's lane recommendation and the
// job cost profiles, as JSON — the routes the Machines view reads (GET /api/lanes/plan, GET /api/lanes/costs) —, one machine's settings, and an admin's apply, dismissal
// and undo of a machine's recommendation, each through the route the UI posts to.
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const LANES_USAGE = `  hopper lanes plan                                  every machine's lane recommendation: the lanes it can run, the configured lanes, why
  hopper lanes costs                                 the job cost profiles: what each finished job cost its machine, grouped by repository, kind and template
  hopper lanes tune <machine> [--auto on|off] [--min <n>] [--max <n>]
                                                     a machine's lane tuning: auto-tune on or off, the least and most lanes it may recommend
  hopper lanes apply <machine>                       apply a machine's lane recommendation: its configured lanes become the recommended lanes
  hopper lanes dismiss <machine>                     dismiss a machine's lane recommendation until it moves
  hopper lanes undo <machine>                        undo the last lane recommendation applied to a machine`;

const TUNE = 'lanes tune <machine> [--auto on|off] [--min <n>] [--max <n>]';
const ACTIONS: Readonly<Record<string, string>> = { apply: '/ui/api/lanes/apply', dismiss: '/ui/api/lanes/dismiss', undo: '/ui/api/lanes/undo' };

function lanesOf(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n)) throw new OperatorRefusal(`--${flag} must be a whole number of lanes; not ${raw}`);
  return n;
}

export function lanesCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { auto: { type: 'string' }, min: { type: 'string' }, max: { type: 'string' } } });
  const [verb, machineId, ...extra] = positionals;
  const flags = Object.keys(values).length;
  if ((verb === 'plan' || verb === 'costs') && machineId === undefined && flags === 0) return { role: 'viewer', path: `/api/lanes/${verb}` };
  const action = verb !== undefined && Object.hasOwn(ACTIONS, verb) ? ACTIONS[verb] : undefined;
  if (action && machineId && extra.length === 0 && flags === 0) return { role: 'admin', path: action, body: async () => ({ machineId }) };
  if (verb !== 'tune' || !machineId || extra.length > 0) throw usage(`lanes plan | hopper lanes costs | hopper ${TUNE} | hopper lanes apply|dismiss|undo <machine>`);
  if (values.auto !== undefined && values.auto !== 'on' && values.auto !== 'off') throw new OperatorRefusal(`--auto must be on or off; not ${values.auto}`);
  const minLanes = lanesOf('min', values.min);
  const maxLanes = lanesOf('max', values.max);
  if (flags === 0) throw usage(TUNE);
  return {
    role: 'admin', path: '/ui/api/lanes/tuning',
    body: async () => ({
      machineId, ...(values.auto === undefined ? {} : { autoTune: values.auto === 'on' }),
      ...(minLanes === undefined ? {} : { minLanes }), ...(maxLanes === undefined ? {} : { maxLanes }),
    }),
  };
}
