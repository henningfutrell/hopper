// What the attached-machine plugins share (design.md "Attached machines", issue #74): `ssh`, `docker`
// and `client` each make one attached machine of their instance, named after it. Its lanes, executors
// and label are plain options; how it is reached is command-bearing. The hopper
// reaches it through the machine-source context's `target`, never on its own.
import type { z as Z } from 'zod';
import type { AttachedMachine } from '../../domain/types.ts';
import type { DiskThresholds } from '../../domain/machines.ts';
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
 * When a machine's disk is low (issue #410): below either threshold it takes no new job. Plain options,
 * read at every list, so a change applies at the next Decision. Not on a container target, whose disk is not read.
 */
export const diskLowShape = (z: typeof Z) => ({
  diskLowBelowGiB: z.number().positive().optional()
    .meta({ description: 'its disk is low below this many GiB free (default 5); a machine with a low disk takes no new job' }),
  diskLowBelowPercent: z.number().min(0).max(100).optional()
    .meta({ description: 'its disk is low below this share free, in percent (default 10); a machine with a low disk takes no new job' }),
});

/** The thresholds the disk options set; undefined when neither is. */
export const diskLowOf = (o: { diskLowBelowGiB?: number; diskLowBelowPercent?: number }): DiskThresholds | undefined =>
  (o.diskLowBelowGiB === undefined && o.diskLowBelowPercent === undefined ? undefined : {
    ...(o.diskLowBelowGiB !== undefined ? { belowGiB: o.diskLowBelowGiB } : {}),
    ...(o.diskLowBelowPercent !== undefined ? { belowPercent: o.diskLowBelowPercent } : {}),
  });

/** The options every attached machine has; `executors` defaults to what its connection runs. */
export function attachedShape(z: typeof Z, executors: readonly string[]) {
  return {
    label: z.string().min(1).optional().meta({ description: 'shown instead of the name' }),
    lanes: z.number().int().min(1, 'lanes must be at least 1').default(1).meta({ description: 'jobs it runs at once' }),
    executors: z.array(z.string().min(1)).default([...executors]).meta({ description: 'executor instances that run there' }),
  };
}

export interface AttachedOptions { label?: string; lanes: number; executors: string[]; workTree?: string; diskLowBelowGiB?: number; diskLowBelowPercent?: number }

/** The plain fields of an attached machine named `name`. */
export const attachedBase = (name: string, o: AttachedOptions) => {
  const diskLow = diskLowOf(o);
  return {
    name, ...(o.label !== undefined ? { label: o.label } : {}), lanes: o.lanes, executors: [...o.executors], ...(o.workTree !== undefined ? { workTree: o.workTree } : {}),
    ...(diskLow ? { diskLow } : {}),
  };
};

/** An attached machine's source: the host reaches it. */
export const reach = (ctx: MachineSourceContext, machine: AttachedMachine): MachineSource => ctx.target(machine);
