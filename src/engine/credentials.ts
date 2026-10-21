// A job's way to the hopper on its machine (issues #563, #652, design.md "GitHub through the hopper"): its proxy token
// and `hopper-gh` (with `hopper-skill` and `hopper-artifact`) kept as files in the job's credentials dir on its machine
// (`<scratch>/credentials`), through the machine's own connection — never typed into a pane —, and the variables that
// point there: the hopper's URL and git's way to GitHub through it. A job holds no GitHub token: the hopper acts on
// GitHub for it (issue #652; until then a job of a connected account held that account's token, kept and renewed here).
// Before that, the machine checks that it reaches the hopper at that URL (issue #695): a job that cannot fails at once,
// saying why and what to do, never mid-job. A job that ran there before (its agent session known) keeps the variables
// its start gave it when its files cannot be placed again (issue #2040): a turn never takes its way to the hopper away. A
// placement that fails is tried once more first, and a job that reopens after the end of its run reaped its credentials dir
// (a continued or a parked job, issue #2233) has no files left to keep: it fails, never resumed with no way to the hopper.
// A job that resumes elsewhere gets its checkpoint from the hopper (issue #2355): on a machine that gives it no way to the
// hopper (no URL its jobs reach the hopper at there, or no shell), it cannot go on there, and says why.
import type { JobProxyCredentials, MachineShell } from '../domain/ports.ts';
import type { Job, MachineSnapshot } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

/** What to do when a machine cannot reach the hopper (issue #695). */
export const REACH_ACTION = 'Set an address this machine reaches as the link base (Settings → Artifacts), or join the machine with Add machine: a client target\'s jobs reach the hopper through its client';

/** The machine cannot reach the hopper at the URL the job would be given (issue #695): why, and what to do. */
export class Unreached extends Error {}

/** The job's credentials dir under its scratch dir. */
export const credentialsDirOf = (scratch: string): string => `${scratch}/credentials`;

const pathsUnder = (dir: string, paths: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, `${dir}/${path}`]));

/**
 * The variables a job runs with: its proxy files kept under `scratch` on its machine first. `note` says why a job runs
 * without the GitHub proxy: its machine reaches no hopper URL, or its connection keeps no files — or, for a job that ran
 * there before, that it keeps the files its start placed (issue #2040). Throws when the machine
 * cannot reach the hopper at the URL the job would be given (issue #695), or gives a job that resumes elsewhere no way to
 * the hopper (issue #2355): `Unreached`, with the reason (job-run.ts `place`); and when a job that reopens after its
 * credentials dir was reaped cannot have its files placed again (issue #2233).
 */
export async function placeCredentials(
  c: Pick<EngineContext, 'jobProxy'>, job: Job, machine: MachineSnapshot, shell: MachineShell | undefined, scratch: string, make: boolean,
  note: (line: string) => void,
): Promise<Record<string, string>> {
  const proxy: JobProxyCredentials | undefined = shell ? c.jobProxy(job, machine) : undefined;
  if (!proxy || !shell) {
    if (!job.parked?.elsewhere) return {};
    throw new Unreached(`this machine cannot reach the hopper: ${shell ? 'the hopper has no URL its jobs reach it at' : 'the hopper has no shell'} on ${machine.id}, and the job needs it to restore its checkpoint. ${REACH_ACTION}`);
  }
  const dir = credentialsDirOf(scratch);
  const env = { ...pathsUnder(dir, proxy.paths), ...proxy.vars };
  const placed = async (): Promise<string | undefined> => {
    const unreached = await shell.reach(proxy.url);
    if (!unreached) for (const [file, content] of Object.entries(proxy.files)) await shell.keepCredential(job.id, dir, file, content, make);
    return unreached;
  };
  let unreached: string | undefined;
  try {
    // A connection that dropped for a moment (issue #2233): tried once more.
    unreached = await placed().catch(placed);
  } catch (e) {
    const why = (e as Error).message;
    if (job.agentSession === undefined) {
      note(`it runs without the hopper's GitHub proxy: ${why}`);
      return {};
    }
    if (job.continued || job.parked) throw new Error(`this machine cannot reach the hopper: its way to the hopper was not placed again for the resume (${why}): the end of its run removed the files its start placed`, { cause: e });
    note(`its files were not placed again (${why}): it keeps the hopper's GitHub proxy its start placed`);
    return env;
  }
  if (unreached) throw new Unreached(`${unreached}. ${REACH_ACTION}`);
  return env;
}

/**
 * The agent's sign-in a job on `machine` starts with (issue #1287, design.md "The agent's sign-in in a lane pod"): its
 * variable and value, or none. Throws with the vault's reason when it refuses: the job fails before its pane starts.
 */
export async function agentSignIn(c: Pick<EngineContext, 'agentSignIn'>, job: Job, machine: MachineSnapshot): Promise<Record<string, string>> {
  const r = await c.agentSignIn(job, machine);
  if ('refused' in r) throw new Error(`the agent credential: ${r.refused}`);
  return 'none' in r ? {} : { [r.variable]: r.value };
}
