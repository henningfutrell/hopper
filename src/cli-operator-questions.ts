// The question actions from the command line (issues #374, #679): list the open questions, each with why it came to a
// person, answer, close or dismiss one.
import { parseArgs } from 'node:util';
import { ESCALATION_REASONS } from './domain/types.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export function questionCall(args: string[]): Call {
  if (args[0] === 'list') {
    const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { reason: { type: 'string' } } });
    if (positionals.length > 0) throw usage('question list [--reason <reason>]');
    const reason = values.reason;
    if (reason !== undefined && !(ESCALATION_REASONS as readonly string[]).includes(reason)) throw new OperatorRefusal(`unknown reason ${reason}; one of ${ESCALATION_REASONS.join(', ')}`);
    return { role: 'viewer', path: `/api/questions?status=open${reason ? `&reason=${reason}` : ''}`, pick: (v) => (v as { questions: unknown[] }).questions };
  }
  const [verb, id, ...rest] = args;
  if (verb === 'answer') {
    const answer = rest.join(' ').trim();
    if (!id || !answer) throw usage('question answer <id> <text>');
    return { role: 'operator', path: `/ui/api/questions/${encodeURIComponent(id)}/answer`, body: async () => ({ answer }) };
  }
  if ((verb === 'close' || verb === 'dismiss') && id && rest.length === 0) {
    return { role: 'operator', path: `/ui/api/questions/${encodeURIComponent(id)}/${verb}`, body: async () => ({}) };
  }
  throw usage('question list [--reason <reason>] | answer <id> <text> | close <id> | dismiss <id>');
}
