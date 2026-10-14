// Landing batches in the UI (issue #1073), pure: one line per configured repository saying where its batch runs stand,
// and the change a save sends — only what differs.
import { describe, expect, it } from 'vitest';
import { landingBatchLine, landingBatchPatch } from '../../ui/src/model/landing-batches.ts';
import type { LandingBatchRepoView } from '../../ui/src/model/wire.ts';

const row = (r: Partial<LandingBatchRepoView>): LandingBatchRepoView => ({ repo: 'owner/a', config: { tested: 'dev', everyMerges: 5, everyMinutes: 60 }, state: { repo: 'owner/a' }, ...r });

describe('landing batches model', () => {
  it('line: a problem first, then a batch run at work, then why no run started, with how the last one ended', () => {
    expect(landingBatchLine(row({ problem: 'no GitHub connection' }))).toBe('Cannot run: no GitHub connection');
    expect(landingBatchLine(row({ state: { repo: 'owner/a', running: { tip: '0123456789abcdef', branch: 'b', pullRequest: 9, url: 'u', startedAt: 's', merges: [1, 2] } } })))
      .toBe('Batch run #9 tests 0123456789ab (2 pull requests).');
    expect(landingBatchLine(row({ why: 'nothing new on the landing branch beyond dev', state: { repo: 'owner/a', last: { outcome: 'failed', tip: '0123456789abcdef', at: 'a', pullRequest: 9, url: 'u', reason: 'checks failed: test' } } })))
      .toBe('Waiting: nothing new on the landing branch beyond dev. Last batch run #9 failed: checks failed: test.');
    expect(landingBatchLine(row({ state: { repo: 'owner/a', last: { outcome: 'promoted', tip: '0123456789abcdef', at: 'a', pullRequest: 8, url: 'u' } } })))
      .toBe('Waiting for the next pass. Last batch run #8 moved dev to 0123456789ab.');
  });

  it('patch: only what changed; a removed repository is null; a new one names its tested branch', () => {
    const settings = { repos: { 'owner/a': { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } };
    expect(landingBatchPatch(settings, settings)).toBeUndefined();
    expect(landingBatchPatch(settings, { repos: { 'owner/a': { tested: 'dev', everyMerges: 3, everyMinutes: 60 } } })).toEqual({ repos: { 'owner/a': { everyMerges: 3 } } });
    expect(landingBatchPatch(settings, { repos: { 'owner/b': { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } }))
      .toEqual({ repos: { 'owner/a': null, 'owner/b': { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } });
  });
});
