// Report a bug's reports after filing (issue #694, design.md "Report a bug"): a report kept while GitHub could not take
// it is sent later, and Your reports reads each filed report's state on GitHub. One pass at start and every
// `REPORT_SEND_MS`; Refresh in Your reports runs one now. A kept report is looked for by its post key before it is sent
// (issue #1591): GitHub may have made it while its answer was lost. A report a stop left `sending` waits again at start.
// While the user's public bug reports are off (issue #2818) no kept report is sent; a job's report waiting for a person's
// approval is never sent by the pass.
import type { BugReport } from '../domain/bug-reports.ts';
import type { BugReportRepository } from '../domain/ports.ts';
import { postKeySince, withPostKey } from '../domain/post-key.ts';
import type { NewEvent } from '../domain/types.ts';
import { REPORT_LABEL, REPORT_REPO } from './context.ts';
import type { ReportGitHub } from './github.ts';

/** How often a user's kept reports are sent and their reports' states read: 10 minutes. */
export const REPORT_SEND_MS = 10 * 60_000;

/** One report on GitHub: a new issue, or a comment on the open report `number`; its text ends with its post key `key`. */
export const sendReport = (github: ReportGitHub, r: { key: string; kind: 'issue' | 'comment'; title: string; body: string; number?: number }): Promise<{ number: number; url: string }> => (r.kind === 'comment'
  ? github.comment(REPORT_REPO, r.number!, withPostKey(`**${r.title}**\n\n${r.body}`, r.key))
  : github.create(REPORT_REPO, { title: r.title, body: withPostKey(r.body, r.key), labels: [REPORT_LABEL] }));

/** A kept report as GitHub has it, found by its post key: GitHub made it, and the answer was lost (issue #1591). */
export const findReport = (github: ReportGitHub, r: BugReport): Promise<{ number: number; url: string } | undefined> =>
  github.find(REPORT_REPO, r.id, r.kind === 'comment' ? { kind: 'comment', number: r.number! } : { kind: 'issue' }, postKeySince(r.createdAt));

export interface ReportSender {
  /** Send the kept reports, then read the state of the filed ones; the reports after, newest first. */
  refresh(): Promise<BugReport[]>;
  start(): void;
  /** Ends the timer, then waits for a pass in flight: the user's runtime closes its store after this. */
  stop(): Promise<void>;
}

export function createReportSender(o: {
  github(): ReportGitHub | { problem: string };
  reports: BugReportRepository;
  now(): string;
  record(event: NewEvent): void;
  log(line: string): void;
  /** Whether the user's public bug reports are on (issue #2818); off, the kept reports wait. */
  enabled(): boolean;
  everyMs?: number;
}): ReportSender {
  /** One kept report sent now, or its problem kept for the next try. */
  async function sendKept(github: ReportGitHub | { problem: string }, r: BugReport): Promise<void> {
    const tried = { tries: r.tries + 1, checkedAt: o.now() };
    if ('problem' in github) { o.reports.update(r.id, { ...tried, problem: github.problem }); return; }
    try {
      const done = await findReport(github, r)
        ?? await sendReport(github, { key: r.id, kind: r.kind, title: r.title, body: r.body ?? '', ...(r.number !== undefined ? { number: r.number } : {}) });
      o.reports.update(r.id, { ...tried, state: 'open', number: done.number, url: done.url, body: undefined, problem: undefined });
      o.record({
        type: 'bug_report.filed', ...(r.jobId ? { jobId: r.jobId } : {}),
        data: { repo: REPORT_REPO, ...(r.jobId ? { jobId: r.jobId } : {}), by: r.by, ...(r.fromJob ? { fromJob: true } : {}), kind: r.kind, number: done.number, url: done.url, id: r.id, later: true },
      });
    } catch (e) {
      o.reports.update(r.id, { ...tried, problem: (e as Error).message });
    }
  }
  let running: Promise<BugReport[]> | undefined;
  async function pass(): Promise<BugReport[]> {
    const github = o.github();
    if (o.enabled()) for (const r of o.reports.inState('waiting')) await sendKept(github, r);
    if (!('problem' in github)) {
      // Closed ones too: an issue can be opened again.
      for (const r of [...o.reports.inState('open'), ...o.reports.inState('closed')]) {
        if (r.number === undefined) continue;
        try {
          const read = await github.state(REPORT_REPO, r.number);
          // Opened again: no longer closed, so not fixed either (issue #1147).
          o.reports.update(r.id, { state: read.state, closedAt: read.state === 'closed' ? read.closedAt : undefined, closedAs: read.state === 'closed' ? read.closedAs : undefined, checkedAt: o.now() });
        } catch (e) {
          o.log(`hopper: Report a bug: the state of #${r.number} could not be read: ${(e as Error).message}`);
        }
      }
    }
    return o.reports.list();
  }
  // One pass at a time: a report is never sent twice by two passes at once.
  const refresh = (): Promise<BugReport[]> => (running ??= pass().finally(() => { running = undefined; }));
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    refresh,
    start() {
      // A report a stop left on its way waits again: the pass looks for its post key before it sends it.
      for (const r of o.reports.inState('sending')) o.reports.update(r.id, { state: 'waiting', problem: 'the hopper stopped while it sent this report' });
      const run = () => { refresh().catch((e: unknown) => { o.log(`hopper: Report a bug: the send pass failed: ${(e as Error).message}`); }); };
      run();
      timer ??= setInterval(run, o.everyMs ?? REPORT_SEND_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
}
