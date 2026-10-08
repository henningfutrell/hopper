// A job's credentials on its machine (issue #441, design.md "Keeping the connection"). GitHub invalidates
// the access token a renewal replaces, so a job handed a token once, at its start, lost GitHub at the next
// renewal. Its source's credential files are kept instead in the job's credentials dir on its machine
// (`<scratch>/credentials`), through the machine's own connection — never typed into a pane — and its
// variables point there; every renewal of the connection rewrites them for each job in flight. A machine
// whose connection takes no files runs the job with the token as it is at its start, said in its progress.
import type { Executor, JobCredentials, MachineShell } from '../domain/ports.ts';
import type { Job, JobStatus, MachineSnapshot } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

/** The jobs whose processes may be at work on their machine now: a queued job's files of an earlier run may be reaped. */
const AT_WORK: JobStatus[] = ['running', 'waiting_answer'];

/** The job's credentials dir under its scratch dir. */
export const credentialsDirOf = (scratch: string): string => `${scratch}/credentials`;

const keep = async (shell: MachineShell, job: Job, dir: string, creds: JobCredentials, make = false): Promise<void> => {
  for (const [file, content] of Object.entries(creds.files)) await shell.keepCredential(job.id, dir, file, content, make);
};

const same = (a: JobCredentials, b: JobCredentials | undefined): boolean => JSON.stringify(a.files) === JSON.stringify(b?.files);

/**
 * The variables a job runs with: its credential files kept under `scratch` on its machine first, and the
 * dir recorded on the job before they are written, so a renewal meanwhile finds it. Written again when a
 * renewal came between asking and writing. `note` says why a job runs with the token of its start.
 */
export async function placeCredentials(
  c: Pick<EngineContext, 'credentials' | 'store' | 'stopping'>, job: Job, shell: MachineShell | undefined, scratch: string, make: boolean, note: (line: string) => void,
): Promise<Record<string, string>> {
  let creds = await c.credentials(job);
  if (!creds) return {};
  if (Object.keys(creds.files).length === 0) return creds.env;
  const dir = credentialsDirOf(scratch);
  try {
    if (!shell) throw new Error('its machine\'s connection keeps no files');
    if (!c.stopping()) c.store.jobs.update(job.id, { credentialsDir: dir });
    for (let tries = 0; ; tries++) {
      await keep(shell, job, dir, creds, make);
      const now = await c.credentials(job);
      if (!now || same(creds, now) || tries === 2) break;
      creds = now;
    }
  } catch (e) {
    if (!c.stopping()) c.store.jobs.update(job.id, { credentialsDir: undefined });
    note(`its connection's token is the one of its start, not renewed while it runs: ${(e as Error).message}`);
    return creds.env;
  }
  return Object.fromEntries(Object.entries(creds.paths).map(([name, path]) => [name, `${dir}/${path}`]));
}

/**
 * After a renewal (issue #441): every job at work whose credential files are kept on its machine has
 * them rewritten with the token as it is now. A machine that cannot be reached now is logged; the job
 * keeps the files it has until the next renewal reaches it.
 */
export async function renewCredentials(c: Pick<EngineContext, 'credentials' | 'store' | 'executors' | 'machines'>, log: (line: string) => void): Promise<void> {
  const jobs = c.store.jobs.list({ status: AT_WORK }).filter((j) => j.credentialsDir !== undefined);
  if (jobs.length === 0) return;
  const lanes = c.store.lanes.list();
  const machines = await c.machines.list();
  const machineOf = (j: Job): MachineSnapshot | undefined => {
    const lane = lanes.find((l) => l.id === j.laneId);
    return lane ? machines.find((m) => m.id === lane.machineId) : undefined;
  };
  const shellOf = (j: Job): MachineShell | undefined => {
    const machine = machineOf(j);
    const executor: Executor | undefined = c.executors.get(j.spec.executor);
    return machine ? executor?.machineShell?.(machine) : undefined;
  };
  await Promise.all(jobs.map(async (j) => {
    try {
      const shell = shellOf(j);
      if (!shell) throw new Error('its machine is not attached, or its executor reaches it no more');
      const creds = await c.credentials(j);
      if (creds) await keep(shell, j, j.credentialsDir!, creds);
    } catch (e) {
      log(`hopper: job ${j.id}: its renewed token could not be kept on its machine: ${(e as Error).message}`);
    }
  }));
}
