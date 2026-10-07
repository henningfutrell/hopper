// The Sources view's GitHub section (issues #160, #214, #254, #359): the connected GitHub account is the
// one way the hopper reads GitHub as the user; a GitHub App an admin set up is the one other connection.
// The view says which one reads issues, why the other is paused, and orders them so. An unset GitHub App
// is not shown.
import { describe, expect, it } from 'vitest';
import { sourcesView } from '../../ui/src/model/sources.ts';
import type { SourceStatus } from '../../ui/src/model/wire.ts';

const NOT_CONNECTED = 'GitHub is not connected: Sources → Connect GitHub';
const EXPIRED = "GitHub's sign-in expired: Sources → Connect GitHub again";

const source = (name: string, kind: string, state: SourceStatus['state'], detail: Record<string, unknown> = {}): SourceStatus =>
  ({ name, kind, state, itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail });
const app = (state: SourceStatus['state'] = 'ok', paused?: string) => source('github-app', 'github-app', state, { mode: 'app', ...(paused ? { paused } : {}) });
const account = (login?: string, paused = NOT_CONNECTED) => source('github-account', 'github-account', login ? 'ok' : 'disabled', {
  mode: 'account', ...(login ? { login } : { paused }),
});

describe('sourcesView', () => {
  it('signed in with GitHub: the connection reads issues; an unset GitHub App is not shown (#254)', () => {
    const acc = account('octo-user');
    const v = sourcesView([app('ok', 'no GitHub App configured'), acc]);
    expect(v.account).toBe(acc);
    expect(v.connected).toBe(true);
    expect(v.github).toEqual([]);
    expect(v.others).toEqual([]);
    expect(v.summary).toBe('Issues are read, and jobs work, through your GitHub connection, octo-user.');
  });

  it('an admin\'s own GitHub App stays beside the connection (#254)', () => {
    const v = sourcesView([app(), account('octo-user')]);
    expect(v.github.map((c) => [c.source.name, c.use])).toEqual([['github-app', 'in-use']]);
    expect(v.summary).toBe('Issues are read, and jobs work, through your GitHub connection, octo-user. The GitHub App an admin set up also reads issues, as its bot.');
  });

  it('not connected, or a sign-in expired: Sources says so and how to sign in again; nothing else reads issues as the user (#359)', () => {
    const v = sourcesView([account()]);
    expect(v.connected).toBe(false);
    expect(v.account?.name).toBe('github-account');
    expect(v.summary).toBe(`No issue is read through your GitHub connection: ${NOT_CONNECTED}.`);
    expect(sourcesView([account(undefined, EXPIRED)]).summary).toBe(`No issue is read through your GitHub connection: ${EXPIRED}.`);
  });

  it('the GitHub App in use while GitHub is not connected', () => {
    expect(sourcesView([app(), account()]).summary).toBe('Issues are read through the GitHub App, as its bot. Connect GitHub to read your own issues too.');
  });

  it('a GitHub App set up but broken stays, saying why; a disabled one says it is switched off', () => {
    expect(sourcesView([app('ok', 'the private key does not parse')]).github.map((c) => [c.use, c.why])).toEqual([['paused', 'the private key does not parse']]);
    expect(sourcesView([app('disabled')]).github.map((c) => [c.use, c.why])).toEqual([['disabled', 'switched off in its settings']]);
  });

  it('a paused source with no active jobs reports state disabled; it is still paused, not disabled', () => {
    expect(sourcesView([app('disabled', 'the private key does not parse')]).github.map((c) => c.use)).toEqual(['paused']);
  });

  it('no GitHub connection at all', () => {
    expect(sourcesView([]).summary).toBe('No GitHub connection is configured.');
  });

  it('other sources stay out of the GitHub section', () => {
    const other = source('linear', 'linear', 'ok');
    const v = sourcesView([other, app()]);
    expect(v.github.map((c) => c.source.name)).toEqual(['github-app']);
    expect(v.others).toEqual([other]);
  });
});
