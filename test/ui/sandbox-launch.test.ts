// Issue #708: the page's model of a template's limits and a launch's parameters. The page checks what a person types
// before it sends anything, and it must agree with the server: the same drafts the page accepts, the server accepts
// with the same parameters; the same drafts the page refuses, the server refuses.
import { describe, expect, it } from 'vitest';
import { limitsProblem, type TemplateLimits } from '../../src/domain/sandboxes.ts';
import { DEFAULT_LIMITS as SERVER_DEFAULTS, resolveParams } from '../../src/sandbox/params.ts';
import { DEFAULT_LIMITS, launchDraft, launchParams, limitsDraft, limitsText, templateLimits, type LaunchDraft } from '../../ui/src/model/sandbox-launch.ts';
import type { TemplateView } from '../../ui/src/model/wire.ts';

const READ = { operation: 'read' as const, asset: { kind: 'cluster' as const, name: 'lab' } };
const template = (over: Partial<TemplateView> = {}): TemplateView => ({
  name: 'kube', image: 'img', secrets: ['KUBE', 'AWS'], profiles: [READ], savedBy: 'Ada', savedAt: '2026-10-11T10:00:00Z',
  approval: { image: 'img', secrets: ['KUBE', 'AWS'], by: 'Ada', at: '' }, pending: { secrets: [], image: false, profiles: [] },
  gives: ['KUBE', 'AWS'], radius: { level: 'low', reasons: [], profiles: [] },
  limits: { cpus: { default: 2, max: 4 }, memoryMb: { default: 2048, max: 4096 }, ttlMinutes: { default: 60, max: 240 } },
  tools: ['helm', 'kubectl'], ...over,
});
/** What the server resolves the draft's numbers to, as the sandbox module reads a template. */
const server = (t: TemplateView | undefined, d: LaunchDraft) => {
  const asked = {
    cpus: Number(d.cpus), memoryMb: Math.round(Number(d.memoryGiB) * 1024), ...(d.ttlMinutes ? { ttlMinutes: Number(d.ttlMinutes) } : {}),
    secrets: d.secrets, ...(d.profile ? { profile: d.profile } : {}), tools: d.tools,
  };
  return resolveParams(t && { name: t.name, gives: t.gives, profiles: t.profiles.map((p) => `${p.operation}/${p.asset.kind}/${p.asset.name}`), limits: t.limits, tools: t.tools }, asked);
};

describe('a launch draft', () => {
  it('starts at the template\'s defaults: its limits, every secret it gives now, its tools, no profile', () => {
    expect(launchDraft(template())).toEqual({ cpus: '2', memoryGiB: '2', ttlMinutes: '60', secrets: ['KUBE', 'AWS'], profile: null, tools: ['helm', 'kubectl'] });
  });

  it('a box of no template, or a template with no limits: the hopper\'s defaults, no time limit', () => {
    expect(DEFAULT_LIMITS).toEqual(SERVER_DEFAULTS);
    const empty = { cpus: '4', memoryGiB: '8', ttlMinutes: '', secrets: [], profile: null, tools: [] };
    expect(launchDraft(undefined)).toEqual(empty);
    expect(launchDraft(template({ limits: undefined, gives: [], tools: undefined }))).toEqual(empty);
  });

  it('memory is in GiB on the page and in MiB on the wire', () => {
    const r = launchParams({ ...launchDraft(template()), memoryGiB: '1.5' }, template());
    expect(r).toEqual({ ok: true, params: { cpus: 2, memoryMb: 1536, ttlMinutes: 60, secrets: ['KUBE', 'AWS'], tools: ['helm', 'kubectl'] } });
  });

  it('a profile is sent as operation/kind/name; an empty time limit is not sent', () => {
    const r = launchParams({ ...launchDraft(undefined), profile: null }, undefined);
    expect(r).toEqual({ ok: true, params: { cpus: 4, memoryMb: 8192 } });
    const p = launchParams({ ...launchDraft(template()), profile: 'read/cluster/lab' }, template());
    expect(p.ok && p.params.profile).toBe('read/cluster/lab');
  });

  it('refuses what the template does not allow, and says what it allows', () => {
    const t = template();
    const d = launchDraft(t);
    expect(launchParams({ ...d, cpus: '6' }, t)).toEqual({ ok: false, error: 'CPUs: at most 4 for the template kube' });
    expect(launchParams({ ...d, memoryGiB: '5' }, t)).toEqual({ ok: false, error: 'Memory: at most 4 GiB for the template kube' });
    expect(launchParams({ ...d, ttlMinutes: '300' }, t)).toEqual({ ok: false, error: 'Time limit: at most 240 minutes for the template kube' });
    expect(launchParams({ ...d, cpus: '0' }, t)).toEqual({ ok: false, error: 'CPUs: give a number more than 0' });
    expect(launchParams({ ...d, cpus: 'many' }, t)).toEqual({ ok: false, error: 'CPUs: give a number more than 0' });
    expect(launchParams({ ...d, ttlMinutes: '1.5' }, t)).toEqual({ ok: false, error: 'Time limit: give whole minutes, more than 0' });
    expect(launchParams({ ...launchDraft(undefined), cpus: '9' }, undefined)).toEqual({ ok: false, error: 'CPUs: at most 8 for a box' });
  });

  it('agrees with the server: what the page sends, the server resolves to the same; what the page refuses, the server refuses', () => {
    const t = template();
    const cases: [TemplateView | undefined, LaunchDraft][] = [
      [t, launchDraft(t)],
      [t, { ...launchDraft(t), secrets: ['KUBE'], profile: 'read/cluster/lab', tools: ['kubectl'] }],
      [t, { ...launchDraft(t), cpus: '4', memoryGiB: '4', ttlMinutes: '240' }],
      [t, { ...launchDraft(t), cpus: '4.5' }],
      [t, { ...launchDraft(t), memoryGiB: '4.01' }],
      [t, { ...launchDraft(t), ttlMinutes: '241' }],
      [template({ limits: { ttlMinutes: { max: 30 } } }), { ...launchDraft(template({ limits: { ttlMinutes: { max: 30 } } })), ttlMinutes: '' }],
      [undefined, launchDraft(undefined)],
      [undefined, { ...launchDraft(undefined), cpus: '8', memoryGiB: '16', ttlMinutes: '15', tools: ['aws'] }],
      [undefined, { ...launchDraft(undefined), memoryGiB: '17' }],
    ];
    for (const [tp, d] of cases) {
      const page = launchParams(d, tp);
      const srv = server(tp, d);
      expect({ draft: d, ok: srv.ok }).toEqual({ draft: d, ok: page.ok });
      if (page.ok && srv.ok) expect(srv.params).toEqual({ ...srv.params, ...page.params });
    }
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
