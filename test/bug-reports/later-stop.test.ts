// Issue #694: the send pass of Report a bug stops only once its pass is over. A pass waits on GitHub; the user's
// runtime closes its store after the pass stops, so a pass that went on after that would write a closed database
// (the pull request check saw an uncaught error outside any test, as in #708).
//
// Feature: the send pass stops
//   Scenario: a pass in flight ends before stop does
//     Given the send pass started, its first pass waiting on GitHub to file a kept report
//     When the pass is stopped
//     Then stop has not ended while GitHub has not answered
//     And once GitHub answers, the report is filed and then stop ends
import { describe, expect, it } from 'vitest';
import type { BugReport, BugReportRepository } from '../../src/domain/bug-reports.ts';
import type { ReportGitHub } from '../../src/bug-reports/github.ts';
import { createReportSender } from '../../src/bug-reports/later.ts';

function memoryReports(): BugReportRepository {
  const rows = new Map<string, BugReport>();
  return {
    add: (input) => { const r = { ...input, id: `r${rows.size + 1}` }; rows.set(r.id, r); return r; },
    addOnce: (id, input) => { if (rows.has(id)) return undefined; const r = { ...input, id }; rows.set(id, r); return r; },
    get: (id) => rows.get(id),
    list: () => [...rows.values()].reverse(),
    inState: (state) => [...rows.values()].filter((r) => r.state === state),
    update: (id, patch) => { const r = { ...rows.get(id)!, ...patch }; rows.set(id, r); return r; },
    remove: (id) => { rows.delete(id); },
  };
}

describe('the send pass of Report a bug stops', () => {
  it('a pass in flight ends before stop does', async () => {
    const reports = memoryReports();
    const kept = reports.add({ createdAt: '2026-10-11T00:00:00.000Z', by: 'ada', title: 'The board hangs', state: 'waiting', kind: 'issue', body: 'It hangs.', tries: 0 });
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const github: ReportGitHub = {
      search: async () => [],
      create: async () => { await answered; return { number: 7, url: 'https://github.test/7' }; },
      comment: async () => ({ number: 7, url: 'https://github.test/7' }),
      state: async () => ({ state: 'open' as const }),
      find: async () => undefined,
    };
    const sender = createReportSender({ github: () => github, reports, now: () => '2026-10-11T00:00:01.000Z', record() {}, log() {}, enabled: () => true });
    sender.start();
    let stopped = false;
    const stop = sender.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    answer();
    await stop;
    expect(reports.get(kept.id)).toMatchObject({ state: 'open', number: 7 });
  });
});
