// What the attached-machine plugins share (design.md "Attached machines", issue #74): `ssh`, `docker`
// and `client` each make one attached machine of their instance, named after it. Its lanes, executors
// and label are plain options; how it is reached is command-bearing. The hopper
// reaches it through the machine-source context's `target`, never on its own.
import type { z as Z } from 'zod';
import type { AttachedMachine } from '../../domain/types.ts';
import type { MachineSource, MachineSourceContext } from '../sdk.ts';

/**
 * A machine's default work tree (issue #324): an absolute path or one under `~`, which resolves on that
 * machine. Command-bearing: it is where its jobs' commands run. Not on a container target, whose
 * command jobs take no work tree.
 */
export const workTreeOption = (z: typeof Z) => z.string().min(1)
  .refine((s) => s.startsWith('/') || s === '~' || s.startsWith('~/'), 'workTree must be an absolute path or start with ~')
  .optional().meta({ commandBearing: true, description: 'the default work tree of jobs here that name none of their own; ~ is this machine\'s home' });

/**
 * Lanes kept for jobs pinned to the machine (issue #372): jobs with no machine pin use at most its lane
 * cap less these. At or above its lanes, only jobs pinned to it run there.
 */
export const reservedLanesOption = (z: typeof Z) => z.number().int().min(0, 'reservedLanes must not be negative').optional()
  .meta({ description: 'lanes kept for jobs pinned to this machine; jobs that could run anywhere do not take them' });

/** The options every attached machine has; `executors` defaults to what its connection runs. */
export function attachedShape(z: typeof Z, executors: readonly string[]) {
  return {
    label: z.string().min(1).optional().meta({ description: 'shown instead of the name' }),
    lanes: z.number().int().min(1, 'lanes must be at least 1').default(1).meta({ description: 'jobs it runs at once' }),
    reservedLanes: reservedLanesOption(z),
    executors: z.array(z.string().min(1)).default([...executors]).meta({ description: 'executor instances that run there' }),
  };
}

export interface AttachedOptions { label?: string; lanes: number; reservedLanes?: number; executors: string[]; workTree?: string }

/** The plain fields of an attached machine named `name`. */
export const attachedBase = (name: string, o: AttachedOptions) => ({
  name, ...(o.label !== undefined ? { label: o.label } : {}), lanes: o.lanes, ...(o.reservedLanes !== undefined ? { reservedLanes: o.reservedLanes } : {}), executors: [...o.executors], ...(o.workTree !== undefined ? { workTree: o.workTree } : {}),
});

/** An attached machine's source: the host reaches it. */
export const reach = (ctx: MachineSourceContext, machine: AttachedMachine): MachineSource => ctx.target(machine);
