// Issue #2622 part 3: the heavy-step gate. Lanes were admitted while their agents were light, then four of them started a
// JVM build within two minutes and took the VM's memory. A heavy step — a build, an install, a browser install or test, an
// image build — runs only when its host's memory holds it over the floor, and at most as many JVM builds as the host holds
// at their worst; the rest wait, and the wait says why.
import { describe, expect, it } from 'vitest';
import { HEAVY_RAMP_MS, heavyAdmits, heavyHostOf, type HeavyStep } from '../../src/decider/heavy-steps.ts';
import { HEAVY_SHIMS, heavyKindOf, heavyNeedOf, heavyShimCases } from '../../src/domain/heavy-steps.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { NOW, machine } from './support.ts';

const GIB = 1024 ** 3;
const at = Date.parse(NOW);
const ago = (ms: number): string => new Date(at - ms).toISOString();
/** A machine of 14 GiB, as a WSL VM with that cap, with `available` GiB available. */
const vm = (available: number, over: Partial<MachineSnapshot> = {}): MachineSnapshot =>
  machine({ maxLanes: 8, resources: { cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: available * GIB }, ...over });
const step = (id: string, kind: HeavyStep['kind'], gib: number, since = NOW): HeavyStep =>
  ({ id, jobId: `job-${id}`, machineId: 'local', kind, bytes: gib * GIB, command: kind === 'build' ? 'gradlew' : 'npm', since });

describe('which commands are heavy (issue #2622 part 3)', () => {
  it('a JVM build is heavy whatever its arguments, but for its version or help', () => {
    expect(heavyKindOf(['/opt/gradle/bin/gradle', 'test'])).toBe('build');
    expect(heavyKindOf(['./gradlew', '--no-daemon', 'compileKotlin', 'ktlintCheck'])).toBe('build');
    expect(heavyKindOf(['mvn', 'verify'])).toBe('build');
    expect(heavyKindOf(['./mvnw', '-q', 'package'])).toBe('build');
    expect(heavyKindOf(['./gradlew', '--version'])).toBeUndefined();
    expect(heavyKindOf(['mvn', '-v'])).toBeUndefined();
  });

  it('an install is heavy; other package manager calls are not', () => {
    expect(heavyKindOf(['npm', 'install'])).toBe('install');
    expect(heavyKindOf(['npm', 'ci'])).toBe('install');
    expect(heavyKindOf(['/usr/bin/pnpm', 'i', '--frozen-lockfile'])).toBe('install');
    expect(heavyKindOf(['yarn'])).toBe('install');
    expect(heavyKindOf(['npm', 'run', 'build'])).toBeUndefined();
    expect(heavyKindOf(['npm', 'test'])).toBeUndefined();
    expect(heavyKindOf(['npm', '--version'])).toBeUndefined();
  });

  it('a Playwright browser install or test run is heavy, and so is an image build', () => {
    expect(heavyKindOf(['npx', 'playwright', 'install', 'chromium'])).toBe('browser');
    expect(heavyKindOf(['npx', '-y', 'playwright', 'test'])).toBe('browser');
    expect(heavyKindOf(['playwright', 'test'])).toBe('browser');
    expect(heavyKindOf(['npx', 'vitest', 'run'])).toBeUndefined();
    expect(heavyKindOf(['/usr/bin/podman', 'build', '-t', 'x', '.'])).toBe('image');
    expect(heavyKindOf(['docker', 'buildx', 'build', '.'])).toBe('image');
    expect(heavyKindOf(['podman', 'run', '--rm', 'alpine', 'build'])).toBeUndefined();
    expect(heavyKindOf(['ls', '-l'])).toBeUndefined();
    expect(heavyKindOf([])).toBeUndefined();
  });

  it('the shims the job gets are the commands it names, each with the words that make it heavy', () => {
    expect(HEAVY_SHIMS.names.slice().sort()).toEqual(['gradle', 'gradlew', 'mvn', 'mvnw', 'npm', 'npx', 'playwright', 'pnpm', 'yarn']);
    expect(heavyShimCases().find((c) => c.names.includes('npm'))!.first).toContain('install');
    expect(heavyShimCases().find((c) => c.names.includes('gradle'))!.first).toBeUndefined();
  });
});

