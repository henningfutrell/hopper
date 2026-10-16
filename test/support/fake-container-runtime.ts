// A container runtime double (issue #708), at the ContainerRuntime port: its containers and volumes, in memory. A copy
// into a box (issue #1004) is extracted into the directory it names, on this machine.
import { execFileSync } from 'node:child_process';
import type { ContainerInfo, ContainerRuntime, ContainerSpec, RuntimeKind } from '../../src/domain/ports.ts';

export interface FakeContainer { id: string; spec: ContainerSpec; state: string; ran?: Promise<{ exit: number; output: string }> }

export interface FakeContainerRuntime extends ContainerRuntime {
  /** By name. */
  boxes: Map<string, FakeContainer>;
  volumes: Set<string>;
  /** Each volume's labels, by name (issue #1371). */
  volumeLabels: Map<string, Record<string, string>>;
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
  /** Every copy into a box, in order: the box and the directory (issue #1004). */
  copies: { box: string; dir: string }[];
}

export function createFakeContainerRuntime(kind: RuntimeKind = 'podman'): FakeContainerRuntime {
  let n = 0;
  const byId = (id: string): FakeContainer | undefined => [...e.boxes.values()].find((c) => c.id === id || c.spec.name === id);
  const info = (c: FakeContainer): ContainerInfo => ({ id: c.id, name: c.spec.name, image: c.spec.image, labels: { ...c.spec.labels }, state: c.state });
  const e: FakeContainerRuntime = {
    kind, boxes: new Map(), volumes: new Set(), volumeLabels: new Map(), imageUsers: new Map(), images: new Map(), builds: 0, ran: new Map(), copies: [],
    put(spec) {
      const id = `ctr${++n}`;
      e.boxes.set(spec.name, { id, spec: structuredClone(spec), state: 'running' });
      e.volumes.add(spec.volume);
      e.volumeLabels.set(spec.volume, { ...spec.labels });
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
    async createVolume(name, labels) {
      if (e.volumes.has(name)) return false;
      e.volumes.add(name);
      e.volumeLabels.set(name, { ...labels });
      return true;
    },
    async removeVolume(name) { e.volumes.delete(name); e.volumeLabels.delete(name); },
    async listVolumes(labels = {}) {
      return [...e.volumes].filter((v) => Object.entries(labels).every(([k, x]) => e.volumeLabels.get(v)?.[k] === x));
    },
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
    async copyIn(id, dir, tar) {
      const c = byId(id);
      if (!c || c.state !== 'running') throw new Error(`the box ${id} is not running`);
      e.copies.push({ box: c.spec.name, dir });
      execFileSync('tar', ['-xf', tar, '-C', dir]);
    },
    async list(labels = {}) {
      return [...e.boxes.values()].filter((c) => Object.entries(labels).every(([k, v]) => c.spec.labels[k] === v)).map(info);
    },
  };
  return e;
}
