// The `scheduled-run` saga (issue #2716, design.md "Step schedules"): one run of a step schedule, run from its row on
// whichever host holds the saga. One step: `run` reads the files and the secrets, runs the need box and ends the run, once
// (service.ts); a try after a stop finds the need box started in the sandbox runs ledger and ends the run `interrupted`.
// Its compensation ends a run not ended as failed; the sandbox module's sweep burns a need box a stopped hopper left.
import type { SagaDefinition, SagaStepContext } from '../sagas/coordinator.ts';
import type { StepSchedules } from './service.ts';

export const SCHEDULED_RUN_SAGA = 'scheduled-run';

/** `schedules`: a user's step schedules, undefined while the user's runtime is not loaded (the saga tries again later). */
export function scheduledRunSaga(o: { schedules(userId: string): Pick<StepSchedules, 'execute' | 'cancel'> | undefined }): SagaDefinition {
  const of = (c: SagaStepContext): { schedules: Pick<StepSchedules, 'execute' | 'cancel'>; run: string } => {
    const schedules = c.saga.userId !== undefined ? o.schedules(c.saga.userId) : undefined;
    if (!schedules) throw new Error(`the runtime of user ${c.saga.userId ?? '(none)'} is not loaded`);
    return { schedules, run: String(c.data.run) };
  };
  return {
    kind: SCHEDULED_RUN_SAGA,
    steps: [{
      name: 'run',
      do: async (c) => { const { schedules, run } = of(c); await schedules.execute(run, c.signal); },
      compensate: async (c) => { const { schedules, run } = of(c); await schedules.cancel(run, c.saga.error ?? 'aborted'); },
    }],
  };
}
