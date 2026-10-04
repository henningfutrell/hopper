// The question gates' model (ui/src/model/question-gates.ts; issue #18): the chain a question goes
// through as GET /api/plugins reports it, and the rules-file editor's draft — kept in the browser
// so unsaved edits survive a refresh, sent back with the version it was based on.
import { describe, expect, it } from 'vitest';
import type { PluginsReport, RulesView } from '../../src/domain/types.ts';
import { gateChain, readDraft, rulesEditor, RULES_MAX_BYTES } from '../../ui/src/model/question-gates.ts';

const base = {
  answerer: { instance: { name: 'opus', plugin: 'claude-cli', options: { model: 'opus' } }, detection: { status: 'available' }, active: 'claude-cli', fallback: false },
  assessor: { instance: { name: 'fable', plugin: 'claude-cli-assessor' }, detection: { status: 'unavailable', reason: 'no claude' }, active: 'always-escalate', fallback: true, reason: 'assessor fable unavailable: no claude' },
} as unknown as PluginsReport;

describe('gateChain', () => {
  it('answerer, assessor, risk rules, owner — each live stage with its instance and state', () => {
    const chain = gateChain(base, 6);
    expect(chain.map((s) => s.stage)).toEqual(['answerer', 'assessor', 'risk-rules', 'human']);
    expect(chain[0]).toMatchObject({ name: 'opus', plugin: 'claude-cli', label: 'active', tone: 'ok' });
    expect(chain[1]).toMatchObject({ name: 'fable', label: 'fallback: always-escalate', tone: 'warn', reason: 'assessor fable unavailable: no claude' });
    expect(chain[2]).toMatchObject({ name: '6 rules', label: 'code, cannot be weakened', tone: 'muted' });
    expect(chain[3]).toMatchObject({ name: 'Owner', label: 'last stop' });
  });

  it('no answerer: questions skip to the owner', () => {
    const none = { ...base, answerer: { instance: null, active: null, fallback: false } } as unknown as PluginsReport;
    expect(gateChain(none, 6)[0]).toMatchObject({ name: null, label: 'none — straight to the owner', tone: 'muted' });
  });

  it('an answerer that cannot run says so', () => {
    const broken = { ...base, answerer: { instance: { name: 'opus', plugin: 'claude-cli' }, active: null, fallback: true, reason: 'no claude' } } as unknown as PluginsReport;
    expect(gateChain(broken, 6)[0]).toMatchObject({ name: 'opus', label: 'cannot run', tone: 'bad', reason: 'no claude' });
  });
});

describe('the rules-file draft', () => {
  const server: RulesView = { document: 'rules.md', text: 'one\n', version: 'v1', missing: false };

  it('no draft: the file as read, nothing to save', () => {
    expect(rulesEditor(server, undefined)).toEqual({ text: 'one\n', base: 'v1', dirty: false, stale: false, bytes: 4, tooLarge: false });
  });

  it('a draft over the version read is dirty; sent with that version', () => {
    expect(rulesEditor(server, { document: server.document, text: 'two\n', base: 'v1' })).toMatchObject({ text: 'two\n', base: 'v1', dirty: true, stale: false });
  });

  it('a draft over an older version is stale: kept, and sent with its own version (the daemon answers 409)', () => {
    expect(rulesEditor(server, { document: server.document, text: 'two\n', base: 'v0' })).toMatchObject({ text: 'two\n', base: 'v0', dirty: true, stale: true });
  });

  it('a draft for another document is ignored', () => {
    expect(rulesEditor(server, { document: 'elsewhere.md', text: 'x', base: 'v1' })).toMatchObject({ text: 'one\n', dirty: false });
  });

  it('counts UTF-8 bytes against the 64 KiB cap', () => {
    expect(RULES_MAX_BYTES).toBe(64 * 1024);
    const big = rulesEditor(server, { document: server.document, text: 'é'.repeat(32 * 1024 + 1), base: 'v1' });
    expect(big).toMatchObject({ bytes: 64 * 1024 + 2, tooLarge: true });
  });

  it('reads a stored draft defensively', () => {
    expect(readDraft(null)).toBeUndefined();
    expect(readDraft('not json')).toBeUndefined();
    expect(readDraft(JSON.stringify({ document: 'p', text: 1, base: 'v' }))).toBeUndefined();
    expect(readDraft(JSON.stringify({ document: 'p', text: 't', base: 'v' }))).toEqual({ document: 'p', text: 't', base: 'v' });
    // A draft kept before the rules moved into the database names a path: not a draft of rules.md.
    expect(readDraft(JSON.stringify({ path: '/h/rules.md', text: 't', base: 'v' }))).toBeUndefined();
  });
});
