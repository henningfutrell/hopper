// docker: a container target, a running container on this machine's docker reached through `docker
// exec` (design.md "Container targets", issue #58; a plugin since issue #74). No agent and no herdr runs
// in it: it runs commands only. Named after the instance; `docker` is command-bearing.
import type { ContainerMachine } from '../../../domain/types.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { attachedBase, attachedShape, reach, type AttachedOptions } from '../attached.ts';

export interface DockerOptions extends AttachedOptions { docker: string }

export const containerMachine = (name: string, o: DockerOptions): ContainerMachine => ({ ...attachedBase(name, o), docker: o.docker });

const docker: PluginDefinition<'machine-source', DockerOptions> = {
  id: 'docker',
  role: 'machine-source',
  describe: 'A container target: a running container reached through docker exec, running commands only',
  options: (z) => z.strictObject({
    docker: z.string().min(1).refine((s) => !s.startsWith('-'), 'docker must be a container, not an option')
      .meta({ commandBearing: true, description: 'the container\'s name or id' }),
    ...attachedShape(z, ['command']),
  }),
  async detect() { return { status: 'available' }; },
  create: (ctx, o) => reach(ctx, containerMachine(ctx.instanceName, o)),
};

export default docker;
