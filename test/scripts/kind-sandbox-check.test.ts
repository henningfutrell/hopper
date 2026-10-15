// Issue #1371 acceptance, part 5: the kind sandbox check kills the hopper while a need box of its own runs, starts it
// again, and the new hopper must remove that box and its home (scripts/kind-sandbox-check.ts `crashAndRestart`). Each
// test runs the step with a fake kubectl and the container runtime double, so nothing here needs a cluster.
//
// Feature: a sandbox the hopper left when it stopped is gone after its next start
//   Scenario: the hopper is stopped before the box is made, and the restarted hopper removes the box and its home: passes
//   Scenario: a restarted hopper that leaves the box fails the check, and names what is left
//   Scenario: a hopper whose instance id cannot be read fails the check before it stops the hopper
import { describe, expect, it } from 'vitest';
import { crashAndRestart, type Kubectl } from '../../scripts/kind-sandbox-check.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';

const INSTANCE = '0123456789abcdef';
const SELECTOR = { 'app.kubernetes.io/name': 'hopper', 'app.kubernetes.io/component': 'hopper' };

interface Call { args: string[]; boxes: number; running: boolean }

/** A fake kubectl over the runtime double: it logs each call, and with `sweeps` a new hopper removes its need boxes. */
function fakeKubectl(runtime: FakeContainerRuntime, o: { sweeps: boolean; instance?: string }): { kubectl: Kubectl; calls: Call[] } {
  const calls: Call[] = [];
  let up = true;
  const kubectl: Kubectl = (args) => {
    calls.push({ args, boxes: runtime.boxes.size, running: up });
    const text = args.join(' ');
    const ok = (stdout = ''): ReturnType<Kubectl> => ({ status: 0, stdout, stderr: '' });
    if (text.includes('psql')) return o.instance === undefined ? { status: 2, stdout: '', stderr: 'no such table' } : ok(`${o.instance}\n`);
    if (text.includes('scale') && text.includes('--replicas=0')) { up = false; return ok(); }
    if (text.includes('scale') && text.includes('--replicas=1')) {
      up = true;
      if (o.sweeps) {
        for (const [name, box] of runtime.boxes) if (box.spec.labels[NEED_LABEL] === INSTANCE) runtime.boxes.delete(name);
        for (const [name, labels] of runtime.volumeLabels) if (labels[NEED_LABEL] === INSTANCE) { runtime.volumes.delete(name); runtime.volumeLabels.delete(name); }
      }
      return ok();
    }
    if (text.includes('get pods,persistentvolumeclaims,secrets')) {
      const pods = [...runtime.boxes.values()].filter((b) => b.spec.labels[NEED_LABEL] === INSTANCE).map((b) => `pod/${b.spec.name}`);
      const claims = [...runtime.volumeLabels].filter(([, l]) => l[NEED_LABEL] === INSTANCE).map(([n]) => `persistentvolumeclaim/${n}`);
      return ok([...pods, ...claims].join('\n'));
    }
    return ok();
  };
  return { kubectl, calls };
}

function runtimeDouble(): FakeContainerRuntime {
  const runtime = createFakeContainerRuntime('kubernetes');
  runtime.runScript = () => new Promise(() => {}); // it runs until it is removed
  return runtime;
}

const options = (runtime: FakeContainerRuntime, kubectl: Kubectl) =>
  ({ kubectl, runtime, image: 'busybox', selector: SELECTOR, goneMs: 300, pollMs: 10 });

describe('scripts/kind-sandbox-check.ts crashAndRestart (issue #1371)', () => {
  it('stops the hopper before it makes the box, and passes when the restarted hopper removes the box and its home', async () => {
    const runtime = runtimeDouble();
    const { kubectl, calls } = fakeKubectl(runtime, { sweeps: true, instance: INSTANCE });

    const failed = await crashAndRestart(options(runtime, kubectl));

    expect(failed).toBeNull();
    const stop = calls.findIndex((c) => c.args.includes('scale') && c.args.includes('--replicas=0'));
    const kill = calls.findIndex((c) => c.args.includes('delete') && c.args.includes('--force'));
    const start = calls.findIndex((c) => c.args.includes('scale') && c.args.includes('--replicas=1'));
    expect(stop).toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(stop);
    // No box while the hopper ran; the box was there, made while the hopper was down, when it started again.
    expect(calls[stop]!.boxes).toBe(0);
    expect(calls[start]!.boxes).toBe(1);
    expect(calls[start]!.running).toBe(false);
    expect(calls.some((c, i) => i > start && c.args.join(' ').includes('rollout status'))).toBe(true);
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
  });

  it('fails when the restarted hopper leaves the box, and names what is left', async () => {
    const runtime = runtimeDouble();
    const { kubectl } = fakeKubectl(runtime, { sweeps: false, instance: INSTANCE });

    const failed = await crashAndRestart(options(runtime, kubectl));

    expect(failed).toMatch(/left after the hopper started again: pod\/hopper-need-kind-orphan-/);
    expect(failed).toContain('persistentvolumeclaim/hopper-need-kind-orphan-');
  });

  it('fails before it stops the hopper when the hopper\'s instance id cannot be read', async () => {
    const runtime = runtimeDouble();
    const { kubectl, calls } = fakeKubectl(runtime, { sweeps: true });

    const failed = await crashAndRestart(options(runtime, kubectl));

    expect(failed).toMatch(/cannot read the hopper's instance id/);
    expect(calls.some((c) => c.args.includes('scale'))).toBe(false);
    expect(runtime.boxes.size).toBe(0);
  });
});
