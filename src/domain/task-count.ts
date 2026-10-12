// A job's progress is its task count (issue #794): how many tasks of its task list are done, out of how many. The job
// writes it as a line of its own, `HOPPER_TASKS <done>/<total>`, each time a task completes. Never a clock.

/** Done of total tasks: 0 ≤ done ≤ total, total ≥ 1. */
export interface TaskCount {
  done: number;
  total: number;
}

const TASKS_LINE = /^[\s●⎿]*HOPPER_TASKS\s+(\d+)\s*\/\s*(\d+)\s*$/;

/** The task count of the last good `HOPPER_TASKS x/y` line in `text`; undefined when it has none. */
export function lastTaskCount(text: string): TaskCount | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TASKS_LINE.exec(lines[i]!);
    if (!m) continue;
    const done = Number(m[1]);
    const total = Number(m[2]);
    if (total >= 1 && done <= total) return { done, total };
  }
  return undefined;
}

/** True when `line` is a task count line, good or not: never a progress message. */
export const isTaskCountLine = (line: string): boolean => TASKS_LINE.test(line);

export const taskFraction = (t: TaskCount): number => t.done / t.total;

export const sameTaskCount = (a: TaskCount | undefined, b: TaskCount | undefined): boolean => a?.done === b?.done && a?.total === b?.total;
