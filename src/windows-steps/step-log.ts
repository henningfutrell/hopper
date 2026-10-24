// A Windows, need or box step's log as it is kept (issue #2690). Each chunk is appended to the database as it comes, from
// the handler of the stream that gave it: an append that throws there is uncaught, and ends the hopper. Once the
// database does not keep a chunk, the log ends there, it is said once, and the step's result says so: the step goes on.

/** The start of the problem of a step whose log the database did not keep whole. */
export const STEP_LOG_LOST = 'the hopper could not keep the step\'s log from here';

/** Appends each chunk with `append`; never throws. The first append that fails ends the log, and `said` gets why, once. */
export function keptLog(append: (chunk: string) => void, said: (why: string) => void): { write(chunk: string): void; lost(): string | undefined } {
  let lost: string | undefined;
  return {
    write(chunk) {
      if (lost !== undefined) return;
      try { append(chunk); } catch (e) { lost = (e as Error).message; said(lost); }
    },
    lost: () => lost,
  };
}

/** `result`, its problem saying that the log was lost, and why, when it was. */
export function withLostLog<T extends { problem?: string }>(result: T, lost: string | undefined): T {
  if (lost === undefined) return result;
  const problem = `${STEP_LOG_LOST}: ${lost}`;
  return { ...result, problem: result.problem ? `${result.problem}; ${problem}` : problem };
}
