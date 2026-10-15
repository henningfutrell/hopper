// A container runtime double (issue #708), at the ContainerRuntime port: its containers and volumes, in memory. A box
// it "starts" does not join by itself: a test joins it with the join line its spec carries, as the box's client would.
// A command run in a box (issue #1004, a box step) runs on this machine, with a directory of its own as the box's HOME.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /**
   * Set: every box's start check fails with this output. Unset: the check fetches the hopper at the box's `check` URL, as
   * the box's own check would (issue #708).
   */
  unreachable?: string;
  /** How many start checks it ran. */
  checks: number;
  /** Put a container there as someone else (or the hopper before a restart) made it. */
  put(spec: ContainerSpec): string;
  /** Each box's HOME on this machine, by name (issue #1004): made at its first command. */
  homes: Map<string, string>;
  /** Every command run in a box, in order: the box, the command and its environment (issue #1004). */
  execs: { box: string; cmd: string[]; env: Record<string, string> }[];
  /** Every copy into a box, in order: the box and the directory (issue #1004). */
  copies: { box: string; dir: string }[];
}

export function createFakeContainerRuntime(kind: RuntimeKind = 'podman'): FakeContainerRuntime {
  let n = 0;
  const byId = (id: string): FakeContainer | undefined => [...e.boxes.values()].find((c) => c.id === id || c.spec.name === id);
  const homeOf = (name: string): string => {
    let home = e.homes.get(name);
    if (!home) { home = mkdtempSync(join(tmpdir(), 'box-home-')); e.homes.set(name, home); }
    return home;
  };
  const info = (c: FakeContainer): ContainerInfo => ({ id: c.id, name: c.spec.name, image: c.spec.image, labels: { ...c.spec.labels }, state: c.state });
  const e: FakeContainerRuntime = {
    kind, boxes: new Map(), volumes: new Set(), volumeLabels: new Map(), imageUsers: new Map(), images: new Map(), builds: 0, ran: new Map(), checks: 0, homes: new Map(), execs: [], copies: [],
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
    async startCheck(id) {
      const c = byId(id);
      if (!c) return { passed: false, output: 'the box is gone' };
      if (c.spec.check === undefined) return undefined;
      e.checks++;
      if (c.state !== 'running') return { passed: false, output: `the box is ${c.state}, not running` };
      if (e.unreachable !== undefined) return { passed: false, output: e.unreachable };
      const r = await fetch(`${c.spec.check}/client/install`).catch((err: unknown) => err as Error);
      return r instanceof Error ? { passed: false, output: r.message } : { passed: r.ok, output: r.ok ? '' : `the hopper answered ${r.status}` };
    },
    async stop(id) { const c = byId(id); if (c) c.state = 'exited'; },
    async remove(id) {
      if (e.removeFails) throw new Error(e.removeFails);
      const c = byId(id);
      if (c) e.boxes.delete(c.spec.name);
    },
    // Issue #1004: as in a box, the command runs on when its caller stops waiting; only a kill in the box ends it.
    async exec(id, run) {
      const c = byId(id);
      if (!c || c.state !== 'running') throw new Error(`the box ${id} is not running`);
      const home = homeOf(c.spec.name);
      e.execs.push({ box: c.spec.name, cmd: [...run.cmd], env: { ...run.env } });
      return new Promise<number>((resolve, reject) => {
        const p = spawn(run.cmd[0]!, run.cmd.slice(1), { env: { PATH: process.env.PATH, HOME: home, ...run.env }, cwd: home });
        const stop = () => reject(new Error('stopped waiting for it'));
        run.signal?.addEventListener('abort', stop, { once: true });
        p.stdout.on('data', (d: Buffer) => run.out(d, 1));
        p.stderr.on('data', (d: Buffer) => run.out(d, 2));
        p.on('error', reject);
        p.on('close', (code) => { run.signal?.removeEventListener('abort', stop); resolve(code ?? 255); });
      });
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
