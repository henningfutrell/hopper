// container: a container target (design.md "Container targets", issues #58, #865). No agent and no herdr runs on it: it
// runs commands only, each in a one-shot sandbox box of its image that the sandbox module starts beside the hopper (or on
// a client target of the user's with a container runtime), on no network, and burns after the command. Named after the
// instance; `image` is command-bearing.
import type { ContainerMachine } from '../../../domain/types.ts';
import { BOX_IMAGE } from '../../../sandbox/box-image.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { attachedBase, attachedShape, reach, type AttachedOptions } from '../attached.ts';

/** A command box's image when an instance names none: the published box image a template starts from. */
export const CONTAINER_IMAGE = `${BOX_IMAGE}:box-claude`;

export interface ContainerOptions extends AttachedOptions { image: string }

export const containerMachine = (name: string, o: ContainerOptions): ContainerMachine => ({ ...attachedBase(name, o), image: o.image });

const container: PluginDefinition<'machine-source', ContainerOptions> = {
  id: 'container',
  role: 'machine-source',
  describe: 'A container target: runs commands only, each in a one-shot sandbox box of its image, with no network',
  options: (z) => z.strictObject({
    image: z.string().min(1).refine((s) => !s.startsWith('-'), 'image must be an image, not an option').default(CONTAINER_IMAGE)
      .meta({ commandBearing: true, description: 'the image each command runs in; it must run as a user other than root' }),
    ...attachedShape(z, ['command']),
  }),
  async detect() { return { status: 'available' }; },
  create: (ctx, o) => reach(ctx, containerMachine(ctx.instanceName, o)),
};

export default container;
