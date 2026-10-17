// The `job-move` saga (issue #1569, design.md "The lost-machine move"): a running job moved off a machine that stayed away
// resumes elsewhere at once, but the agent it left there may still run. One step, `end-left`, ends that agent once the machine
// answers: tried again with the saga's backoff (at most five minutes apart) for about a week, on whichever host holds the
// saga, so a hopper that stops meanwhile loses nothing. The step is idempotent: a pane already gone, or the job's own pane
// now, ends nothing. Nothing to compensate: past its tries the saga ends, and the sweep stops what is left.
import type { Engine } from './index.ts';
import type { SagaDefinition, SagaStepContext } from '../sagas/coordinator.ts';
import { JOB_MOVE_SAGA, type JobMoveData } from './lost-move.ts';

/** About a week of tries, most of them five minutes apart (`sagaBackoffMs`). */
export const END_LEFT_ATTEMPTS = 2_100;

/** `engine`: the engine of a user, undefined while the user's runtime is not loaded (the step tries again later). */
export function jobMoveSaga(o: { engine(userId: string): Pick<Engine, 'endLeft'> | undefined }): SagaDefinition {
  const endLeft = async (c: SagaStepContext): Promise<void> => {
    const engine = c.saga.userId !== undefined ? o.engine(c.saga.userId) : undefined;
    if (!engine) throw new Error(`the runtime of user ${c.saga.userId ?? '(none)'} is not loaded`);
    const data = c.data as unknown as JobMoveData;
    await engine.endLeft(data.jobId, data.left);
  };
  return { kind: JOB_MOVE_SAGA, steps: [{ name: 'end-left', do: endLeft, attempts: END_LEFT_ATTEMPTS }] };
}
