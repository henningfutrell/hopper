// Dismiss failed jobs from the operator CLI (issue #1123, design.md "Locked entries"): the failed jobs named, or every one
// nothing waits on any more — a newer job of its item, or its item closed —, in one `POST /ui/api/jobs/dismiss`.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';

export const DISMISS_USAGE = `  hopper job dismiss <id>...                         take failed jobs out of the queue's locked entries; they stay failed and can run again
  hopper job dismiss --superseded                    dismiss now every failed job nothing waits on: a newer job of its item, or its item closed`;

export function dismissCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { superseded: { type: 'boolean' } } });
  if ((values.superseded === true) === (positionals.length > 0)) throw usage('job dismiss <id>... | --superseded');
  return { role: 'operator', path: '/ui/api/jobs/dismiss', body: async () => (values.superseded ? { superseded: true } : { jobIds: positionals }) };
}
