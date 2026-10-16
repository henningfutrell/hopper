// Issue #708: the page's model of a template's limits. The page checks what a person types before it sends anything,
// and it must agree with the server: the same limits the page refuses, the server refuses.
import { describe, expect, it } from 'vitest';
import { limitsProblem, type TemplateLimits } from '../../src/domain/sandboxes.ts';
import { DEFAULT_LIMITS as SERVER_DEFAULTS } from '../../src/sandbox/params.ts';
import { DEFAULT_LIMITS, limitsDraft, limitsText, templateLimits } from '../../ui/src/model/sandbox-launch.ts';
import type { TemplateView } from '../../ui/src/model/wire.ts';

const READ = { operation: 'read' as const, asset: { kind: 'cluster' as const, name: 'lab' } };
const template = (over: Partial<TemplateView> = {}): TemplateView => ({
  name: 'kube', image: 'img', secrets: ['KUBE', 'AWS'], profiles: [READ], savedBy: 'Ada', savedAt: '2026-10-11T10:00:00Z',
  approval: { image: 'img', secrets: ['KUBE', 'AWS'], by: 'Ada', at: '' }, pending: { secrets: [], image: false, profiles: [] },
  gives: ['KUBE', 'AWS'], radius: { level: 'low', reasons: [], profiles: [] },
  limits: { cpus: { default: 2, max: 4 }, memoryMb: { default: 2048, max: 4096 }, ttlMinutes: { default: 60, max: 240 } },
  tools: ['helm', 'kubectl'], ...over,
});

describe('the hopper\'s default limits', () => {
  it('are the server\'s', () => {
    expect(DEFAULT_LIMITS).toEqual(SERVER_DEFAULTS);
  });
});

describe('a template\'s limits on its form', () => {
  it('a draft shows what is set, empty where the hopper\'s default applies; memory in GiB', () => {
    expect(limitsDraft(undefined)).toEqual({ cpus: { default: '', max: '' }, memoryGiB: { default: '', max: '' }, ttlMinutes: { default: '', max: '' }, keepHome: true });
    expect(limitsDraft({ cpus: { default: 2, max: 4 }, memoryMb: { default: 1536, max: 4096 }, ttlMinutes: { max: 90 }, keepHome: false }))
      .toEqual({ cpus: { default: '2', max: '4' }, memoryGiB: { default: '1.5', max: '4' }, ttlMinutes: { default: '', max: '90' }, keepHome: false });
  });

  it('a draft goes back to the limits it was made from; empty fields send nothing, so the hopper\'s defaults apply', () => {
    const l: TemplateLimits = { cpus: { default: 2, max: 4 }, memoryMb: { default: 1536, max: 4096 }, ttlMinutes: { max: 90 }, keepHome: false };
    expect(templateLimits(limitsDraft(l))).toEqual({ ok: true, limits: l });
    expect(templateLimits(limitsDraft(undefined))).toEqual({ ok: true, limits: {} });
  });

  it('refuses half a range, a default over its max, and what is not a number; the server refuses the same', () => {
    const d = limitsDraft(undefined);
    expect(templateLimits({ ...d, cpus: { default: '2', max: '' } })).toEqual({ ok: false, error: 'CPUs: give the default and the max, or neither' });
    expect(templateLimits({ ...d, memoryGiB: { default: '8', max: '4' } })).toEqual({ ok: false, error: 'Memory: the default 8 GiB is more than the max 4 GiB' });
    expect(templateLimits({ ...d, ttlMinutes: { default: '90', max: '60' } })).toEqual({ ok: false, error: 'Time limit: the default 90 minutes is more than the max 60 minutes' });
    expect(templateLimits({ ...d, ttlMinutes: { default: '0.5', max: '' } })).toEqual({ ok: false, error: 'Time limit: give whole minutes, more than 0' });
    expect(templateLimits({ ...d, cpus: { default: 'x', max: '4' } })).toEqual({ ok: false, error: 'CPUs: give a number more than 0' });
    expect(limitsProblem({ memoryMb: { default: 8192, max: 4096 } })).toBeDefined();
    expect(limitsProblem({ ttlMinutes: { default: 90, max: 60 } })).toBeDefined();
  });

  it('says them in a few words, and which are the hopper\'s defaults', () => {
    expect(limitsText(template().limits)).toBe('2 CPUs, at most 4 · 2 GiB, at most 4 GiB · time limit 60 minutes, at most 240 · home kept');
    expect(limitsText(undefined)).toBe('4 CPUs, at most 8 (the hopper\'s) · 8 GiB, at most 16 GiB (the hopper\'s) · no time limit · home kept');
    expect(limitsText({ ttlMinutes: { max: 30 }, keepHome: false })).toBe('4 CPUs, at most 8 (the hopper\'s) · 8 GiB, at most 16 GiB (the hopper\'s) · no time limit unless a launch sets one, at most 30 · home removed with the box');
  });
});
