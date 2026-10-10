// Report a bug (issue #694): the context a report carries, built and masked before the person sees it — the hopper's
// version and revision, the install type, the system, the related job and its plain-language state, its last log lines
// — and the terms a duplicate search looks for.
import { describe, expect, it } from 'vitest';
import { maskAddresses } from '../../src/secrets/mask.ts';
import { reportBody, reportContext, searchTerms, similarityOf } from '../../src/bug-reports/index.ts';
import type { Job } from '../../src/domain/types.ts';

const SYSTEM = { platform: 'linux', release: '6.18.2', arch: 'x64', node: 'v24.3.0', hostname: 'archbox' };

const job = (over: Partial<Job> = {}): Job => ({
  id: 'job-1', spec: { executor: 'herdr-claude', payload: {} }, priority: 50, status: 'failed', approved: true, attempts: 1,
  createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...over,
} as Job);

describe('the report context', () => {
  it('names the version, revision, install type and system', () => {
    const text = reportContext({ install: { kind: 'image', branch: 'beta', commit: 'a'.repeat(40) }, system: SYSTEM });
    expect(text).toContain('Hopper: beta at aaaaaaaaaaaa');
    expect(text).toContain('Install: container');
    expect(text).toContain('System: linux 6.18.2 (x64), Node v24.3.0');
    expect(text).not.toContain('Job');
  });

  it('says a host install, and an unknown version plainly', () => {
    const text = reportContext({ install: { kind: 'install' }, system: SYSTEM });
    expect(text).toContain('Hopper: version not known');
    expect(text).toContain('Install: host');
  });

  it('names the job, its state in plain words, its failure and its last log lines', () => {
    const tail = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const text = reportContext({ install: { kind: 'install' }, system: SYSTEM, job: job({ error: 'agent exited 1', errorTail: tail }), failureId: 'fail-9' });
    expect(text).toContain('Job: job-1 (failed: it stopped with an error)');
    expect(text).toContain('Failure: fail-9');
    expect(text).toContain('Error: agent exited 1');
    expect(text).toContain('line 40');
    expect(text).toContain('line 21');
    expect(text).not.toContain('line 20\n');
  });

  it('never carries the job\'s item: its repository, title or issue text', () => {
    const text = reportContext({
      install: { kind: 'install' }, system: SYSTEM,
      job: job({ source: { source: 'github', kind: 'issue', key: 'https://github.com/acme/secret-repo/issues/4', repo: 'acme/secret-repo', number: 4, title: 'Private plans' } }),
    });
    expect(text).not.toContain('secret-repo');
    expect(text).not.toContain('Private plans');
  });

  it('masks tokens, keys, IP addresses, the host name and home directories', () => {
    const token = `ghu_${'A1b2'.repeat(9)}`;
    const key = 'f'.repeat(64);
    const text = reportContext({
      install: { kind: 'install' }, system: SYSTEM,
      job: job({ error: `push to 192.168.1.20 failed with ${token}`, errorTail: `archbox: key ${key}\nssh fe80::1ff:fe23:4567:890a\nopen /home/someone/work/x.ts` }),
    });
    for (const leak of [token, key, '192.168.1.20', 'archbox', 'fe80::1ff:fe23:4567:890a', 'someone']) expect(text).not.toContain(leak);
    expect(text).toContain('[IP address, masked]');
    expect(text).toContain('[host, masked]');
    expect(text).toContain('/home/[user, masked]/work/x.ts');
  });
});

describe('the address mask', () => {
  it('keeps times, versions and C++ names', () => {
    expect(maskAddresses('at 12:30:45, v1.2.3, std::vector')).toBe('at 12:30:45, v1.2.3, std::vector');
  });

  it('masks private host names', () => {
    expect(maskAddresses('reach build.lan and pi.local and box.tail1234.ts.net')).toBe('reach [host, masked] and [host, masked] and [host, masked]');
  });
});

describe('the report body', () => {
  it('has the person\'s sections and the hopper\'s note, tokens masked', () => {
    const token = `ghp_${'Z9y8'.repeat(9)}`;
    const body = reportBody({ happened: `It crashed. ${token}`, expected: 'It runs.', context: '- Install: host' });
    expect(body).toContain('### What happened\n\nIt crashed.');
    expect(body).toContain('### What I expected\n\nIt runs.');
    expect(body).toContain('### Context\n\n- Install: host');
    expect(body).toContain('Filed with Report a bug in a hopper.');
    expect(body).not.toContain(token);
  });

  it('leaves out an empty section', () => {
    expect(reportBody({ happened: 'It crashed.', expected: ' ', context: '' })).not.toContain('What I expected');
  });

  it('marks a job\'s report as the job\'s', () => {
    expect(reportBody({ happened: 'x', expected: '', context: '', fromJob: 'job-7' })).toContain('Filed by a job (job-7)');
  });
});

describe('the duplicate search', () => {
  it('looks for the title\'s words, not the small ones', () => {
    expect(searchTerms('The UI hangs when a job fails to start')).toEqual(['hangs', 'when', 'job', 'fails', 'start']);
  });

  it('rates a title by the share of the terms it has', () => {
    expect(similarityOf(['hangs', 'job', 'start'], 'Job start hangs forever')).toBe(1);
    expect(similarityOf(['hangs', 'job', 'start'], 'A job is slow')).toBeCloseTo(1 / 3);
  });
});
