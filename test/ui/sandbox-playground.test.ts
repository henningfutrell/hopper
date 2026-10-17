// Issue #1410: the sandbox playground's create form on Machines checks a draft against the hopper's limits before it is
// sent, and each sandbox's state reads in plain words.
import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, playgroundBody, playgroundStateText } from '../../ui/src/model/sandbox-playground.ts';
import { PLAYGROUND_LIMITS } from '../../src/sandbox/playground.ts';
import type { PlaygroundSandbox } from '../../src/domain/types.ts';

describe('the sandbox playground form', () => {
  it('sends how many, the template, and only the sizes typed; the defaults fill the rest', () => {
    expect(playgroundBody(EMPTY_DRAFT, PLAYGROUND_LIMITS)).toEqual({ count: 1 });
    expect(playgroundBody({ count: '50', agent: '', template: 'kube', cpus: '0.5', memoryMb: '', ttlMinutes: '30' }, PLAYGROUND_LIMITS))
      .toEqual({ count: 50, template: 'kube', cpus: 0.5, ttlMinutes: 30 });
  });

  // Issue #865: every harness has a box image; a template names its own image, so it wins over the agent.
  it('sends the agent picked when no template is picked', () => {
    expect(playgroundBody({ ...EMPTY_DRAFT, agent: 'codex' }, PLAYGROUND_LIMITS)).toEqual({ count: 1, agent: 'codex' });
    expect(playgroundBody({ ...EMPTY_DRAFT, agent: 'codex', template: 'kube' }, PLAYGROUND_LIMITS)).toEqual({ count: 1, template: 'kube' });
  });

  it('refuses a count below 1, a size not above 0, and a size over the hopper\'s max', () => {
    expect(playgroundBody({ ...EMPTY_DRAFT, count: '0' }, PLAYGROUND_LIMITS)).toMatch(/How many/);
    expect(playgroundBody({ ...EMPTY_DRAFT, count: '1.5' }, PLAYGROUND_LIMITS)).toMatch(/How many/);
    expect(playgroundBody({ ...EMPTY_DRAFT, cpus: '-1' }, PLAYGROUND_LIMITS)).toMatch(/CPUs/);
    expect(playgroundBody({ ...EMPTY_DRAFT, memoryMb: '1.5' }, PLAYGROUND_LIMITS)).toMatch(/whole number/);
    expect(playgroundBody({ ...EMPTY_DRAFT, ttlMinutes: '2000' }, PLAYGROUND_LIMITS)).toBe('Time limit (minutes): at most 1440');
  });

  it('reads each state: the time left of a running one, and why one failed', () => {
    const s: PlaygroundSandbox = { id: '1', name: 'hopper-playground-1', agent: 'claude', size: { cpus: 1, memoryMb: 2048, ttlMinutes: 60 }, state: 'running', createdAt: '2026-10-15T12:00:00Z', expiresAt: '2026-10-15T13:00:00Z' };
    expect(playgroundStateText(s, new Date('2026-10-15T12:20:00Z'))).toBe('running, 40 min left');
    expect(playgroundStateText({ ...s, state: 'failed', problem: 'no space' }, new Date())).toBe('did not start: no space');
    expect(playgroundStateText({ ...s, state: 'starting' }, new Date())).toBe('starting');
  });
});
