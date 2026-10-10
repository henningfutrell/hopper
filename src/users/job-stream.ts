// A user's job stream (issue #613, design.md "The job stream"): the stream types each part emits, registered here, over
// the user's store; a watch ends when its job does.
import type { Clock, UserStore } from '../domain/ports.ts';
import { TERMINAL_STATUSES } from '../domain/types.ts';
import { createJobStream, createStreamTypes, registerHopperTypes, type JobStream } from '../job-stream/index.ts';
import { SKILL_STREAM_TYPES } from '../skills/index.ts';

export function openJobStream(o: { store: UserStore; clock: Clock; logger: { warn(line: string): void }; inlineMax?: number }): JobStream {
  const types = createStreamTypes();
  registerHopperTypes(types);
  types.register('skill', SKILL_STREAM_TYPES);
  return createJobStream({
    repo: o.store.jobStream, types, clock: o.clock, log: (line) => o.logger.warn(line),
    ended(jobId) {
      const status = o.store.jobs.get(jobId)?.status;
      return status === undefined ? 'gone' : TERMINAL_STATUSES.includes(status) ? status : undefined;
    },
    ...(o.inlineMax !== undefined ? { inlineMax: o.inlineMax } : {}),
  });
}
