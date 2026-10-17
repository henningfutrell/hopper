// Failover to signed-in machines (issue #1128 part 5, design.md "Failover to signed-in machines"): a machine whose agent
// tool reads signed out takes no new job of that tool's executors, so the job goes to a machine on another account, or is
// held with the reason. A job resuming returns to its pane: a sign-in from the hopper answers the question it waits on, or
// the signed-out move takes it to a signed-in machine (issue #1211, `signedOutMove`).
import type { Job, MachineSnapshot, SignedOutTool, UsageSourceState } from '../domain/types.ts';

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

/**
 * The signed-out tool that keeps `job` off `machineId` as a new job; undefined when none does, or the job resumes in its
 * pane. A job resuming elsewhere (issue #921) has no pane to return to: it is kept off as a new job is (issue #1211).
 */
export function signedOutFor(machineId: string, job: Job, tools: readonly SignedOutTool[] | undefined): SignedOutTool | undefined {
  if (job.pendingAnswer !== undefined && !job.parked?.elsewhere) return undefined;
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

/** A machine whose tool a usage source reads signed in as an identity (issue #1211). */
export interface SignedInTool { machineId: string; source: string; service: string; executors?: string[] }

/** The signed-in tools of the usage sources: each whose account names its machine and an identity, and is not signed out. Pure. */
export function signedInOf(sources: readonly { name: string; state: UsageSourceState | undefined }[]): SignedInTool[] {
  return sources.flatMap(({ name, state }) => {
    const a = state?.account;
    const machineId = a?.detail.machine;
    if (!a || a.signedOut || !a.identity || typeof machineId !== 'string') return [];
    return [{ machineId, source: name, service: a.service, ...(state!.executors ? { executors: [...state!.executors] } : {}) }];
  });
}

/** A signed-out move (issue #1211): the tool signed out on the job's machine, and the machines it can go on at. */
export interface SignedOutMove { tool: SignedOutTool; to: string[] }

/**
 * Whether a job held on a not-signed-in question on `from` moves (issue #1211, design.md "The signed-out move"): `from`'s
 * tool reads signed out for the job's executor, the job names no machine of its own, and another machine online that runs
 * its executor reads that tool signed in, and not signed out. Undefined: it stays and waits for a sign-in. Pure.
 */
export function signedOutMove(job: Job, from: string, machines: readonly MachineSnapshot[], out: readonly SignedOutTool[], signedIn: readonly SignedInTool[]): SignedOutMove | undefined {
  if (job.spec.machineId !== undefined) return undefined;
  const executor = job.spec.executor;
  const tool = out.find((t) => t.machineId === from && keepsOff(t, executor));
  if (!tool) return undefined;
  const to = machines.filter((m) => m.id !== from && m.online && m.executors.includes(executor)
    && !out.some((t) => t.machineId === m.id && keepsOff(t, executor))
    && signedIn.some((t) => t.machineId === m.id && t.service === tool.service && keepsOff(t, executor))).map((m) => m.id);
  return to.length ? { tool, to } : undefined;
}
