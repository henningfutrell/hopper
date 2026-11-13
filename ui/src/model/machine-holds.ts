// The jobs a removal or rename of a machine waits for (issue #2932), as its Machines card says them. Each machine of
// GET /api/machines carries them as `holding`: a job on a lane there, waiting for an answer in a pane there, or on its own wait
// with its session there.
import type { JobStatus } from '../../../src/domain/types.ts';

/** Why the job holds the machine, in a person's words. */
export function holdText(status: JobStatus): string {
  if (status === 'waiting_on') return 'on its own wait, its session on this machine';
  if (status === 'waiting_answer') return 'waits for an answer in a pane here';
  return 'runs here';
}

/** What the card says above the list. */
export const holdsIntro = (count: number): string =>
  `A removal or rename waits for ${count === 1 ? 'this job' : `these ${count} jobs`}. Release the wait of a job on its own wait: it then resumes on another machine. Park or cancel the others on the job's page.`;
