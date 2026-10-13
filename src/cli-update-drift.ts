// `hopper update drift` (issue #1017, design.md "Self-update"): how the running stack differs from the compose file of its
// version, GET /api/update/drift, read as the operator CLI reads the daemon, with no sign-in in a browser. A headless update
// checks the stack is whole after `compose up` by the exit code: 3 while a gap is open, else 0.
import { parseArgs } from 'node:util';
import type { StackDrift } from './domain/types.ts';
import { usage, type Call } from './cli-operator-call.ts';

export const DRIFT_USAGE = `  hopper update drift [--url <hopper URL>]           how the running stack differs from the compose file of its version,
                                                     as JSON; exit 3 while a gap is open, else 0. Run it after the update`;

/** Exit code of a drifted stack: not 1 (a failure) or 2 (a refusal). */
export const DRIFT_EXIT = 3;

export function driftCall(args: string[]): Call {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length !== 1 || positionals[0] !== 'drift') throw usage('update drift [--url <hopper URL>]');
  return { role: 'viewer', path: '/api/update/drift', exit: (d) => ((d as StackDrift).gaps.length > 0 ? DRIFT_EXIT : 0) };
}
