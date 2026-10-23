// Delivery forecasts from the command line (issue #2554 parts 2 and 3, design.md "Delivery forecasts"): `hopper forecast`
// reads GET /api/delivery-forecast for one job, issue or pull request — the step its change is in, and the expected end of
// each step left —, or for a promotion set of a repository by its number. With `--expedite on|off` (part 4) it sets the
// expedite flag of the change: POST /ui/api/delivery-expedite. With `--clear <step>` (part 5) it clears a delivery gate of
// a promotion set: POST /ui/api/delivery-gate. The daemon checks the names and answers 400 for a bad one.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';

export const FORECAST_USAGE = `  hopper forecast --job <id> | --issue <owner/repo#N> | --pr <url> | --set <N> --repo <owner/repo>
                                                     where the change (or the promotion set) is on its way to production, and
                                                     when each step left is expected to end (p50 and p90, from the
                                                     repository's measured steps and its promotion set schedule)
  hopper forecast --job <id> | --issue <owner/repo#N> | --pr <url> --expedite on|off
                                                     flag the change as expedited, or not: its forecast then shows the
                                                     expedited path beside the normal one
  hopper forecast --set <N> --repo <owner/repo> --clear <step>
                                                     clear the delivery gate at the step (test_gate, production or
                                                     promotion_set) of the promotion set: its changes go on past it`;

const LINE = 'forecast --job <id> | --issue <owner/repo#N> | --pr <url> [--expedite on|off] | --set <N> --repo <owner/repo> [--clear <step>]';

export function forecastCall(args: string[]): Call {
  let v;
  try {
    ({ values: v } = parseArgs({ args, strict: true, options: { job: { type: 'string' }, issue: { type: 'string' }, pr: { type: 'string' }, set: { type: 'string' }, repo: { type: 'string' }, expedite: { type: 'string' }, clear: { type: 'string' } } }));
  } catch {
    throw usage(LINE);
  }
  const named = (['job', 'issue', 'pr', 'set'] as const).filter((k) => v[k] !== undefined);
  if (named.length !== 1 || !v[named[0]!] || (named[0] === 'set') !== (v.repo !== undefined) || v.repo === '') throw usage(LINE);
  const k = named[0]!;
  if (v.clear !== undefined) {
    const set = Number(v.set);
    if (k !== 'set' || !v.clear || v.expedite !== undefined || !Number.isInteger(set)) throw usage(LINE);
    const body = { repo: v.repo!, set, step: v.clear };
    return { role: 'operator', path: '/ui/api/delivery-gate', post: async () => ({ path: '/ui/api/delivery-gate', body }) };
  }
  if (v.expedite !== undefined) {
    if (k === 'set' || (v.expedite !== 'on' && v.expedite !== 'off')) throw usage(LINE);
    const body = { [k]: v[k]!, expedite: v.expedite === 'on' };
    return { role: 'operator', path: '/ui/api/delivery-expedite', post: async () => ({ path: '/ui/api/delivery-expedite', body }) };
  }
  if (k === 'set') return { role: 'viewer', path: `/api/delivery-forecast?${new URLSearchParams({ set: v.set!, repo: v.repo! }).toString()}` };
  return { role: 'viewer', path: `/api/delivery-forecast?${new URLSearchParams({ [k]: v[k]! }).toString()}` };
}
