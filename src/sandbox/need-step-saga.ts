// The `need-step` saga (issues #1524, #1568, design.md "Sagas: work that survives a stop"): a need step or a box
// step, run from its row in the need steps on whichever host holds the saga. Two steps: `run` mints the step's
// credentials, runs its need box and keeps its result, once per step (need-steps.ts); `release` ends the credentials
// minted for the need box, which a stop between the two would leave. The compensation of `run` ends the credentials and
// ends a step not ended as cancelled; the sandbox module's sweep burns a need box that a stopped hopper left.
import type { SagaDefinition, SagaStepContext } from '../sagas/coordinator.ts';
import type { NeedSteps } from './need-steps.ts';

export const NEED_STEP_SAGA = 'need-step';

/** `steps`: the need steps of a user, undefined while the user's runtime is not loaded (the saga tries again later). */
export function needStepSaga(o: { steps(userId: string): Pick<NeedSteps, 'run' | 'release' | 'cancel'> | undefined }): SagaDefinition {
  const of = (c: SagaStepContext): { steps: Pick<NeedSteps, 'run' | 'release' | 'cancel'>; step: string } => {
    const steps = c.saga.userId !== undefined ? o.steps(c.saga.userId) : undefined;
    if (!steps) throw new Error(`the runtime of user ${c.saga.userId ?? '(none)'} is not loaded`);
    return { steps, step: String(c.data.step) };
  };
  return {
    kind: NEED_STEP_SAGA,
    steps: [
      {
        name: 'run',
        do: async (c) => { const { steps, step } = of(c); await steps.run(step, c.signal); },
        compensate: async (c) => { const { steps, step } = of(c); await steps.cancel(step, c.saga.error ?? 'aborted'); },
      },
      { name: 'release', do: async (c) => { const { steps, step } = of(c); await steps.release(step); } },
    ],
  };
}
