// A job's way to the hopper on its machine (issues #563, #652, design.md "GitHub through the hopper"): its proxy token
// and `hopper-gh` (with `hopper-skill` and `hopper-artifact`) kept as files in the job's credentials dir on its machine
// (`<scratch>/credentials`), through the machine's own connection — never typed into a pane —, and the variables that
// point there: the hopper's URL and git's way to GitHub through it. A job holds no GitHub token: the hopper acts on
// GitHub for it (issue #652; until then a job of a connected account held that account's token, kept and renewed here).
// Before that, the machine checks that it reaches the hopper at that URL (issue #695): a job that cannot fails at once,
// saying why and what to do, never mid-job.
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
 * without the GitHub proxy: its machine reaches no hopper URL, or its connection keeps no files. Throws when the machine
 * cannot reach the hopper at the URL the job would be given (issue #695): `Unreached`, with the reason (job-run.ts `place`).
 */
export async function placeCredentials(
  c: Pick<EngineContext, 'jobProxy'>, job: Job, machine: MachineSnapshot, shell: MachineShell | undefined, scratch: string, make: boolean,
  note: (line: string) => void,
): Promise<Record<string, string>> {
  const proxy: JobProxyCredentials | undefined = shell ? c.jobProxy(job, machine) : undefined;
  if (!proxy || !shell) return {};
  const dir = credentialsDirOf(scratch);
  let unreached: string | undefined;
  try {
    unreached = await shell.reach(proxy.url);
    if (!unreached) for (const [file, content] of Object.entries(proxy.files)) await shell.keepCredential(job.id, dir, file, content, make);
  } catch (e) {
    note(`it runs without the hopper's GitHub proxy: ${(e as Error).message}`);
    return {};
  }
  if (unreached) throw new Unreached(`${unreached}. ${REACH_ACTION}`);
  return { ...pathsUnder(dir, proxy.paths), ...proxy.vars };
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
