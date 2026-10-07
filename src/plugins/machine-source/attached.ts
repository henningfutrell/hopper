// What the attached-machine plugins share (design.md "Attached machines", issue #74): `ssh`, `docker`
// and `client` each make one attached machine of their instance, named after it. Its lanes, executors
// and label are plain options; how it is reached is command-bearing. The hopper
// reaches it through the machine-source context's `target`, never on its own.
import type { z as Z } from 'zod';
import type { AttachedMachine } from '../../domain/types.ts';
import type { MachineSource, MachineSourceContext } from '../sdk.ts';

/**
 * A machine's work tree (issues #324, #361): an absolute path or one under `~`, which resolves on that
 * machine. The hopper makes it there and puts each job's repository in it. Command-bearing: it is where
 * its jobs' commands run. Not on a container target, whose command jobs take no work tree.
 */
export const workTreeOption = (z: typeof Z) => z.string().min(1)
  .refine((s) => s.startsWith('/') || s === '~' || s.startsWith('~/'), 'workTree must be an absolute path or start with ~')
  .optional().meta({ commandBearing: true, description: 'where its jobs run, made by the hopper, each job\'s repository fetched or cloned in it; ~ is this machine\'s home. Absent: ~/hopper-jobs' });

/** The options every attached machine has; `executors` defaults to what its connection runs. */
export function attachedShape(z: typeof Z, executors: readonly string[]) {
  return {
    label: z.string().min(1).optional().meta({ description: 'shown instead of the name' }),
    lanes: z.number().int().min(1, 'lanes must be at least 1').default(1).meta({ description: 'jobs it runs at once' }),
    executors: z.array(z.string().min(1)).default([...executors]).meta({ description: 'executor instances that run there' }),
  };
}

export interface AttachedOptions { label?: string; lanes: number; executors: string[]; workTree?: string }

/** The plain fields of an attached machine named `name`. */
export const attachedBase = (name: string, o: AttachedOptions) => ({
  name, ...(o.label !== undefined ? { label: o.label } : {}), lanes: o.lanes, executors: [...o.executors], ...(o.workTree !== undefined ? { workTree: o.workTree } : {}),
});

/** An attached machine's source: the host reaches it. */
export const reach = (ctx: MachineSourceContext, machine: AttachedMachine): MachineSource => ctx.target(machine);
