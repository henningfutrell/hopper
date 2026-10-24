// Step schedules on Needs you (issue #2716): each schedule whose newest run did not succeed, one line each — how it ended,
// when and why —, until a run of it succeeds. Its runs and their output: `hopper schedule runs <name>`.
import type { StepSchedulesView } from '../../../src/domain/step-schedules.ts';

/** One line per schedule whose newest run failed or was interrupted; none when the view is not read yet, or has no schedules. */
export function failedScheduleLines(view: StepSchedulesView | undefined): string[] {
  const failed = view?.failed ?? [];
  return (view?.schedules ?? []).filter((s) => failed.includes(s.name) && s.lastRun).map((s) => {
    const r = s.lastRun!;
    const why = r.problem ?? `the script exited ${r.exit ?? '?'}`;
    return `${s.name}: ${r.outcome ?? 'failed'} at ${r.endedAt ?? r.startedAt}: ${why}. Its output: hopper schedule runs ${s.name}`;
  });
}
