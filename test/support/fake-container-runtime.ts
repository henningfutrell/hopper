// A container runtime double (issue #708), at the ContainerRuntime port: its containers and volumes, in memory. A box
// it "starts" does not join by itself: a test joins it with the join line its spec carries, as the box's client would.
import type { ContainerInfo, ContainerRuntime, ContainerSpec, RuntimeKind } from '../../src/domain/ports.ts';

export interface FakeContainer { id: string; spec: ContainerSpec; state: string; ran?: Promise<{ exit: number; output: string }> }

export interface FakeContainerRuntime extends ContainerRuntime {
  /** By name. */
  boxes: Map<string, FakeContainer>;
  volumes: Set<string>;
  /** The images it built (issue #716), by tag: the Containerfile of each. */
  images: Map<string, string>;
  /** How many builds it ran: a build of an image that is there already runs none. */
  builds: number;
  /** Set: every build fails with this reason. */
  buildFails?: string;
  /** The user each image runs as; an image not named runs as `agent`. */
  imageUsers: Map<string, string>;
  /** Set: why the runtime cannot be used. */
  down?: string;
  /** Set: every remove fails with this reason. */
  removeFails?: string;
  /** Set: every create fails with this reason. */
  createFails?: string;
  /**
   * Runs a one-shot container's script (issue #716, the read-only check), as it would in the box: its exit code and what it
   * wrote. Absent: it writes nothing and ends with 0. test/support/fake-cloud-tools.ts gives one.
   */
  runScript?: (spec: ContainerSpec) => Promise<{ exit: number; output: string }>;
  /** Every one-shot container it ran, by name: its spec, kept after it is removed. */
  ran: Map<string, ContainerSpec>;
  /** Put a container there as someone else (or the hopper before a restart) made it. */
  put(spec: ContainerSpec): string;
}

export function createFakeContainerRuntime(kind: RuntimeKind = 'podman'): FakeContainerRuntime {
  let n = 0;
  const byId = (id: string): FakeContainer | undefined => [...e.boxes.values()].find((c) => c.id === id || c.spec.name === id);
  const info = (c: FakeContainer): ContainerInfo => ({ id: c.id, name: c.spec.name, image: c.spec.image, labels: { ...c.spec.labels }, state: c.state });
  const e: FakeContainerRuntime = {
    kind, boxes: new Map(), volumes: new Set(), imageUsers: new Map(), images: new Map(), builds: 0, ran: new Map(),
    put(spec) {
      const id = `ctr${++n}`;
      e.boxes.set(spec.name, { id, spec: structuredClone(spec), state: 'running' });
      e.volumes.add(spec.volume);
      return id;
    },
    async problem() { return e.down; },
    async pull(image) { return { user: e.imageUsers.get(image) ?? 'agent', id: `sha256:${image}` }; },
    async build(tag, containerfile) {
      if (e.images.has(tag)) return;
      if (e.buildFails) throw new Error(e.buildFails);
      e.images.set(tag, containerfile);
      e.builds++;
    },
    async createVolume(name) { const made = !e.volumes.has(name); e.volumes.add(name); return made; },
    async removeVolume(name) { e.volumes.delete(name); },
    async create(spec) {
      if (e.createFails) throw new Error(e.createFails);
      if (e.boxes.has(spec.name)) throw new Error(`the name ${spec.name} is in use`);
      const id = `ctr${++n}`;
      e.boxes.set(spec.name, { id, spec: structuredClone(spec), state: 'created' });
      return id;
    },
    async start(id) {
      const c = byId(id)!;
      c.state = 'running';
      if (c.spec.script === undefined) return;
      e.ran.set(c.spec.name, structuredClone(c.spec));
      c.ran = (e.runScript?.(c.spec) ?? Promise.resolve({ exit: 0, output: '' })).then((r) => { c.state = 'exited'; return r; });
    },
    async wait(id) {
      const ran = byId(id)?.ran;
      if (!ran) throw new Error(`no one-shot container ${id}`);
      return (await ran).exit;
    },
    async logs(id) { return (await byId(id)?.ran)?.output ?? ''; },
    async inspect(id) { const c = byId(id); return c ? info(c) : undefined; },
    async stop(id) { const c = byId(id); if (c) c.state = 'exited'; },
    async remove(id) {
      if (e.removeFails) throw new Error(e.removeFails);
      const c = byId(id);
      if (c) e.boxes.delete(c.spec.name);
    },
    async list(labels = {}) {
      return [...e.boxes.values()].filter((c) => Object.entries(labels).every(([k, v]) => c.spec.labels[k] === v)).map(info);
    },
  };
  return e;
}
