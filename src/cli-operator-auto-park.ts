// `hopper auto-park [set …]` (issue #650): the auto-park timeouts from the operator CLI — the UI's own read, or
// `POST /ui/api/auto-park`. Moved out of cli-operator.ts as it is (issue #694), to keep that file in its size limit.
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

const AUTO_PARK_SET = 'auto-park set [--minutes <n>] [--high-priority-minutes <n>]';
const AUTO_PARK_USAGE = `auto-park | hopper ${AUTO_PARK_SET}`;

function minutesOf(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) throw new OperatorRefusal(`--${flag} must be a number of minutes; not ${raw}`);
  return n;
}

export function autoParkCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { minutes: { type: 'string' }, 'high-priority-minutes': { type: 'string' } } });
  const [verb, ...extra] = positionals;
  const minutes = minutesOf('minutes', values.minutes);
  const highPriorityMinutes = minutesOf('high-priority-minutes', values['high-priority-minutes']);
  if (verb === undefined && minutes === undefined && highPriorityMinutes === undefined) return { role: 'viewer', path: '/api/auto-park' };
  if (verb !== 'set' || extra.length > 0) throw usage(AUTO_PARK_USAGE);
  if (minutes === undefined && highPriorityMinutes === undefined) throw usage(AUTO_PARK_SET);
  return { role: 'admin', path: '/ui/api/auto-park', body: async () => ({ ...(minutes === undefined ? {} : { minutes }), ...(highPriorityMinutes === undefined ? {} : { highPriorityMinutes }) }) };
}
