// Job cost profiles in the UI (ui/src/model/job-costs.ts, issue #688), pure: a group's jobs and failures, the
// duration, one lane's share of CPU, memory and disk as average and peak, and the usage burned per usage window.
import { describe, expect, it } from 'vitest';
import { bytesText, cpuText, durationText, groupJobsText, usageText } from '../../ui/src/model/job-costs.ts';

const GIB = 1024 ** 3;

describe('job cost model', () => {
  it('the jobs of a group and how many failed', () => {
    expect(groupJobsText({ jobs: 1, failed: 0 })).toBe('1 job');
    expect(groupJobsText({ jobs: 3, failed: 1 })).toBe('3 jobs, 1 failed');
  });

  it('a duration in minutes, or hours and minutes', () => {
    expect(durationText(20_000)).toBe('under 1 min');
    expect(durationText(42 * 60_000)).toBe('42 min');
    expect(durationText(65 * 60_000)).toBe('1 h 5 min');
  });

  it('CPU, memory and disk as average and peak; a dash when not read', () => {
    expect(cpuText({ avg: 0.2, peak: 0.354 })).toBe('20% avg · 35% peak');
    expect(cpuText(undefined)).toBe('—');
    expect(bytesText({ avg: 2 * GIB, peak: 3.04 * GIB })).toBe('2.0 GiB avg · 3.0 GiB peak');
    expect(bytesText({ avg: 300 * 1024 ** 2, peak: 512 * 1024 ** 2 })).toBe('300 MiB avg · 512 MiB peak');
  });

  it('the usage burned per usage window, in percent of its limit', () => {
    expect(usageText({ session: 0.058, week: 0.004 })).toBe('session 5.8% · week 0.4%');
    expect(usageText({})).toBe('—');
  });
});
