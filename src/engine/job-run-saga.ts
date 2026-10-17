// The `job-run` saga kind (issue #1662, job-run.ts): a job's run, step by step, on whichever hopper holds the saga. Each
// step is the runner's of the job's user (`Engine.jobRunStep`); while the user's runtime is not loaded, it is tried again
// later. Its steps are tried as long as a job runs: a stop, a crash or a takeover counts a try, and no step is undone —
// a run that cannot go on ends through its outcome, never through a compensation.
import type { SagaDefinition, SagaStepContext } from '../sagas/coordinator.ts';
import type { Engine } from './index.ts';
import { JOB_RUN_SAGA, JOB_RUN_STEPS } from './job-run.ts';

/** About a week of tries, most of them five minutes apart (`sagaBackoffMs`), as the `job-move` saga's. */
export const JOB_RUN_STEP_ATTEMPTS = 2_100;

/** `engine`: the engine of a user, undefined while the user's runtime is not loaded. */
export function jobRunSaga(o: { engine(userId: string): Pick<Engine, 'jobRunStep'> | undefined }): SagaDefinition {
  const step = (name: string) => async (c: SagaStepContext): Promise<Record<string, unknown>> => {
    const engine = c.saga.userId !== undefined ? o.engine(c.saga.userId) : undefined;
    if (!engine) throw new Error(`the runtime of user ${c.saga.userId ?? '(none)'} is not loaded`);
    return engine.jobRunStep(name, c);
  };
  return { kind: JOB_RUN_SAGA, steps: JOB_RUN_STEPS.map((name) => ({ name, do: step(name), attempts: JOB_RUN_STEP_ATTEMPTS })) };
}
