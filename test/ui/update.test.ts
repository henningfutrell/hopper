// The update notice's words and links (issue #44): pure, from GET /api/update.
import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '../../src/domain/types.ts';
import { compareUrl, headline, reloadNeeded, showNotice } from '../../ui/src/model/update.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const installed = { repo: 'git@github.com:o/r.git', branch: 'main', commit: A, installedAt: '2026-10-04T00:00:00Z' };
const change = (subject: string) => ({ commit: B, subject, at: '2026-10-04T00:00:00Z' });
const status = (o: Partial<UpdateStatus>): UpdateStatus => ({ state: 'current', channel: 'main', autoUpdate: false, changes: [], truncated: false, installed, ...o });

describe('update model', () => {
  it('headline: what is newer, what is happening, or why not', () => {
    expect(headline(status({ state: 'available', target: { commit: B, ref: 'main' }, changes: [change('x'), change('y')] }))).toBe('Update available: 2 new commits on main');
    expect(headline(status({ state: 'available', target: { commit: B, ref: 'main' }, changes: [change('x')] }))).toBe('Update available: 1 new commit on main');
    expect(headline(status({ state: 'available', channel: 'release', target: { commit: B, ref: 'v1.2.0' }, changes: [change('x')] }))).toBe('Update available: release v1.2.0 (1 new commit)');
    expect(headline(status({ state: 'available', target: { commit: B, ref: 'main' }, changes: Array.from({ length: 100 }, () => change('x')), truncated: true }))).toBe('Update available: 100+ new commits on main');
    expect(headline(status({ state: 'applying', apply: { phase: 'waiting', detail: 'waiting for job j1', target: B, startedAt: '' } }))).toBe('Updating: waiting for job j1');
    expect(headline(status({ state: 'error', reason: 'fetch failed' }))).toBe('Update problem: fetch failed');
    expect(headline(status({}))).toBe('Up to date');
    expect(headline(status({ state: 'unavailable', installed: undefined, reason: 'no install.json' }))).toBe('Self-update unavailable: no install.json');
  });

  it('shows the notice only when there is something to act on or watch', () => {
    expect(showNotice(status({ state: 'available' }))).toBe(true);
    expect(showNotice(status({ state: 'applying' }))).toBe(true);
    expect(showNotice(status({ state: 'error' }))).toBe(true);
    expect(showNotice(status({}))).toBe(false);
    expect(showNotice(status({ state: 'unavailable' }))).toBe(false);
    expect(showNotice(null)).toBe(false);
  });

  it('compareUrl: a GitHub repository, by ssh or https; nothing for another host', () => {
    expect(compareUrl('git@github.com:o/r.git', A, B)).toBe(`https://github.com/o/r/compare/${A}...${B}`);
    expect(compareUrl('https://github.com/o/r', A, B)).toBe(`https://github.com/o/r/compare/${A}...${B}`);
    expect(compareUrl('ssh://git@github.com/o/r.git', A, B)).toBe(`https://github.com/o/r/compare/${A}...${B}`);
    expect(compareUrl('/srv/git/r.git', A, B)).toBeUndefined();
  });

  it('reloadNeeded: the daemon now runs another commit than the page was loaded from', () => {
    expect(reloadNeeded(A, status({ installed: { ...installed, commit: B } }))).toBe(true);
    expect(reloadNeeded(A, status({}))).toBe(false);
    expect(reloadNeeded(undefined, status({}))).toBe(false);
  });
});
