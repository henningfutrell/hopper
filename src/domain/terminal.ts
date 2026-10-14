// The job's terminal at the executor port (issue #1128, design.md "The job's terminal"): what an executor whose jobs run
// in a pane gives a person — the pane's screen, and their input to it. Apart from ports.ts for its size.
import type { Job } from './types.ts';

export interface ExecutorTerminal {
  /**
   * The job's terminal (issue #1128): the text its pane shows now, its last `lines` lines with the scrollback, for a person
   * to view; undefined when the job holds no pane. Rejects when its machine cannot be reached. Absent → the job has none.
   */
  paneScreen?(job: Job, lines: number): Promise<string | undefined>;
  /**
   * A person's input to the job's terminal (issue #1128): `text` written to its pane as it is, or `keys` pressed (herdr's
   * key names). False: the job holds no pane. Rejects when its machine cannot be reached. Present exactly when `paneScreen` is.
   */
  typeInPane?(job: Job, input: { text: string } | { keys: string[] }): Promise<boolean>;
}
