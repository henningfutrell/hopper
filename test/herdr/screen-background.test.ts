import { describe, expect, it } from 'vitest';
import { backgroundWork } from '../../src/executors/herdr/screen.ts';

// Issue #491: the footer under the input box names the background work a job started, which wakes
// the job when it ends. Captured from a live pane, idle after starting a background shell command.

const RULE = '──────────────────────────────────────────────────────────────────────────────────────────────';
const IDLE_WITH_SHELL = [
  '  Ran 1 shell command',
  '● started',
  '✻ Crunched for 6s · done 12:28 PM · 1 shell still running',
  '                                                  Update available! Run: mise upgrade claude',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage',
].join('\n');

describe('backgroundWork', () => {
  it('names the background shell the footer shows (live capture)', () => {
    expect(backgroundWork(IDLE_WITH_SHELL)).toBe('1 shell');
  });

  it.each([
    ['  ⏵⏵ bypass permissions on · 2 shells · ↓ to manage', '2 shells'],
    ['  ⏵⏵ bypass permissions on · 1 background task · ↓ to manage', '1 background task'],
    ['  ⏵⏵ bypass permissions on · 1 monitor · ↓ to manage', '1 monitor'],
    ['  1 shell · ↓ to manage', '1 shell'],
  ])('names the background work in the footer %j', (footer, work) => {
    expect(backgroundWork([RULE, '❯ ', RULE, footer].join('\n'))).toBe(work);
  });

  it.each([
    ['  ⏵⏵ bypass permissions on (shift+tab to cycle)'],
    ['  ⏵⏵ bypass permissions on · ← for agents'],
    ['  ? for shortcuts'],
  ])('finds none in the footer %j', (footer) => {
    expect(backgroundWork([RULE, '❯ ', RULE, footer].join('\n'))).toBeUndefined();
  });

  it('reads only the footer, never the transcript above the input box', () => {
    const text = ['● I started 1 shell · it polls the build', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
    expect(backgroundWork(text)).toBeUndefined();
  });
});
