// The Sources view's GitHub section (issue #160): the connected GitHub account (issue #214), gh and the
// GitHub App are three ways to one GitHub, and the view says which one reads issues, why the others
// are paused, and orders them so. Once GitHub is connected it is the one connection shown (issue #254):
// gh and gh login go, and the app-as-itself source shows only where an admin set one up.
import { describe, expect, it } from 'vitest';
import { sourcesView } from '../../ui/src/model/sources.ts';
import type { SourceStatus } from '../../ui/src/model/wire.ts';

const source = (name: string, kind: string, state: SourceStatus['state'], detail: Record<string, unknown> = {}): SourceStatus =>
  ({ name, kind, state, itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail });
const gh = (state: SourceStatus['state'] = 'ok', paused?: string) => source('github', 'github', state, { mode: 'gh', ...(paused ? { paused } : {}) });
const app = (state: SourceStatus['state'] = 'ok', paused?: string) => source('github-app', 'github-app', state, { mode: 'app', ...(paused ? { paused } : {}) });
const account = (kind: 'github-account', login?: string) => source(kind, kind, login ? 'ok' : 'disabled', {
  mode: 'account', ...(login ? { login } : { paused: 'GitHub is not connected: Sources → Connect GitHub' }),
});

describe('sourcesView', () => {
  it('a GitHub App in use comes first; gh is paused because of it', () => {
    const v = sourcesView([gh('ok', 'GitHub App configured'), app()]);
    expect(v.github.map((c) => [c.source.name, c.via, c.use])).toEqual([['github-app', 'app', 'in-use'], ['github', 'gh', 'paused']]);
    expect(v.github[1]!.why).toBe('the GitHub App is set up, so issues are read through it instead');
    expect(v.summary).toBe('Issues are read through the GitHub App, as its bot. gh is paused while the GitHub App is set up.');
  });

  it('a paused source with no active jobs reports state disabled; it is still paused, not disabled', () => {
    const v = sourcesView([gh('disabled', 'GitHub App configured'), app()]);
    expect(v.github.map((c) => [c.source.name, c.use])).toEqual([['github-app', 'in-use'], ['github', 'paused']]);
  });

  it('gh in use and no GitHub App set up: the app is not shown (#254)', () => {
    const v = sourcesView([app('ok', 'no GitHub App configured'), gh()]);
    expect(v.github.map((c) => [c.source.name, c.use])).toEqual([['github', 'in-use']]);
    expect(v.summary).toBe('Issues are read through gh, as the logged-in GitHub user.');
    expect(v.ghLogin).toBe(true);
  });

  it('a GitHub App set up but broken stays, saying why', () => {
    const v = sourcesView([app('ok', 'the private key does not parse'), gh()]);
    expect(v.github.map((c) => [c.source.name, c.use, c.why])).toEqual([['github', 'in-use', undefined], ['github-app', 'paused', 'the private key does not parse']]);
  });

  it('a disabled connection comes last and says it is switched off', () => {
    const v = sourcesView([app('disabled'), gh()]);
    expect(v.github.map((c) => [c.source.name, c.use, c.why])).toEqual([['github', 'in-use', undefined], ['github-app', 'disabled', 'switched off in its settings']]);
    expect(v.summary).toBe('Issues are read through gh, as the logged-in GitHub user.');
  });

  it('both in use, or neither', () => {
    expect(sourcesView([gh(), app()]).summary).toBe('Issues are read through both gh and the GitHub App.');
    expect(sourcesView([gh('disabled'), app('ok', 'no GitHub App configured')]).summary).toBe('No GitHub connection is reading issues.');
    expect(sourcesView([gh('disabled'), app('disabled')]).summary).toBe('No GitHub connection is reading issues.');
    expect(sourcesView([]).summary).toBe('No GitHub connection is configured.');
  });

  it('signed in with GitHub: the connection is the one piece; gh, gh login and an unset GitHub App are gone (#254)', () => {
    const acc = account('github-account', 'octo-user');
    const v = sourcesView([gh('disabled', 'GitHub account connected'), app('ok', 'no GitHub App configured'), acc]);
    expect(v.account).toBe(acc);
    expect(v.connected).toBe(true);
    expect(v.github).toEqual([]);
    expect(v.ghLogin).toBe(false);
    expect(v.others).toEqual([]);
    expect(v.summary).toBe('Issues are read, and jobs work, through your GitHub connection, octo-user.');
  });

  // A job source that cannot run is reported under its plugin's id (src/users/runtime.ts splitSources):
  // a gh source with invalid options is kind `github-gh`, not `github`. It is gh all the same.
  const brokenGh = () => source('github', 'github-gh', 'error');

  it('signed in with GitHub: a gh source that cannot run is gone too, its error with it (#320)', () => {
    const v = sourcesView([{ ...brokenGh(), lastError: 'invalid options for github-gh: authors: Invalid input: expected array, received undefined' }, account('github-account', 'octo-user')]);
    expect(v.connected).toBe(true);
    expect(v.github).toEqual([]);
    expect(v.others).toEqual([]);
  });

  it('not signed in with GitHub: a gh source that cannot run is the gh connection, not a card of its own (#320)', () => {
    const v = sourcesView([brokenGh(), account('github-account')]);
    expect(v.github.map((c) => [c.source.name, c.via])).toEqual([['github', 'gh']]);
    expect(v.others).toEqual([]);
  });

  it('signed in with GitHub and an admin set up their own GitHub App: it stays beside the connection (#254)', () => {
    const v = sourcesView([gh('disabled', 'GitHub account connected'), app(), account('github-account', 'octo-user')]);
    expect(v.github.map((c) => [c.source.name, c.via, c.use])).toEqual([['github-app', 'app', 'in-use']]);
    expect(v.summary).toBe('Issues are read, and jobs work, through your GitHub connection, octo-user. The GitHub App an admin set up also reads issues, as its bot.');
  });

  it('a GitHub account not connected says so, and how; its source is the connection panel, not a card (#214, #254)', () => {
    const v = sourcesView([account('github-account'), gh()]);
    expect(v.connected).toBe(false);
    expect(v.account?.name).toBe('github-account');
    expect(v.github.map((c) => [c.source.name, c.use, c.why])).toEqual([['github', 'in-use', undefined]]);
    expect(v.ghLogin).toBe(true);
    expect(v.summary).toBe('Issues are read through gh, as the logged-in GitHub user. Connect GitHub to read its issues instead.');
    expect(sourcesView([account('github-account')]).summary).toBe('No GitHub connection is reading issues: connect GitHub above.');
  });

  it('other sources stay out of the GitHub section', () => {
    const other = source('linear', 'linear', 'ok');
    const v = sourcesView([other, gh()]);
    expect(v.github.map((c) => c.source.name)).toEqual(['github']);
    expect(v.others).toEqual([other]);
  });
});
