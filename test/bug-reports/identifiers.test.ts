// Every report loses the obvious identifiers before it is posted (issue #2818): email addresses, links off the hopper's
// repository, absolute file paths, host names and long ids. What a report about the hopper names stays. Pure.
import { describe, expect, it } from 'vitest';
import { scrubIdentifiers } from '../../src/bug-reports/index.ts';

const scrub = (text: string, commits: string[] = []) => scrubIdentifiers(text, { commits: new Set(commits) });

describe('the identifier scrub', () => {
  it('removes email addresses', () => {
    expect(scrub('Ask jane.doe+ops@acme-corp.com about it.')).toEqual({ text: 'Ask [an email address] about it.', removed: ['email address'] });
  });

  it('removes links off the hopper\'s repository, and keeps the hopper\'s own', () => {
    const r = scrub('See https://grafana.acme.example/d/x, ftp://files.acme.io/a and https://github.com/henningfutrell/hopper/issues/2818.');
    expect(r).toEqual({ text: 'See [a link], [a link] and https://github.com/henningfutrell/hopper/issues/2818.', removed: ['link'] });
  });

  it('removes absolute paths, home paths and Windows paths, and keeps the hopper\'s routes and relative paths', () => {
    const r = scrub('It read /srv/acme/deploy/values.yaml:12, ~/notes.txt and C:\\Users\\jdoe\\app.log; POST /ui/api/bug-reports and src/bug-reports/service.ts are fine.');
    expect(r.text).toBe('It read [a file path], [a file path] and [a file path]; POST /ui/api/bug-reports and src/bug-reports/service.ts are fine.');
    expect(r.removed).toEqual(['file path']);
  });

  it('removes host names, and keeps github.com, code names, file names and versions', () => {
    const r = scrub('db01.prod.acme.com and build.internal timed out; github.com, job.queued, store.events, package.json, Node.js and v1.2.3 did not.');
    expect(r.text).toBe('[a host name] and [a host name] timed out; github.com, job.queued, store.events, package.json, Node.js and v1.2.3 did not.');
    expect(r.removed).toEqual(['host name']);
  });

  it('removes long ids: uuids, long numbers, long hex and long tokens, but not the hopper\'s own commits', () => {
    const own = '9393b4962aa0c5f8e1d2b3c4d5e6f708192a3b4c';
    const r = scrub(`Run 18234567890, job 89d05e6b-65de-4384-b729-a11bd4893517, key 0a1b2c3d4e5f60718293, id AbC123dEf456GhI789jKl0, commit ${own}, short abc1234.`, [own]);
    expect(r.text).toBe(`Run [an id], job [an id], key [an id], id [an id], commit ${own}, short abc1234.`);
    expect(r.removed).toEqual(['long id']);
  });

  it('keeps a plain report as it is', () => {
    const text = 'The board stops updating when a job fails at 12:30 on 2026-10-26.';
    expect(scrub(text)).toEqual({ text, removed: [] });
  });
});
