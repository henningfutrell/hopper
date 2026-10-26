// Report a bug (issue #694): the context a report carries, masked — the operating system and the hopper's version only
// (issue #2818) —, the report's fixed template, the mask of a report's text, and the terms a duplicate search looks for.
import { describe, expect, it } from 'vitest';
import { maskAddresses } from '../../src/secrets/mask.ts';
import { maskReportText, reportBody, reportContext, searchTerms, similarityOf } from '../../src/bug-reports/index.ts';

const SYSTEM = { platform: 'linux', release: '6.18.2', arch: 'x64', version: '0.42.1', hostname: 'archbox' };

describe('the report context', () => {
  it('is the operating system and the hopper\'s version and nothing else: no Node version, install type, job or failure (issue #2818)', () => {
    expect(reportContext(SYSTEM)).toBe('- OS: linux 6.18.2 (x64)\n- Hopper version: 0.42.1');
  });

  it('masks the host name, should the system name it', () => {
    expect(reportContext({ ...SYSTEM, release: '6.18.2-archbox' })).not.toContain('archbox');
  });
});

describe('the report mask', () => {
  it('masks tokens, keys, IP addresses, the host name and home directories', () => {
    const token = `ghu_${'A1b2'.repeat(9)}`;
    const key = 'f'.repeat(64);
    const text = maskReportText(`push to 192.168.1.20 failed with ${token}\narchbox: key ${key}\nssh fe80::1ff:fe23:4567:890a\nopen /home/someone/work/x.ts`, 'archbox');
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

  it('masks an IP address at the end of a sentence, and keeps a longer dotted number', () => {
    expect(maskAddresses('It failed at 10.20.30.40. Then 192.168.1.2.')).toBe('It failed at [IP address, masked]. Then [IP address, masked].');
    expect(maskAddresses('oid 1.3.6.1.4.1')).toBe('oid 1.3.6.1.4.1');
  });

  it('masks private host names', () => {
    expect(maskAddresses('reach build.lan and pi.local and box.tail1234.ts.net')).toBe('reach [host, masked] and [host, masked] and [host, masked]');
  });
});

describe('the report body', () => {
  it('is the fixed template: the description, the System section, the hopper\'s note; tokens masked (issue #2818)', () => {
    const token = `ghp_${'Z9y8'.repeat(9)}`;
    expect(reportBody({ description: ` It crashed. ${token} `, context: '' })).not.toContain(token);
    const body = reportBody({ description: ' It crashed. ', context: reportContext(SYSTEM) });
    expect(body).toBe('### Description\n\nIt crashed.\n\n### System\n\n- OS: linux 6.18.2 (x64)\n- Hopper version: 0.42.1\n\n---\nFiled with Report a bug in a hopper.');
  });

  it('marks a job\'s report as the job\'s, with no job id', () => {
    const body = reportBody({ description: 'x', context: '', fromJob: true });
    expect(body).toContain('Filed by a job with Report a bug in a hopper.');
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
