// Settings → Search in the UI (ui/src/model/solr-credentials.ts, issue #2990), pure: where the Solr credentials come from,
// the vault's pair (never its username or password), and when a person can set one.
import { describe, expect, it } from 'vitest';
import { solrKeptLine, solrMaySet, solrSourceLine } from '../../ui/src/model/solr-credentials.ts';

describe('Settings → Search (issue #2990)', () => {
  it('says where the credentials come from', () => {
    expect(solrSourceLine({ configured: false, source: 'none' })).toMatch(/^Search is off/);
    expect(solrSourceLine({ configured: true, source: 'runtime' })).toMatch(/given at launch .* win over the vault's/);
    expect(solrSourceLine({ configured: true, source: 'url' })).toMatch(/URL given at launch/);
    expect(solrSourceLine({ configured: true, source: 'vault' })).toBe('The hopper sends the credentials kept in its vault.');
    expect(solrSourceLine({ configured: true, source: 'none' })).toBe('The hopper sends no credentials to Solr.');
  });

  it('the vault\'s pair: who and when, or none', () => {
    expect(solrKeptLine({ set: false })).toBe('None kept in the vault.');
    expect(solrKeptLine({ set: true, setBy: 'Ada', setAt: '2026-11-23T10:00:00Z' })).toMatch(/^Kept in the vault — .* by Ada · sealed$/);
  });

  it('a pair can be set only while search is on and the launch gives none', () => {
    expect(solrMaySet({ configured: true, source: 'none' })).toBe(true);
    expect(solrMaySet({ configured: true, source: 'vault' })).toBe(true);
    expect(solrMaySet({ configured: true, source: 'runtime' })).toBe(false);
    expect(solrMaySet({ configured: false, source: 'none' })).toBe(false);
    expect(solrMaySet({ configured: true, source: 'none', problem: 'no master key' })).toBe(false);
  });
});
