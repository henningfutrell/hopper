// The draft constraints (issue #475, design.md "Draft constraints"): what an AI-drafted issue may hold, checked on the
// model's draft and again on the text the user edited before it is filed. Each detector finds its category and leaves
// the near misses alone; known names and held secrets are found by value and never shown; the model's mentions and
// labels are masked, and a size limit refuses, never cuts.
import { describe, expect, it } from 'vitest';
import {
  checkDraft, checkRequest, CONTEXT_MAX, maskDraft, maskContext, SUGGESTED_LABELS, TEXT_MAX, type DraftScope, type DraftStage,
} from '../../src/run-skills/constraints.ts';

const scope: DraftScope = {
  repos: ['acme/widgets'],
  known: ['quartz-box', 'Dana Example', 'dana-gh', 'x'],
  secrets: ['s3cr3t-value-that-is-held', 'short'],
};
const found = (body: string, stage: DraftStage = 'draft', title = 'Export fails') =>
  checkDraft({ repo: 'acme/widgets', title, body }, scope, stage).map((f) => f.constraint);

describe('the detectors: each category, and its near misses', () => {
  const cases: [string, string, string][] = [
    ['an email address', 'Write to someone@example.com', 'no-personal-data'],
    ['an IPv4 address', 'It listens on 192.168.1.20', 'no-personal-data'],
    ['an IPv6 address', 'It listens on fe80::1ff:fe23:4567:890a', 'no-personal-data'],
    ['a Linux home path', 'It fails in /home/someone/work', 'no-personal-data'],
    ['a macOS home path', 'It fails in /Users/someone/work', 'no-personal-data'],
    ['a private host name with a port', 'Open http://build.lan:8080/', 'no-personal-data'],
    ['a GitHub token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'no-secret'],
    ['an API key', 'key sk-abcdefghijklmnopqrstuvwxyz', 'no-secret'],
    ['a private key block', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', 'no-secret'],
    ['a 32-byte key', `key ${'ab'.repeat(32)}`, 'no-secret'],
  ];
  for (const [what, body, id] of cases) it(`finds ${what}`, () => expect(found(body)).toContain(id));

  const misses: [string, string][] = [
    ['a version string', 'It broke in v1.20.3 and 2.0.0-rc.1'],
    ['a time', 'It stopped at 12:30:45'],
    ['a code path', 'See `src/run-skills/constraints.ts:42`'],
    ['a public host name', 'Docs at https://docs.github.com/en/rest'],
    ['a digest', `Image sha256:${'ab'.repeat(32)}`],
    ['a word that holds a known name', 'The quartz-boxes table and xenon'],
  ];
  for (const [what, body] of misses) it(`leaves ${what} alone`, () => expect(found(body)).toEqual([]));
});

describe('known values: the user\'s names and the secrets the hopper holds', () => {
  it('a known machine name, account or person, as a word and in any case, is found', () => {
    expect(found('It runs on quartz-box')).toContain('no-known-name');
    expect(found('Ask DANA EXAMPLE')).toContain('no-known-name');
    expect(found('Pushed by dana-gh.')).toContain('no-known-name');
  });

  it('a held secret is found by value, and the finding does not show it', () => {
    const f = checkDraft({ repo: 'acme/widgets', title: 't', body: 'The value is s3cr3t-value-that-is-held' }, scope);
    expect(f.map((x) => x.constraint)).toContain('no-secret');
    expect(JSON.stringify(f)).not.toContain('s3cr3t');
  });

  it('a known name or secret too short to tell apart from ordinary text is no finding', () => {
    expect(found('x marks a short line')).toEqual([]);
  });

  it('mask masks them and counts each by its constraint', () => {
    const r = maskDraft({ repo: 'acme/widgets', title: 'quartz-box fails', body: 'Value s3cr3t-value-that-is-held on quartz-box' }, scope);
    expect(r.draft).toMatchObject({ title: '[name, masked] fails', body: 'Value [secret, masked] on [name, masked]' });
    expect(r.masks).toEqual(expect.arrayContaining([{ constraint: 'no-known-name', count: 2 }, { constraint: 'no-secret', count: 1 }]));
    expect(checkDraft(r.draft, scope)).toEqual([]);
  });
});

describe('the repository, the labels and the mentions', () => {
  it('a repository outside the scope is refused, at the draft and at filing', () => {
    for (const stage of ['draft', 'file'] as const) {
      expect(checkDraft({ repo: 'other/repo', title: 't', body: 'b' }, scope, stage).map((f) => f.constraint)).toContain('repo-allowed');
    }
    expect(checkDraft({ repo: 'ACME/Widgets', title: 't', body: 'b' }, scope).map((f) => f.constraint)).not.toContain('repo-allowed');
  });

  it('only the suggested labels are kept; a label the hopper acts on is dropped and named so', () => {
    const r = maskDraft({ repo: 'acme/widgets', title: 't', body: 'b', labels: ['hopper', 'hopper:high', 'bug', 'wontfix'] }, scope);
    expect(r.draft.labels).toEqual(['bug']);
    expect(r.masks).toEqual(expect.arrayContaining([{ constraint: 'no-hopper-label', count: 2 }, { constraint: 'label-allowed', count: 1 }]));
    expect(checkDraft({ repo: 'acme/widgets', title: 't', body: 'b', labels: ['wontfix'] }, scope, 'file').map((f) => f.constraint)).toContain('label-allowed');
    expect(SUGGESTED_LABELS.some((l) => l.startsWith('hopper'))).toBe(false);
  });

  it('the model\'s mentions are removed; one the user adds by hand is theirs to file', () => {
    const r = maskDraft({ repo: 'acme/widgets', title: 't', body: 'As @octocat said' }, scope);
    expect(r.draft.body).toBe('As [mention, removed] said');
    expect(found('As @octocat said', 'draft')).toContain('no-mention');
    expect(found('As @octocat said', 'file')).not.toContain('no-mention');
  });
});

describe('the text the user files is checked again', () => {
  it('a blocked value the user edits back in is refused at filing', () => {
    const r = maskDraft({ repo: 'acme/widgets', title: 't', body: 'mail someone@example.com from quartz-box' }, scope);
    expect(checkDraft(r.draft, scope, 'file')).toEqual([]);
    const edited = { ...r.draft, body: r.draft.body.replace('[email, masked]', 'someone@example.com').replace('[name, masked]', 'quartz-box') };
    expect(checkDraft(edited, scope, 'file').map((f) => f.constraint).sort()).toEqual(['no-known-name', 'no-personal-data']);
  });

  it('a title or body over its limit is refused, never cut', () => {
    const r = maskDraft({ repo: 'acme/widgets', title: 't'.repeat(121), body: 'b'.repeat(8001) }, scope);
    expect(r.draft.title).toHaveLength(121);
    expect(r.draft.body).toHaveLength(8001);
    expect(checkDraft(r.draft, scope, 'file').map((f) => f.constraint).sort()).toEqual(['body-size', 'title-size']);
  });
});

describe('the request and its context', () => {
  it('a text or a context over its limit is refused with the reason', () => {
    expect(checkRequest({ text: 'ok' })).toBeUndefined();
    expect(checkRequest({ text: ' ' })).toMatch(/say what/);
    expect(checkRequest({ text: 't'.repeat(TEXT_MAX + 1) })).toMatch(/text is longer/);
    expect(checkRequest({ text: 'ok', context: 'c'.repeat(CONTEXT_MAX + 1) })).toMatch(/context is longer/);
  });

  it('the context goes through the same masks, mentions kept, each change counted by constraint', () => {
    const r = maskContext('job j1 on quartz-box: ghp_abcdefghijklmnopqrstuvwxyz0123456789 from 10.0.0.7, by @octocat', scope);
    expect(r.text).not.toMatch(/quartz-box|ghp_abc|10\.0\.0\.7/);
    expect(r.text).toContain('@octocat');
    expect(Object.fromEntries(r.masks.map((x) => [x.constraint, x.count]))).toEqual({ 'no-known-name': 1, 'no-secret': 1, 'no-personal-data': 1 });
  });
});
