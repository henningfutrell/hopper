// Issue #2849 part 1: a job's egress allowlist — the hopper's default hosts, the user's own hosts, and a repository's —,
// what an entry may be, and which host and port it allows.
import { describe, expect, it } from 'vitest';
import { JOB_EGRESS_DEFAULTS, jobEgressAllows, jobEgressAsks, jobEgressHostProblem, jobEgressList, NO_JOB_EGRESS, withJobEgressHost } from '../../src/domain/job-egress.ts';

describe('a job egress entry (issue #2849)', () => {
  it('is host:port, or *.domain:port for every name under a domain', () => {
    for (const ok of ['github.com:443', '*.githubusercontent.com:443', '10.0.0.7:8080', 'dev-box.internal:22']) expect(jobEgressHostProblem(ok)).toBeUndefined();
    for (const bad of ['github.com', 'https://github.com:443', '*:443', '*.com:443', 'git*.com:443', 'github.com:0', 'github.com:70000', 'a.*.com:443', '']) {
      expect(jobEgressHostProblem(bad)).toMatch(/is not host:port/);
    }
  });

  it('the defaults are valid entries, and cover the model providers, GitHub and the package registries', () => {
    for (const h of JOB_EGRESS_DEFAULTS) expect(jobEgressHostProblem(h)).toBeUndefined();
    for (const h of ['api.anthropic.com:443', 'api.openai.com:443', 'github.com:443', 'registry.npmjs.org:443', 'pypi.org:443']) expect(JOB_EGRESS_DEFAULTS).toContain(h);
  });
});

describe('a job\'s egress allowlist (issue #2849)', () => {
  const settings = { defaults: true, hosts: ['dev.example.com:8443'], repos: { 'octo/tools': ['staging.example.com:443'] }, route: false };

  it('holds the defaults, the user\'s hosts and its repository\'s hosts, matched in any case', () => {
    const list = jobEgressList(settings, 'Octo/Tools');
    expect(list).toEqual(expect.arrayContaining(['github.com:443', 'dev.example.com:8443', 'staging.example.com:443']));
    expect(jobEgressList(settings, 'octo/site')).not.toContain('staging.example.com:443');
    expect(jobEgressList(settings, undefined)).toContain('dev.example.com:8443');
  });

  it('drops the defaults when the user turned them off', () => {
    expect(jobEgressList({ ...settings, defaults: false }, 'octo/tools')).toEqual(['dev.example.com:8443', 'staging.example.com:443']);
    expect(jobEgressList(NO_JOB_EGRESS, undefined)).toEqual([...JOB_EGRESS_DEFAULTS]);
  });

  it('allows a listed host on its port only; a wildcard allows the names under its domain, not the domain', () => {
    const list = ['github.com:443', '*.githubusercontent.com:443', '10.0.0.7:8080'];
    expect(jobEgressAllows(list, 'GitHub.com.', 443)).toBe(true);
    expect(jobEgressAllows(list, 'github.com', 80)).toBe(false);
    expect(jobEgressAllows(list, 'raw.githubusercontent.com', 443)).toBe(true);
    expect(jobEgressAllows(list, 'githubusercontent.com', 443)).toBe(false);
    expect(jobEgressAllows(list, 'evilgithubusercontent.com', 443)).toBe(false);
    expect(jobEgressAllows(list, '10.0.0.7', 8080)).toBe(true);
    expect(jobEgressAllows(list, 'example.com', 443)).toBe(false);
  });
});

describe('the hosts jobs ask for (issue #2849 part 3)', () => {
  const denied = (jobId: string, at: string, host = 'paste.example.com', repo: string | null = 'octo/tools', reason = 'not_listed') =>
    ({ type: 'job.egress_denied', at, jobId, data: { host, port: 443, ...(repo ? { repo } : {}), reason } });
  const answered = (at: string, host = 'paste.example.com', repo: string | undefined = 'octo/tools') =>
    ({ type: 'job_egress.ask_answered', at, data: { by: 'Pat', host, port: 443, ...(repo ? { repo } : {}), answer: 'dismissed' } });

  it('one ask per host, port and repository, with its jobs, newest first', () => {
    const asks = jobEgressAsks(NO_JOB_EGRESS, [
      denied('j1', '2026-10-20T00:00:00Z'), denied('j2', '2026-10-21T00:00:00Z'), denied('j3', '2026-10-22T00:00:00Z', 'data.example.net', null),
      denied('j4', '2026-10-22T00:00:00Z', 'localhost', 'octo/tools', 'local_address'),
    ]);
    expect(asks).toEqual([
      { host: 'data.example.net:443', jobIds: ['j3'], at: '2026-10-22T00:00:00Z' },
      { host: 'paste.example.com:443', repo: 'octo/tools', jobIds: ['j1', 'j2'], at: '2026-10-21T00:00:00Z' },
    ]);
  });

  it('a host now on the list asks no more; a dismissed host asks again only after a later refusal', () => {
    const listed = withJobEgressHost(NO_JOB_EGRESS, 'Paste.Example.com:443', 'Octo/Tools');
    expect(listed.repos).toEqual({ 'octo/tools': ['paste.example.com:443'] });
    expect(jobEgressAsks(listed, [denied('j1', '2026-10-20T00:00:00Z')])).toEqual([]);
    expect(jobEgressAsks(NO_JOB_EGRESS, [denied('j1', '2026-10-20T00:00:00Z'), answered('2026-10-21T00:00:00Z')])).toEqual([]);
    expect(jobEgressAsks(NO_JOB_EGRESS, [denied('j1', '2026-10-20T00:00:00Z'), answered('2026-10-21T00:00:00Z'), denied('j2', '2026-10-22T00:00:00Z')]).map((a) => a.jobIds)).toEqual([['j2']]);
  });

  it('a host added for every job goes on the user\'s hosts', () => {
    expect(withJobEgressHost(NO_JOB_EGRESS, 'data.example.net:443', undefined)).toMatchObject({ hosts: ['data.example.net:443'], repos: {} });
  });
});
