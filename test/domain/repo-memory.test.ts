// Repository memory (issue #2847, src/domain/repo-memory.ts): the settings record, a job's memory lines, which entries a
// job is offered and the text it is told.
import { describe, expect, it } from 'vitest';
import {
  MEMORY_DEFAULTS, memoryEntryProblem, memoryExpired, memoryFor, memoryLinesOf, memoryOffer, memoryRepoOf, memorySettingsOf,
  memorySettingsProblem, memoryShortId, memoryText, sameMemory, withMemoryLines, type MemoryEntry,
} from '../../src/domain/repo-memory.ts';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: '11111111-2222-4333-8444-555555555555', repo: 'acme/app', kind: 'convention', text: 'Run npm run check.', state: 'approved',
  confidence: 0.5, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', by: 'Pat', ...over,
});

describe('the settings record', () => {
  it('missing or not valid: on, approval asked, 4 KiB, 180 days', () => {
    expect(memorySettingsOf(undefined)).toEqual(MEMORY_DEFAULTS);
    expect(memorySettingsOf({ on: 'yes' })).toEqual(MEMORY_DEFAULTS);
    expect(MEMORY_DEFAULTS).toEqual({ on: true, approval: true, maxBytes: 4096, expireDays: 180, repos: {} });
  });

  it('per repository: the owner\'s setting, then the repository\'s, in any case', () => {
    const s = memorySettingsOf({ approval: false, repos: { 'acme/*': { on: false }, 'Acme/App': { on: true } } });
    expect(memoryFor(s, 'acme/app')).toEqual({ on: true, approval: false });
    expect(memoryFor(s, 'acme/other')).toEqual({ on: false, approval: false });
    expect(memoryFor(s, 'zed/app')).toEqual({ on: true, approval: false });
  });

  it.each([
    ['text', /a map/], [{ colour: 1 }, /no repository memory setting/], [{ on: 1 }, /true or false/], [{ maxBytes: 10 }, /256 to 16384/],
    [{ expireDays: 0 }, /1 to 3650/], [{ repos: { acme: {} } }, /no repository/], [{ repos: { 'a/b': { on: 'x' } } }, /only on and approval/],
    [{ repos: { 'a/b': {}, 'A/B': {} } }, /named twice/],
  ])('%j is refused', (raw, why) => expect(memorySettingsProblem(raw)).toMatch(why));

  it('a full record is kept', () => {
    expect(memorySettingsProblem({ on: true, approval: false, maxBytes: 2048, expireDays: 30, repos: { 'acme/*': { approval: true } } })).toBeUndefined();
  });
});

describe('an entry\'s fields', () => {
  it('one line of text, a known kind, a path for an area, an owner/name repository', () => {
    expect(memoryEntryProblem({ repo: 'acme/app', kind: 'fix', area: 'src/store', text: 'x' })).toBeUndefined();
    expect(memoryEntryProblem({ repo: 'acme' })).toMatch(/owner\/name/);
    expect(memoryEntryProblem({ kind: 'idea' })).toMatch(/convention or fix/);
    expect(memoryEntryProblem({ area: 'a b' })).toMatch(/path/);
    expect(memoryEntryProblem({ text: ' ' })).toMatch(/empty/);
    expect(memoryEntryProblem({ text: 'a\nb' })).toMatch(/one line/);
    expect(memoryEntryProblem({ text: 'x'.repeat(1001) })).toMatch(/1000/);
  });

  it('a repository as entries keep it: lowercase owner/name, else none', () => {
    expect(memoryRepoOf('Acme/App')).toBe('acme/app');
    expect(memoryRepoOf('acme')).toBeUndefined();
    expect(memoryRepoOf(undefined)).toBeUndefined();
  });

  it('the same entry: repository, kind, area and text but for case and spaces', () => {
    expect(sameMemory(entry(), entry({ text: '  run NPM  run check. ' }))).toBe(true);
    expect(sameMemory(entry(), entry({ kind: 'fix' }))).toBe(false);
    expect(sameMemory(entry(), entry({ area: 'src' }))).toBe(false);
  });

  it('expires after expireDays from its last change', () => {
    expect(memoryExpired(entry(), { expireDays: 7 }, NOW)).toBe(false);
    expect(memoryExpired(entry(), { expireDays: 5 }, NOW)).toBe(true);
  });

  it('a short id: the first 8 hex digits', () => expect(memoryShortId(entry().id)).toBe('11111111'));
});

