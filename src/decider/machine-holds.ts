// Whether a machine holds a job off (src/decider/assign.ts step 5): the holds a machine's own problems make, and their
// reasons. Pure.
import type { Job, MachineSnapshot } from '../domain/types.ts';

/**
 * A machine whose work tree cannot be made usable takes no new job (issue #361): the job waits for one
 * that can, never fails there. A job resuming there returns to the pane it holds.
 */
export const workTreeHolds = (m: MachineSnapshot, job: Job): boolean => m.workTreeProblem !== undefined && job.pendingAnswer === undefined;

/**
 * Whether `job` opens a new pane on the machine it is placed on (issue #2355): a new job, or one that resumes elsewhere from
 * its checkpoint (issue #921), which holds no pane there. Any other resuming job returns to the pane it holds.
 */
export const opensPane = (job: Job): boolean => job.pendingAnswer === undefined || job.parked?.elsewhere !== undefined;

/**
 * A machine whose jobs cannot reach the hopper takes no new job (issue #698): they would have no GitHub proxy and no
 * git. The job waits for a machine that reaches it, never fails there. A job resuming there returns to the pane it holds;
 * one that resumes elsewhere needs the hopper for its checkpoint (issue #2355), so it is held too.
 */
export const addressHolds = (m: MachineSnapshot, job: Job): boolean => m.addressProblem !== undefined && opensPane(job);

/**
 * A machine whose herdr client its herdr server does not take takes no new job (issue #741): every job start there
 * would fail. The job waits for a machine whose herdr works, never fails there. A job resuming there returns to the pane it holds.
 */
export const herdrHolds = (m: MachineSnapshot, job: Job): boolean => m.herdrProblem !== undefined && job.pendingAnswer === undefined;

/**
 * A machine whose job user holds credentials a job could use (issue #1248: a kube config, cloud CLI credentials, an ssh key,
 * a token variable) is not ready and takes no new job: a job holds no owner credentials (#652). The job waits for a ready
 * machine, never fails there; the machine takes jobs again once its probe finds none. A job resuming there returns to the pane it holds.
 * Only a machine the credential check holds (issue #1467, `credentialHeld` in src/domain/machine-credentials.ts): one an admin
 * stopped, or, with strict mode on, one no admin acknowledged. Else the credentials are a warning, and it takes jobs.
 */
export const credentialHolds = (m: MachineSnapshot, job: Job, held: boolean): boolean => held && (m.infraCredentials?.length ?? 0) > 0 && job.pendingAnswer === undefined;

/** Why such a machine holds a job (issue #1248): what its job user holds, and the fix. */
export const notReady = (m: MachineSnapshot): string =>
  `is not ready: its job user holds credentials a job could use (${m.infraCredentials!.join(', ')}). Run its jobs as a dedicated user that holds none`;

/** Why such a machine holds a job (issue #711): it is off-network, why, and the command that joins it when one fits. */
export const offNetwork = (m: MachineSnapshot): string => `is off-network: ${m.addressProblem}${m.addressFix ? `. Fix: ${m.addressFix}` : ''}`;

/**
 * The machines that run the job's executor but do not reach the hopper (issue #2427), said after a reason that names only
 * the others: a hold of every seat at once must not read as if the job only targeted the one machine left.
 */
export function heldOff(machines: readonly MachineSnapshot[], job: Job): string {
  const off = machines.filter((m) => m.online && m.executors.includes(job.spec.executor) && addressHolds(m, job));
  return off.length ? `; held off as not reaching the hopper: ${off.map((m) => `${m.id} ${offNetwork(m)}`).join('; ')}` : '';
}
