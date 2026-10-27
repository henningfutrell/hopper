// Repository memory in the UI (ui/src/model/repo-memory.ts, issue #2847), pure: the acts an entry offers, the change an
// edit sends — only what differs, an emptied area as null —, the settings a save sends, refused when a number or a
// repository name is not one the daemon takes, and the summary of the settings.
import { describe, expect, it } from 'vitest';
import { memoryActs, memoryEditPatch, memoryOffered, memoryRepos, memorySettingsDraft, memorySettingsOfDraft, memorySummary } from '../../ui/src/model/repo-memory.ts';
import type { MemoryEntryView } from '../../ui/src/model/wire.ts';

const DEFAULTS = { on: true, approval: true, maxBytes: 4096, expireDays: 180, repos: {} };
const ENTRY: MemoryEntryView = {
  id: 'e1', shortId: 'e1', repo: 'acme/app', kind: 'convention', area: 'src/store', text: 'Run npm test -- <file>.', state: 'approved', confidence: 0.5,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', by: 'job j1', sourceJobId: 'j1', expired: false,
};

describe('repository memory model', () => {
  it('an entry offers approve when no job is offered it for its state or age, disable while in use, enable when disabled', () => {
    expect(memoryActs({ state: 'approved', expired: false })).toEqual(['disable']);
    expect(memoryActs({ state: 'approved', expired: true })).toEqual(['approve', 'disable']);
    expect(memoryActs({ state: 'proposed', expired: false })).toEqual(['approve', 'disable']);
    expect(memoryActs({ state: 'flagged', expired: false })).toEqual(['approve', 'disable']);
    expect(memoryActs({ state: 'disabled', expired: false })).toEqual(['enable']);
    expect(memoryOffered({ state: 'approved', expired: false })).toBe(true);
    expect(memoryOffered({ state: 'approved', expired: true })).toBe(false);
    expect(memoryOffered({ state: 'proposed', expired: false })).toBe(false);
  });

  it('lists the repositories of the entries once each, in order', () => {
    expect(memoryRepos([{ ...ENTRY, repo: 'b/x' }, ENTRY, { ...ENTRY, repo: 'b/x' }])).toEqual(['acme/app', 'b/x']);
  });

  it('an edit sends only what differs; an emptied area is null; an empty or two-line text is refused', () => {
    const d = { kind: ENTRY.kind, area: 'src/store', text: ENTRY.text };
    expect(memoryEditPatch(ENTRY, d)).toEqual({ ok: true, patch: undefined });
    expect(memoryEditPatch(ENTRY, { ...d, text: ' Run npm test. ' })).toEqual({ ok: true, patch: { text: 'Run npm test.' } });
    expect(memoryEditPatch(ENTRY, { kind: 'fix', area: ' ', text: ENTRY.text })).toEqual({ ok: true, patch: { kind: 'fix', area: null } });
    expect(memoryEditPatch({ ...ENTRY, area: undefined }, { ...d, area: 'src' })).toEqual({ ok: true, patch: { area: 'src' } });
    expect(memoryEditPatch(ENTRY, { ...d, text: '  ' })).toEqual({ ok: false, error: 'The text is empty' });
    expect(memoryEditPatch(ENTRY, { ...d, text: 'a\nb' })).toEqual({ ok: false, error: 'The text is one line' });
  });

  it('the settings a save sends, from the draft; a bad number or repository is refused', () => {
    const s = { ...DEFAULTS, repos: { 'acme/*': { approval: false } } };
    const d = memorySettingsDraft(s);
    expect(d).toEqual({ on: true, approval: true, maxBytes: '4096', expireDays: '180', repos: [{ repo: 'acme/*', on: true, approval: false }] });
    expect(memorySettingsOfDraft({ ...d, maxBytes: ' 2048 ' })).toEqual({ ok: true, settings: { ...DEFAULTS, maxBytes: 2048, repos: { 'acme/*': { on: true, approval: false } } } });
    expect(memorySettingsOfDraft({ ...d, maxBytes: '100' })).toEqual({ ok: false, error: 'Size cap: a whole number of bytes from 256 to 16384' });
    expect(memorySettingsOfDraft({ ...d, expireDays: '1.5' })).toEqual({ ok: false, error: 'Expiry: a whole number of days from 1 to 3650' });
    expect(memorySettingsOfDraft({ ...d, repos: [{ repo: 'acme', on: true, approval: true }] }).ok).toBe(false);
    expect(memorySettingsOfDraft({ ...d, repos: [...d.repos, { repo: 'ACME/*', on: false, approval: true }] })).toEqual({ ok: false, error: 'ACME/* is named twice' });
  });

  it('the summary says what is on', () => {
    expect(memorySummary(DEFAULTS)).toBe('On: an entry a job learned waits for a person\'s approval; each job is offered at most 4096 bytes; an entry expires 180 days after its last change.');
    expect(memorySummary({ ...DEFAULTS, approval: false, repos: { 'a/b': { on: false } } })).toBe('On: an entry a job learned is offered at once; each job is offered at most 4096 bytes; an entry expires 180 days after its last change; 1 repository has a setting of its own.');
    expect(memorySummary({ ...DEFAULTS, on: false })).toBe('Off: jobs learn no entry and are offered none.');
  });
});
