// Step schedules from the command line (issue #2716, design.md "Step schedules"): `hopper schedule save` saves a box step
// the hopper runs each day with no job, `list` lists them (GET /api/step-schedules), `runs` one schedule's runs with their
// output, `run` runs it now, `grant` and `revoke` give or take back its vault grant, and `remove` removes it — each act
// POST /ui/api/step-schedules, as on the API.
import { parseArgs } from 'node:util';
import type { StepScheduleRunsView, StepSchedulesView } from './domain/step-schedules.ts';
import { usage, type Call } from './cli-operator-call.ts';

export const SCHEDULE_USAGE = `  hopper schedule save <name> --template <t> --repo <owner/name> [--input <folder>] --script <file>
                       --daily <HH:MM> --timeout <seconds>
                                                     a box step the hopper runs each day at HH:MM UTC, with no job: the script,
                                                     a file of the folder at the repository's default branch, in a new sandbox
                                                     of the template (--input: default the script's folder)
  hopper schedule list                               the step schedules, each with its next due time and its newest run
  hopper schedule runs <name>                        a schedule's runs, newest first, with their output
  hopper schedule run <name>                         run it now, once
  hopper schedule grant <name>                       give it the vault: its runs get the vault secrets its template gives
  hopper schedule revoke <name>                      take its vault grant back
  hopper schedule remove <name>                      remove it and its runs`;

const LINE = 'schedule save <name> --template <t> --repo <owner/name> [--input <folder>] --script <file> --daily <HH:MM> --timeout <seconds> | schedule list | schedule runs|run|grant|revoke|remove <name>';

const ACTS = ['run', 'grant', 'revoke', 'remove'] as const;

export function scheduleCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    template: { type: 'string' }, repo: { type: 'string' }, input: { type: 'string' }, script: { type: 'string' }, daily: { type: 'string' }, timeout: { type: 'string' },
  } });
  const [verb, name, ...extra] = positionals;
  const flags = Object.keys(values).length > 0;
  if (extra.length > 0) throw usage(LINE);
  if (verb === 'list' && name === undefined && !flags) {
    return { role: 'viewer', path: '/api/step-schedules', pick: (v) => (v as StepSchedulesView).schedules };
  }
  if (verb === 'runs' && name && !flags) {
    return { role: 'viewer', path: `/api/step-schedules/${encodeURIComponent(name)}`, pick: (v) => (v as StepScheduleRunsView).runs };
  }
  if (verb === 'save' && name) {
    const { template, repo, input, script, daily, timeout } = values;
    const seconds = Number(timeout);
    if (!template || !repo || !script || !daily || timeout === undefined || !Number.isInteger(seconds)) throw usage(LINE);
    return { role: 'operator', path: '/ui/api/step-schedules', body: async () => ({ action: 'save', name, template, repo, ...(input ? { input } : {}), script, daily, timeoutSeconds: seconds }) };
  }
  const act = ACTS.find((a) => a === verb);
  if (!act || !name || flags) throw usage(LINE);
  return { role: 'operator', path: '/ui/api/step-schedules', body: async () => ({ action: act, name }) };
}