describe('a job\'s memory lines', () => {
  it('learned lines with a kind and an area, and wrong lines by short id; other lines are not read', () => {
    const text = [
      'I fixed the store.',
      'HOPPER_MEMORY convention: Run `npm run check` before a push.',
      '- `HOPPER_MEMORY fix src/store/: A migration goes in tenant-migrations-recent.ts.`',
      'HOPPER_MEMORY_WRONG 1a2b3c4d: the command changed.',
      'HOPPER_MEMORY idea: not a kind',
      'Some HOPPER_MEMORY convention: in a sentence',
    ].join('\n');
    expect(memoryLinesOf(text)).toEqual([
      { learned: { kind: 'convention', text: 'Run `npm run check` before a push.' } },
      { learned: { kind: 'fix', area: 'src/store', text: 'A migration goes in tenant-migrations-recent.ts.' } },
      { wrong: { id: '1a2b3c4d', reason: 'the command changed.' } },
    ]);
  });

  it('a line the terminal wrapped is joined, up to a blank line, a list item or another HOPPER_ line', () => {
    const text = ['HOPPER_MEMORY convention: Run the affected tests', '  only, never the full suite.', '', 'Done.', 'HOPPER_MEMORY fix: one', 'HOPPER_DONE'].join('\n');
    expect(memoryLinesOf(text)).toEqual([
      { learned: { kind: 'convention', text: 'Run the affected tests only, never the full suite.' } },
      { learned: { kind: 'fix', text: 'one' } },
    ]);
  });

  it('at most 5', () => {
    expect(memoryLinesOf(Array.from({ length: 8 }, (_, i) => `HOPPER_MEMORY fix: ${i}`).join('\n'))).toHaveLength(5);
  });

  it('a summary cut keeps the memory lines past the cut', () => {
    const text = `${'x'.repeat(50)}\nHOPPER_MEMORY fix: keep me`;
    expect(withMemoryLines(text, 20)).toBe(`${'x'.repeat(20)}\nHOPPER_MEMORY fix: keep me`);
    expect(withMemoryLines('short', 20)).toBe('short');
    expect(withMemoryLines('x'.repeat(30), 20)).toBe('x'.repeat(20));
  });
});

describe('what a job is offered', () => {
  const s = { ...MEMORY_DEFAULTS, repos: {} };

  it('approved and not expired, the most confident first, then the newest change', () => {
    const entries = [
      entry({ id: 'a0000000-0', text: 'low', confidence: 0.5 }),
      entry({ id: 'b0000000-0', text: 'high', confidence: 1 }),
      entry({ id: 'c0000000-0', text: 'newer', confidence: 0.5, updatedAt: '2026-10-25T00:00:00.000Z' }),
      entry({ id: 'd0000000-0', state: 'proposed' }), entry({ id: 'e0000000-0', state: 'disabled' }), entry({ id: 'f0000000-0', state: 'flagged' }),
      entry({ id: '90000000-0', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(memoryOffer(entries, s, NOW).entries.map((e) => e.text)).toEqual(['high', 'newer', 'low']);
  });

  it('as many as fit in maxBytes; the rest are counted', () => {
    const entries = Array.from({ length: 4 }, (_, i) => entry({ id: `${i}0000000-0`, text: 'y'.repeat(100) }));
    const offer = memoryOffer(entries, { ...s, maxBytes: 300 }, NOW);
    expect(offer.entries).toHaveLength(2);
    expect(offer.left).toBe(2);
  });

  it('the text: each entry with its short id, kind and area, then how to add or flag one', () => {
    const text = memoryText('acme/app', { entries: [entry({ area: 'src/store' })], left: 1 }, true);
    expect(text).toContain('[hopper repository memory] What earlier jobs of acme/app learned, each approved by a person:');
    expect(text).toContain('\n- 11111111 (convention, src/store) Run npm run check.\n(1 more entry does not fit.)\n');
    expect(text).toContain('HOPPER_MEMORY convention: <text>');
    expect(text).toContain('HOPPER_MEMORY_WRONG <its id>: <why>');
    expect(memoryText('acme/app', { entries: [], left: 0 }, true)).toMatch(/^\[hopper repository memory\] The hopper keeps no memory entry of acme\/app for jobs yet\.\nWhen this job/);
  });

  it('the text a job is told is not read back as memory lines', () => {
    expect(memoryLinesOf(memoryText('acme/app', { entries: [entry()], left: 0 }, false))).toEqual([]);
  });
});
