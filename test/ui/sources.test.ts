// The Sources view's GitHub section (issue #160): gh and the GitHub App are two connections to one
// GitHub, and the view says which one reads issues, why the other is paused, and orders them so.
import { describe, expect, it } from 'vitest';
import { sourcesView } from '../../ui/src/model/sources.ts';
import type { SourceStatus } from '../../ui/src/model/wire.ts';

const source = (name: string, kind: string, state: SourceStatus['state'], detail: Record<string, unknown> = {}): SourceStatus =>
  ({ name, kind, state, itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail });
const gh = (state: SourceStatus['state'] = 'ok', paused?: string) => source('github', 'github', state, { mode: 'gh', ...(paused ? { paused } : {}) });
const app = (state: SourceStatus['state'] = 'ok', paused?: string) => source('github-app', 'github-app', state, { mode: 'app', ...(paused ? { paused } : {}) });

describe('sourcesView', () => {
  it('a GitHub App in use comes first; gh is paused because of it', () => {
    const v = sourcesView([gh('ok', 'GitHub App configured'), app()]);
    expect(v.github.map((c) => [c.source.name, c.via, c.use])).toEqual([['github-app', 'app', 'in-use'], ['github', 'gh', 'paused']]);
    expect(v.github[1]!.why).toBe('the GitHub App is set up, so issues are read through it instead');
    expect(v.summary).toBe('Issues are read through the GitHub App, as its bot. gh is paused while the GitHub App is set up.');
  });

  it('gh in use and no GitHub App: the app is paused with its own reason', () => {
    const v = sourcesView([app('ok', 'no GitHub App configured'), gh()]);
    expect(v.github.map((c) => [c.source.name, c.use])).toEqual([['github', 'in-use'], ['github-app', 'paused']]);
    expect(v.github[1]!.why).toBe('no GitHub App configured');
    expect(v.summary).toBe('Issues are read through gh, as the logged-in GitHub user. The GitHub App takes over once it is set up.');
  });

  it('a disabled connection comes last and says it is switched off', () => {
    const v = sourcesView([app('disabled'), gh()]);
    expect(v.github.map((c) => [c.source.name, c.use, c.why])).toEqual([['github', 'in-use', undefined], ['github-app', 'disabled', 'switched off in its settings']]);
    expect(v.summary).toBe('Issues are read through gh, as the logged-in GitHub user.');
  });

  it('both in use, or neither', () => {
    expect(sourcesView([gh(), app()]).summary).toBe('Issues are read through both gh and the GitHub App.');
    expect(sourcesView([gh('disabled'), app('ok', 'no GitHub App configured')]).summary).toBe('No GitHub connection is reading issues.');
    expect(sourcesView([]).summary).toBe('No GitHub connection is configured.');
  });

  it('other sources stay out of the GitHub section', () => {
    const other = source('linear', 'linear', 'ok');
    const v = sourcesView([other, gh()]);
    expect(v.github.map((c) => c.source.name)).toEqual(['github']);
    expect(v.others).toEqual([other]);
  });
});
