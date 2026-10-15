// Failover to signed-in machines (issue #1128 part 5, design.md "Failover to signed-in machines"): a machine whose agent
// tool reads signed out takes no new job of that tool's executors, so the job goes to a machine on another account, or is
// held with the reason. A job resuming returns to its pane: a sign-in from the hopper answers the question it waits on.
import type { Job, SignedOutTool, UsageSourceState } from '../domain/types.ts';

/** The signed-out tools of the usage sources: each whose account names its machine and reads signed out. Pure. */
export function signedOutOf(sources: readonly { name: string; state: UsageSourceState | undefined }[]): SignedOutTool[] {
  return sources.flatMap(({ name, state }) => {
    const a = state?.account;
    const machineId = a?.detail.machine;
    if (!a?.signedOut || typeof machineId !== 'string') return [];
    return [{ machineId, source: name, service: a.service, ...(state!.executors ? { executors: [...state!.executors] } : {}) }];
  });
}

/** Whether `t` keeps the jobs of `executor` off its machine. */
const keepsOff = (t: SignedOutTool, executor: string): boolean => t.executors === undefined || t.executors.includes(executor);

/** The signed-out tool that keeps `job` off `machineId` as a new job; undefined when none does, or the job resumes. */
export function signedOutFor(machineId: string, job: Job, tools: readonly SignedOutTool[] | undefined): SignedOutTool | undefined {
  if (job.pendingAnswer !== undefined) return undefined;
  return tools?.find((t) => t.machineId === machineId && keepsOff(t, job.spec.executor));
}

/** What the decider's reasons say of a signed-out tool on its machine. */
export const signedOutNote = (t: SignedOutTool): string =>
  `${t.machineId}: ${t.service} signed out (usage source ${t.source}): no new job of ${t.executors ? `executor ${t.executors.join(', ')}` : 'any executor'}`;

/** A signed-out tool that keeps every executor of the machine off it, so its lanes take no new job; undefined when one is free. */
export function signedOutEvery(machineId: string, executors: readonly string[], tools: readonly SignedOutTool[] | undefined): SignedOutTool | undefined {
  const mine = (tools ?? []).filter((t) => t.machineId === machineId);
  const all = mine.find((t) => t.executors === undefined);
  if (all) return all;
  return executors.length > 0 && executors.every((e) => mine.some((t) => keepsOff(t, e))) ? mine[0] : undefined;
}

/** What a hold or an idle machine tells the person to do. */
export const SIGN_IN = 'sign it in from Accounts';
