// The hosts the jobs asked for wait on a person (issue #2849 part 3): the Job egress asks row of Needs you names each host with
// whose jobs it was refused to, and opens Settings → Job egress; the allowlist's text fields read and write its entries.
import { describe, expect, it } from 'vitest';
import { egressAskLines, hostsOf, isJobEgressView, reposOf, reposText, type JobEgressView } from '../../ui/src/model/job-egress.ts';
import { needsYouRows, type NeedsYouCounts } from '../../ui/src/model/needs-you.ts';

const none = { n: 0, high: 0 };
const counts = (egressAsks: string[]): NeedsYouCounts => ({ intake: 0, access: 0, plans: 0, signedOut: [], notReady: [], gaveUp: [], checksUnread: [], stuckLanding: [], tagged: 0, sorting: 0, egressAsks,
  sections: { questions: none, proposals: none, research: none, logins: none, failures: none, parked: none } });

describe('job egress asks on Needs you (issue #2849 part 3)', () => {
  it('one line per host the jobs asked for, with whose jobs', () => {
    const view: JobEgressView = {
      egress: { defaults: true, hosts: [], repos: {}, route: false, confine: false, scope: false, keep: [], repoKeep: {} }, defaultHosts: [],
      asks: [{ host: 'paste.example.com:443', repo: 'octo/tools', jobIds: ['a', 'b'], at: '2026-10-25T00:00:00Z' }, { host: 'data.example.net:443', jobIds: ['c'], at: '2026-10-24T00:00:00Z' }],
    };
    const lines = egressAskLines(view);
    expect(lines).toEqual([
      'paste.example.com:443: refused to 2 jobs of octo/tools — approve or dismiss it in Settings → Job egress',
      'data.example.net:443: refused to 1 job of no repository — approve or dismiss it in Settings → Job egress',
    ]);
    const row = needsYouRows(counts(lines)).find((r) => r.kind === 'egress')!;
    expect(row).toMatchObject({ label: 'Job egress asks', href: '#settings/job-egress', n: 2, details: lines });
    expect(needsYouRows(counts([])).find((r) => r.kind === 'egress')!.details).toBeUndefined();
    expect(egressAskLines(undefined)).toEqual([]);
    expect(isJobEgressView({})).toBe(false);
    expect(isJobEgressView(view)).toBe(true);
  });

  it('the text fields: a host a line, and a repository with its hosts a line', () => {
    expect(hostsOf(' a.example.com:443\n\nb.example.com:22, c.example.com:80 ')).toEqual(['a.example.com:443', 'b.example.com:22', 'c.example.com:80']);
    const repos = { 'octo/tools': ['a.example.com:443', 'b.example.com:443'], 'octo/site': ['c.example.com:443'] };
    expect(reposOf(reposText(repos))).toEqual(repos);
    expect(reposOf('octo/empty\nocto/x a.example.com:443\nocto/x b.example.com:443')).toEqual({ 'octo/x': ['a.example.com:443', 'b.example.com:443'] });
  });
});