describe('the host a heavy step runs on (issue #2622 part 3)', () => {
  it('a machine alone is its own host: its memory, available and floor', () => {
    const host = heavyHostOf(vm(10), [vm(10)], at)!;
    expect(host).toMatchObject({ key: 'machine:local', label: 'local', totalBytes: 14 * GIB, availableBytes: 10 * GIB });
    expect(host.floorBytes).toBeCloseTo(1.4 * GIB);
  });

  it('seats on one kernel share a host: the kernel\'s memory, with Windows\' free memory when that is lower', () => {
    const seat = (id: string, over: Partial<NonNullable<MachineSnapshot['resources']>> = {}): MachineSnapshot => machine({
      id, maxLanes: 2, resources: {
        cores: 8, memTotalBytes: 14 * GIB, memAvailableBytes: 9 * GIB, container: true, bootId: 'boot-1',
        kernelMemTotalBytes: 14 * GIB, kernelMemAvailableBytes: 8 * GIB, ...over,
      },
    });
    const seats = [seat('a'), seat('b', { wsl: true, hostMemFreeBytes: 6 * GIB })];
    const host = heavyHostOf(seats[0]!, seats, at)!;
    expect(host).toMatchObject({ key: 'boot:boot-1', label: 'host (shared with b)', totalBytes: 14 * GIB, availableBytes: 6 * GIB });
  });

  it('a machine with no memory reading, or its floor off, has no host the gate counts', () => {
    expect(heavyHostOf(machine({}), [machine({})], at)).toBeUndefined();
    const off = vm(10, { memoryFloor: { floorGiB: 0 } });
    expect(heavyHostOf(off, [off], at)).toBeUndefined();
  });
});

describe('the heavy-step gate (issue #2622 part 3)', () => {
  const host = heavyHostOf(vm(10), [vm(10)], at)!;

  it('4 lanes start a 3 GiB build at the same moment on a 14 GiB VM: 2 run, the others wait, and available stays over the floor', () => {
    const held: HeavyStep[] = [];
    const answers = ['a', 'b', 'c', 'd'].map((id) => {
      const a = heavyAdmits(host, held, 'build', 3 * GIB, at);
      if (a.ok) held.push(step(id, 'build', 3));
      return a;
    });
    expect(answers.map((a) => a.ok)).toEqual([true, true, false, false]);
    expect(answers[2]).toEqual({
      ok: false,
      reason: 'local runs 2 JVM builds, and holds at most 2 at once: 14 GiB less its floor of 1.4 GiB, at up to 5 GiB a build',
    });
    // Each build takes its 3 GiB: what is left stays over the floor.
    expect(host.availableBytes - held.length * 3 * GIB).toBeGreaterThanOrEqual(host.floorBytes);
  });

  it('a step waits while what the steps started lately keep leaves no room for it over the floor', () => {
    const held = [step('a', 'install', 4), step('b', 'install', 3)];
    const a = heavyAdmits(host, held, 'browser', 2 * GIB, at);
    expect(a).toEqual({
      ok: false,
      reason: 'local has 10 GiB available, 7 GiB of it kept for 2 heavy steps started lately, and this step needs 2 GiB over its floor of 1.4 GiB',
    });
  });

  it('a step that started over the ramp ago has taken its memory: the reading holds it, and it keeps none', () => {
    const held = [step('a', 'install', 4, ago(HEAVY_RAMP_MS + 1)), step('b', 'install', 3, ago(HEAVY_RAMP_MS + 1))];
    expect(heavyAdmits(host, held, 'browser', 2 * GIB, at)).toEqual({ ok: true });
  });

  it('the first heavy step on a host always runs: a small machine still builds, one at a time', () => {
    const small = heavyHostOf(vm(2), [vm(2)], at)!;
    expect(heavyAdmits(small, [], 'build', 3 * GIB, at)).toEqual({ ok: true });
    expect(heavyAdmits(small, [step('a', 'build', 3)], 'install', 1 * GIB, at).ok).toBe(false);
  });

  it('a machine of 8 GiB holds one JVM build at a time', () => {
    const eight = machine({ maxLanes: 4, resources: { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 7 * GIB } });
    const h = heavyHostOf(eight, [eight], at)!;
    expect(heavyAdmits(h, [step('a', 'build', 3, ago(HEAVY_RAMP_MS + 1))], 'build', 3 * GIB, at)).toMatchObject({ ok: false });
    expect(heavyAdmits(h, [step('a', 'build', 3, ago(HEAVY_RAMP_MS + 1))], 'install', 1 * GIB, at)).toEqual({ ok: true });
  });
});

describe('the need of a heavy step from history (issue #2622 part 4)', () => {
  it('is the most of the recent recorded peaks; with none, the estimate of its kind', () => {
    expect(heavyNeedOf('build', [3 * GIB])).toEqual({ bytes: 3 * GIB, recorded: true });
    expect(heavyNeedOf('install', [1 * GIB, 2.5 * GIB, 2 * GIB])).toEqual({ bytes: 2.5 * GIB, recorded: true });
    expect(heavyNeedOf('build', [])).toEqual({ bytes: 3 * GIB, recorded: false });
    expect(heavyNeedOf('install', [0])).toEqual({ bytes: 1 * GIB, recorded: false });
  });
});
