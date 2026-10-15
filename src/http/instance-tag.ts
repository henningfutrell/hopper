// The instance tag (issue #1295, design.md "Which hopper answers"): every answer names the hopper that gave it, in
// `x-hopper-instance`, and the event stream opens with it. A test hopper a job started took the address of the user's
// hopper while that one was down, and the page open on it read the test hopper's state as its own; the page now drops
// an answer whose tag is not its hopper's (ui/src/lib/instance.ts). The tag is a hash of the instance id, so it says
// nothing of the id itself (the id names the instance's containers). It is no proof: a hopper a job changed can send
// any tag.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export const INSTANCE_HEADER = 'x-hopper-instance';
/** The event stream's first event: the tag, as JSON. */
export const INSTANCE_EVENT = 'hopper.instance';

/** The tag of the instance with this id: 16 hex characters. */
export const instanceTagOf = (instanceId: string): string =>
  createHash('sha256').update(`hopper-instance\0${instanceId}`).digest('hex').slice(0, 16);

/** The tag on every answer, the refusals of the guards after it included. Set on the raw response, so a hijacked one (the event stream) has it too. */
export function installInstanceTag(app: FastifyInstance, tag: string): void {
  app.addHook('onRequest', async (_req, reply) => { reply.raw.setHeader(INSTANCE_HEADER, tag); });
}
