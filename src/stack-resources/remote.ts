// The sandbox boxes on client targets (issue #947, design.md "Stack resources"): a box the hopper started on a client
// target runs in that machine's own Podman (else Docker), which the hopper reaches only through the machine's client — the
// remote runtime (src/sandbox/remote.ts). Each machine a sandbox record names is read with the container meter
// (containers.ts), its calls carried down the machine's link; the client checks them again (src/client/runtime.ts): the
// list, and a box's inspect and one-shot stats. A meter is kept per machine between reads, so CPU is the use since the
// read before. A machine that cannot be read says why; the others are still read.
import type { RuntimeRelay, SandboxRecord } from '../domain/sandboxes.ts';
import type { ContainerMeter, MachineBoxes, RemoteBoxMeter } from '../domain/stack-resources.ts';
import { API as DOCKER_API } from '../sandbox/docker.ts';
import { API as PODMAN_API } from '../sandbox/podman.ts';
import { relayCall } from '../sandbox/remote.ts';
import { LOCAL } from '../sandbox/runtime.ts';
import { createContainerMeter } from './containers.ts';

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createRemoteBoxMeter(o: {
  instanceId: string;
  /** The sandbox records: the machines that hold a box, with the user each is a client target of. */
  records: () => readonly Pick<SandboxRecord, 'userId' | 'machine'>[];
  /** A user's client target by name: its runtime relay; undefined: none now. */
  clients: (userId: string, machine: string) => { relay: RuntimeRelay } | undefined;
  now?: () => number;
}): RemoteBoxMeter {
  /** Per user, machine and runtime kind: its meter, which keeps each box's CPU time between reads. */
  const meters = new Map<string, ContainerMeter>();

  const readOne = async (userId: string, machine: string, key: string): Promise<MachineBoxes> => {
    const target = o.clients(userId, machine);
    if (!target) return { machine, problem: `no client target ${machine} now: it was removed, or its user is gone` };
    const which = await target.relay.which();
    if ('problem' in which) return { machine, problem: which.problem };
    const at = `${key}\n${which.kind}`;
    let meter = meters.get(at);
    if (!meter) {
      meter = createContainerMeter({
        socket: '', self: '', instanceId: o.instanceId, machine, prefix: which.kind === 'podman' ? PODMAN_API : DOCKER_API,
        via: relayCall(target.relay), ...(o.now ? { now: o.now } : {}),
      });
      meters.set(at, meter);
    }
    const read = await meter.read();
    return 'problem' in read ? { machine, problem: read.problem } : { machine, containers: read.containers };
  };

  return {
    async read() {
      const machines = new Map<string, { userId: string; machine: string }>();
      for (const r of o.records()) if (r.machine !== LOCAL) machines.set(`${r.userId}\n${r.machine}`, { userId: r.userId, machine: r.machine });
      // A machine that holds no box any more forgets its meter.
      for (const at of meters.keys()) if (!machines.has(at.slice(0, at.lastIndexOf('\n')))) meters.delete(at);
      const read = await Promise.all([...machines].map(([key, m]) => readOne(m.userId, m.machine, key).catch((e: unknown) => ({ machine: m.machine, problem: why(e) }))));
      return read.sort((a, b) => a.machine.localeCompare(b.machine));
    },
  };
}
