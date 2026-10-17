// The request cards a source saw opened (issue #798) are kept in memory so the ledger is read once per text. Only the
// texts still offered stay (issue #1402): a card no longer offered, or an old text of an edited one, goes; one offered
// again is looked up in the ledger, and never recorded twice.
import { describe, expect, it } from 'vitest';
import type { IntakeContext } from '../../src/domain/intake.ts';
import type { IntakeRequest } from '../../src/domain/intake-origin.ts';
import { openRequests } from '../../src/sources/github/origin.ts';

const request = (hash: string) => ({ hash, title: 't', body: 'b', author: 'a', actors: [], why: 'w' }) as unknown as IntakeRequest;

describe('the request cards seen opened (issue #1402)', () => {
  it('keeps only the texts still offered, and records each text once', () => {
    const recorded: string[] = [];
    const opened = new Set<string>();
    const intake = {
      requestOpened: (key: string, hash: string) => opened.has(`${key} ${hash}`),
      record: (_type: string, d: Record<string, unknown>) => { recorded.push(`${String(d.key)} ${String(d.hash)}`); opened.add(`${String(d.key)} ${String(d.hash)}`); },
    } as unknown as IntakeContext;
    const seen = new Set<string>();
    openRequests('github', intake, new Map([['k1', request('h1')], ['k2', request('h2')]]), seen);
    expect([...seen]).toEqual(['k1 h1', 'k2 h2']);
    openRequests('github', intake, new Map([['k1', request('h1-edited')]]), seen);
    expect([...seen]).toEqual(['k1 h1-edited']);
    openRequests('github', intake, new Map([['k2', request('h2')]]), seen);
    expect(recorded).toEqual(['k1 h1', 'k2 h2', 'k1 h1-edited']);
  });
});
