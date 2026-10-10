// A job's way to the hopper on its machine (issues #563, #652, design.md "GitHub through the hopper"): its proxy token
// and `hopper-gh` (with `hopper-skill` and `hopper-artifact`) kept as files in the job's credentials dir on its machine
// (`<scratch>/credentials`), through the machine's own connection — never typed into a pane —, and the variables that
// point there: the hopper's URL and git's way to GitHub through it. A job holds no GitHub token: the hopper acts on
// GitHub for it (issue #652; until then a job of a connected account held that account's token, kept and renewed here).
import type { JobProxyCredentials, MachineShell } from '../domain/ports.ts';
import type { Job, MachineSnapshot } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

/** The job's credentials dir under its scratch dir. */
export const credentialsDirOf = (scratch: string): string => `${scratch}/credentials`;

const pathsUnder = (dir: string, paths: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, `${dir}/${path}`]));

/**
 * The variables a job runs with: its proxy files kept under `scratch` on its machine first. `note` says why a job runs
 * without the GitHub proxy: its machine reaches no hopper URL, or its connection keeps no files.
 */
export async function placeCredentials(
  c: Pick<EngineContext, 'jobProxy'>, job: Job, machine: MachineSnapshot, shell: MachineShell | undefined, scratch: string, make: boolean,
  note: (line: string) => void,
): Promise<Record<string, string>> {
  const proxy: JobProxyCredentials | undefined = shell ? c.jobProxy(job, machine) : undefined;
  if (!proxy || !shell) return {};
  const dir = credentialsDirOf(scratch);
  try {
    for (const [file, content] of Object.entries(proxy.files)) await shell.keepCredential(job.id, dir, file, content, make);
  } catch (e) {
    note(`it runs without the hopper's GitHub proxy: ${(e as Error).message}`);
    return {};
  }
  return { ...pathsUnder(dir, proxy.paths), ...proxy.vars };
}
