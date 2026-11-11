// Issue #2923: the engine reads the vault's view each tick for its templates only. The grant fields under it are getters,
// so a tick runs no store statement for them; the system scope wraps the view outside them and must keep them getters.
//
// Feature: the system scope keeps the view's fields lazy
//   Scenario: a read of the templates reads no grant field and no system secret; a read of each field reads it
import { describe, expect, it } from 'vitest';
import type { VaultView } from '../../src/domain/vault.ts';
import type { Vault } from '../../src/vault/vault.ts';
import { withSystemScope } from '../../src/vault/system-view.ts';

describe('the system scope keeps the view lazy (issue #2923)', () => {
  it('a read of the templates reads no grant field and no system secret; a read of each field reads it', () => {
    const reads: string[] = [];
    const inner = {
      view: () => ({
        secrets: [], templates: [],
        get grants() { reads.push('grants'); return []; },
      } as unknown as VaultView),
    } as unknown as Vault;
    const system = { list: () => { reads.push('system'); return []; } };
    const events = { recent: () => { reads.push('audit'); return []; } };
    const v = withSystemScope(inner, { system: system as never, events: events as never });

    expect(v.view().templates).toEqual([]);
    expect(reads).toEqual([]);

    const view = v.view();
    expect(view.grants).toEqual([]);
    expect(view.system).toEqual({ secrets: [], audit: [] });
    expect(reads).toEqual(['grants', 'system', 'audit']);
    expect(JSON.parse(JSON.stringify(v.view()))).toMatchObject({ grants: [], system: { secrets: [], audit: [] } });
  });
});
