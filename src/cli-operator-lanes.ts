// Lane tuning from the command line (issue #688, design.md "Lane tuning"): every machine's lane recommendation, as JSON
// — the route the Machines view reads (GET /api/lanes/plan) —, and one machine's settings, as the UI sets them.
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const LANES_USAGE = `  hopper lanes plan                                  every machine's lane recommendation: the lanes it can run, the configured lanes, why
  hopper lanes tune <machine> [--auto on|off] [--min <n>] [--max <n>]
                                                     a machine's lane tuning: auto-tune on or off, the least and most lanes it may recommend`;

const TUNE = 'lanes tune <machine> [--auto on|off] [--min <n>] [--max <n>]';

function lanesOf(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n)) throw new OperatorRefusal(`--${flag} must be a whole number of lanes; not ${raw}`);
  return n;
}

export function lanesCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { auto: { type: 'string' }, min: { type: 'string' }, max: { type: 'string' } } });
  const [verb, machineId, ...extra] = positionals;
  if (verb === 'plan' && machineId === undefined && Object.keys(values).length === 0) return { role: 'viewer', path: '/api/lanes/plan' };
  if (verb !== 'tune' || !machineId || extra.length > 0) throw usage(`lanes plan | hopper ${TUNE}`);
  if (values.auto !== undefined && values.auto !== 'on' && values.auto !== 'off') throw new OperatorRefusal(`--auto must be on or off; not ${values.auto}`);
  const minLanes = lanesOf('min', values.min);
  const maxLanes = lanesOf('max', values.max);
  if (values.auto === undefined && minLanes === undefined && maxLanes === undefined) throw usage(TUNE);
  return {
    role: 'admin', path: '/ui/api/lanes/tuning',
    body: async () => ({
      machineId, ...(values.auto === undefined ? {} : { autoTune: values.auto === 'on' }),
      ...(minLanes === undefined ? {} : { minLanes }), ...(maxLanes === undefined ? {} : { maxLanes }),
    }),
  };
}
