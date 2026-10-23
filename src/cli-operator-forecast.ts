// Delivery forecasts from the command line (issue #2554 part 2, design.md "Delivery forecasts"): `hopper forecast` reads
// GET /api/delivery-forecast for one job, issue or pull request — the step its change is in, and the expected end of each
// step left. The daemon checks the names and answers 400 for a bad one.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';

export const FORECAST_USAGE = `  hopper forecast --job <id> | --issue <owner/repo#N> | --pr <url>
                                                     where the change is on its way to production, and when each step left
                                                     is expected to end (p50 and p90, from the repository's measured steps)`;

const LINE = 'forecast --job <id> | --issue <owner/repo#N> | --pr <url>';

export function forecastCall(args: string[]): Call {
  let v;
  try {
    ({ values: v } = parseArgs({ args, strict: true, options: { job: { type: 'string' }, issue: { type: 'string' }, pr: { type: 'string' } } }));
  } catch {
    throw usage(LINE);
  }
  const named = (['job', 'issue', 'pr'] as const).filter((k) => v[k] !== undefined);
  if (named.length !== 1 || !v[named[0]!]) throw usage(LINE);
  const k = named[0]!;
  return { role: 'viewer', path: `/api/delivery-forecast?${new URLSearchParams({ [k]: v[k]! }).toString()}` };
}
