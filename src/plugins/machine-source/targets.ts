// An instance of an attached-machine plugin as the attached machine it names (issue #74): what pins
// host keys and probes it. Any other machine-source plugin is not an attached machine.
import type { AttachedMachine, InstanceSpec } from '../../domain/types.ts';
import { parseOptions } from '../options.ts';
import client, { clientMachine, type ClientOptions } from './client/index.ts';
import docker, { containerMachine, type DockerOptions } from './docker/index.ts';
import ssh, { sshMachine, type SshOptions } from './ssh/index.ts';

const MAKE = {
  ssh: { def: ssh, make: (name: string, o: Record<string, unknown>) => sshMachine(name, o as unknown as SshOptions) },
  docker: { def: docker, make: (name: string, o: Record<string, unknown>) => containerMachine(name, o as unknown as DockerOptions) },
  client: { def: client, make: (name: string, o: Record<string, unknown>) => clientMachine(name, o as unknown as ClientOptions) },
} as const;

/** The attached machine `spec` names; undefined for any other plugin. Throws, with the reason, on options it refuses. */
export function targetOf(spec: InstanceSpec): AttachedMachine | undefined {
  const t = (MAKE as Record<string, (typeof MAKE)[keyof typeof MAKE] | undefined>)[spec.plugin];
  if (!t) return undefined;
  const parsed = parseOptions(t.def, spec.options ?? {});
  if (!parsed.ok) throw new Error(parsed.error);
  return t.make(spec.name, parsed.options);
}
