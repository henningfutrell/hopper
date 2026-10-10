// A user's job stream (issue #613, design.md "The job stream"): the stream types each part emits, registered here, over
// the user's store; a watch ends when its job does. With it, the user's artifacts (issue #624), which put each change
// of a job at work on its stream: they start and stop with it.
import type { Clock, UserStore } from '../domain/ports.ts';
import type { SealerState } from '../secrets/sealer.ts';
import { userArtifactKey } from './artifact-key.ts';
import { TERMINAL_STATUSES } from '../domain/types.ts';
import { createJobStream, createStreamTypes, registerHopperTypes, type JobStream } from '../job-stream/index.ts';
import { SKILL_STREAM_TYPES } from '../skills/index.ts';
import { ARTIFACT_STREAM_TYPES, createUserArtifacts, streamArtifactEvents, type UserArtifacts } from '../artifacts/index.ts';

type Options = {
  userId: string; store: UserStore; clock: Clock; logger: { warn(line: string): void }; inlineMax?: number;
  /** The hopper's sealer: the key the user's content URLs are signed under is kept with it (issue #673). */
  keys: SealerState;
};

/** The job stream, and the artifacts that emit on it: the stream's start and stop are theirs too (the retention sweep, the events). */
export function openJobStream(o: Options): { jobStream: JobStream; artifacts: UserArtifacts } {
  const stream = openStream(o);
  const artifacts = createUserArtifacts({
    userId: o.userId, store: o.store, clock: o.clock, logger: o.logger,
    contentKey: userArtifactKey({ userId: o.userId, store: o.store, keys: o.keys, clock: o.clock, logger: o.logger }),
  });
  let unsubscribe = (): void => {};
  const jobStream: JobStream = {
    ...stream,
    start() {
      stream.start();
      artifacts.start();
      unsubscribe = streamArtifactEvents({
        subscribe: (l) => o.store.events.subscribe(l), status: (id) => o.store.jobs.get(id)?.status,
        emit: (jobId, type, payload) => stream.emit(jobId, type, payload), log: (line) => o.logger.warn(line),
      });
    },
    stop() {
      unsubscribe();
      artifacts.stop();
      stream.stop();
    },
  };
  return { jobStream, artifacts };
}

function openStream(o: Options): JobStream {
  const types = createStreamTypes();
  registerHopperTypes(types);
  types.register('skill', SKILL_STREAM_TYPES);
  types.register('artifact', ARTIFACT_STREAM_TYPES);
  return createJobStream({
    repo: o.store.jobStream, types, clock: o.clock, log: (line) => o.logger.warn(line),
    ended(jobId) {
      const status = o.store.jobs.get(jobId)?.status;
      return status === undefined ? 'gone' : TERMINAL_STATUSES.includes(status) ? status : undefined;
    },
    ...(o.inlineMax !== undefined ? { inlineMax: o.inlineMax } : {}),
  });
}
