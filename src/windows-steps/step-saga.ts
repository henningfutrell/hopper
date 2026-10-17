// The `windows-step` saga (issue #1611, design.md "Sagas: work that survives a stop"): a Windows sandbox step, run from
// its row in the Windows steps on whichever host holds the saga. Two steps: `run` takes the host lease, runs the step
// and keeps its result, once per step (service.ts); `sweep` removes the host's scratch directory and lets the host go,
// which a stop between the two would leave. The compensation of each sweeps the host as far as it can, lets it go, and
// ends a step not ended as cancelled.
import type { SagaDefinition, SagaStepContext } from '../sagas/coordinator.ts';
import type { WindowsSteps } from './service.ts';

export const WINDOWS_STEP_SAGA = 'windows-step';

type Steps = Pick<WindowsSteps, 'run' | 'sweepHost' | 'cancel'>;

/** `steps`: the Windows steps of a user, undefined while the user's runtime is not loaded (the saga tries again later). */
export function windowsStepSaga(o: { steps(userId: string): Steps | undefined }): SagaDefinition {
  const of = (c: SagaStepContext): { steps: Steps; step: string } => {
    const steps = c.saga.userId !== undefined ? o.steps(c.saga.userId) : undefined;
    if (!steps) throw new Error(`the runtime of user ${c.saga.userId ?? '(none)'} is not loaded`);
    return { steps, step: String(c.data.step) };
  };
  const cancel = async (c: SagaStepContext): Promise<void> => { const { steps, step } = of(c); await steps.cancel(step, c.saga.error ?? 'aborted'); };
  return {
    kind: WINDOWS_STEP_SAGA,
    steps: [
      { name: 'run', do: async (c) => { const { steps, step } = of(c); await steps.run(step, c.signal); }, compensate: cancel },
      { name: 'sweep', do: async (c) => { const { steps, step } = of(c); await steps.sweepHost(step); }, compensate: cancel },
    ],
  };
}
